"""USB onboarding for verified Fieldnote C3 firmware. Never invent an access grant.

All backups and process output stay private on the Pi. No firmware image,
bootloader or partition table is written; failed provisioning restores only the
validated original NVS partition. The USB by-id identity is retained throughout.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time

import serial
from serial.tools import list_ports


class SetupError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)  # Fixed codes only; never SSID/password/serial lines.


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    with temp.open('w') as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle)
    temp.replace(path)


def usb_devices():
    result = {}
    aliases = list(Path('/dev/serial/by-id').glob('*'))
    for port in list_ports.comports():
        if port.vid != 0x303a or not port.serial_number:
            continue
        alias = next((p for p in aliases if os.path.realpath(p) == os.path.realpath(port.device)), None)
        if not alias:
            continue  # Do not provision through an unstable ttyACM number.
        identity = hashlib.sha256(f'{port.vid}:{port.pid}:{port.serial_number}'.encode()).hexdigest()[:24]
        result['usb-' + identity] = {'path': str(alias), 'id': 'usb-' + identity,
                                    'model': 'Espressif USB reader', 'transport': 'usb'}
    return result


def validated_nvs(data):
    if len(data) not in (4*1024*1024, 8*1024*1024):
        raise SetupError('backup_failed')
    table = data[0x8000:0x9000]
    found = []
    checksum = False
    for offset in range(0, 0x1000, 32):
        entry = table[offset:offset+32]
        magic, = struct.unpack_from('<H', entry)
        if magic == 0xebeb:
            checksum = hashlib.md5(table[:offset]).digest() == entry[16:32]
            break
        if magic != 0x50aa:
            raise SetupError('backup_failed')
        _, kind, subtype, start, size, label, _ = struct.unpack('<HBBII16sI', entry)
        if start + size > len(data):
            raise SetupError('backup_failed')
        if kind == 1 and subtype == 2 and label.rstrip(b'\0') == b'nvs':
            found.append((start, size))
    if not checksum or len(found) != 1 or found[0] != (0x9000, 0x5000):
        raise SetupError('backup_failed')
    # The retained supported C3 profile has app0 here. No arbitrary-board writes.
    if data[0x10000] != 0xe9 or struct.unpack_from('<H', data, 0x10000+12)[0] != 5:
        raise SetupError('unsupported_firmware')
    return found[0]


class USBProvisioner:
    def __init__(self, device, directory, cancelled, stage):
        self.path, self.root = device['path'], Path(directory)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.cancelled, self.stage = cancelled, stage
        self.changed = False
        self.nvs = None
        self.port = None

    def check(self):
        if self.cancelled.is_set():
            raise SetupError('cancelled')
        if not Path(self.path).exists():
            raise SetupError('disconnected')

    def open(self):
        end = time.monotonic() + 10
        while not Path(self.path).exists() and time.monotonic() < end:
            if self.cancelled.is_set():
                raise SetupError('cancelled')
            time.sleep(.2)
        self.check()
        port = serial.Serial()
        port.port, port.baudrate, port.timeout = self.path, 115200, .25
        port.dtr = port.rts = False
        port.open()
        self.port = port
        return port

    def reset(self):
        # Native USB can re-enumerate. Reopen the SAME by-id identity afterward.
        from esptool.reset import HardReset
        port = self.open()
        try:
            HardReset(port, uses_usb=True)()
        finally:
            port.close()

    def esptool(self, arguments, label):
        self.check()
        with (self.root / (label + '.private.log')).open('wb') as output:
            os.chmod(output.name, 0o600)
            try:
                subprocess.run([sys.executable, '-m', 'esptool', '--chip', 'esp32c3',
                    '--port', self.path, '--baud', '460800', '--before', 'usb_reset',
                    '--after', 'hard_reset', *arguments], stdout=output, stderr=subprocess.STDOUT,
                    timeout=600 if label=='backup' else 60, check=True)
            except (subprocess.SubprocessError, OSError) as error:
                # A failed ROM read must not strand the original app in loader mode.
                try:
                    from esptool.reset import HardReset
                    port=serial.Serial();port.port=self.path;port.baudrate=115200;port.timeout=.25
                    port.dtr=port.rts=False;port.open()
                    try:HardReset(port,uses_usb=True)()
                    finally:port.close()
                except (serial.SerialException,OSError):
                    pass
                raise SetupError('backup_failed' if label == 'backup' else 'verification_failed') from error

    def backup(self):
        self.stage('backing_up')
        destination = self.root / 'full-flash-before.private.bin'
        if destination.exists():
            # A retained recovery copy is immutable, never overwrite it on retry.
            proof = json.loads((self.root / 'backup-proof.json').read_text())
            data = destination.read_bytes()
            if hashlib.sha256(data).hexdigest() != proof['sha256']:
                raise SetupError('backup_failed')
        else:
            self.esptool(['read_flash', '0', 'ALL', str(destination)], 'backup')
            destination.chmod(0o600)
            data = destination.read_bytes()
            self.nvs = validated_nvs(data)
            private_json(self.root / 'backup-proof.json', {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        self.nvs = validated_nvs(data)
        offset, size = self.nvs
        (self.root / 'original-nvs.private.bin').write_bytes(data[offset:offset+size])
        (self.root / 'original-nvs.private.bin').chmod(0o600)

    def read_boot(self, port, timeout=45):
        deadline = time.monotonic() + timeout
        state = {'version': None, 'chip': None, 'ip': None, 'pn532': False, 'readyForWifi': False}
        while time.monotonic() < deadline:
            if self.cancelled.is_set():
                raise SetupError('cancelled')
            try:
                line = port.readline().decode('utf-8', errors='replace').strip()
            except (serial.SerialException, OSError):
                port.close()
                time.sleep(.5)
                try:
                    port = self.open()
                except (serial.SerialException, OSError):
                    continue
                continue
            match = re.fullmatch(r'FIELDNOTE version=(\S+) chip=(\S+) sda=(\d+) scl=(\d+)', line)
            if match:
                state.update(version=match[1], chip=match[2])
                if not state['version'].startswith('1.7.1-c3-') or state['chip'] != 'ESP32-C3' or match.groups()[2:] != ('0', '1'):
                    raise SetupError('unsupported_firmware')
            elif line.startswith('IP='):
                from ipaddress import ip_address
                try:
                    state['ip'] = str(ip_address(line[3:]))
                except ValueError:
                    raise SetupError('verification_failed')
            elif line.startswith('PN532_READY '):
                state['pn532'] = True
            elif line == 'READY_FOR_WIFI':
                state['readyForWifi'] = True
                return port, state
            elif line == 'NFC_WEB_READY':
                return port, state
            elif line.startswith('WIFI_FAILED '):
                state['wifiFailed'] = True
        raise SetupError('wifi_failed')

    def configure(self, ssid, password, link_key, reuse_saved=False):
        port = None
        try:
            # Positively identify supported application firmware before entering ROM.
            self.reset()
            port, initial = self.read_boot(self.open())
            port.close()
            if initial['chip'] != 'ESP32-C3' or initial['version'] is None:
                raise SetupError('unsupported_firmware')
            self.backup()
            self.check()
            # esptool's checked backup resets into the existing application.
            port = self.open()
            port, state = self.read_boot(port)
            if state['version'] is None:
                # A missed startup marker must not authorize a write to unknown firmware.
                raise SetupError('unsupported_firmware')
            self.stage('connecting')
            if state['readyForWifi']:
                if reuse_saved or not ssid:
                    raise SetupError('wifi_failed')
                self.check()
                self.changed = True
                port.write((ssid + '\n' + password + '\n').encode())
                port.flush()
                port, connected = self.read_boot(port)
                state.update({k: v for k, v in connected.items() if v is not None})
                if connected['readyForWifi'] or not connected['ip']:
                    raise SetupError('wifi_failed')
            elif not reuse_saved:
                # Never silently ignore a requested network change.
                raise SetupError('wifi_already_connected')
            if not state['ip'] or not state['pn532']:
                raise SetupError('verification_failed')
            self.stage('pairing')
            self.check()
            self.changed = True
            port.write((json.dumps({'type': 'provision_controller_key', 'key': link_key}) + '\n').encode())
            port.flush()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                self.check()
                try:
                    value = json.loads(port.readline())
                except (ValueError, UnicodeDecodeError):
                    continue
                if value.get('type') == 'controller_key_configured' and value.get('configured') is True:
                    return {'ip': state['ip'], 'firmware': state['version'], 'readerReady': state['pn532']}
            raise SetupError('pairing_failed')
        finally:
            if self.port is not None:
                self.port.close()

    def rollback(self):
        if not self.changed:
            return
        if not self.nvs:
            raise SetupError('verification_failed')
        # Cancellation blocks new work, but must not prevent restoring our changes.
        was_cancelled = self.cancelled.is_set()
        self.cancelled.clear()
        try:
            self.esptool(['write_flash', '--flash_size', 'keep', '--flash_mode', 'keep', '--flash_freq', 'keep',
                          hex(self.nvs[0]), str(self.root / 'original-nvs.private.bin')], 'restore-nvs')
        finally:
            if was_cancelled:
                self.cancelled.set()
