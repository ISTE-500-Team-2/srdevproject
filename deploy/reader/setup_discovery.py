"""Pi-owned discovery. Network advertisements are hints, never pairing proof."""
import hashlib
import ipaddress
import json
import subprocess
import threading
import time
import urllib.request


def lan_networks():
    try:
        interfaces = json.loads(subprocess.check_output(['ip', '-j', 'address'], timeout=2))
        return [ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False)
                for interface in interfaces for a in interface.get('addr_info', [])
                if a.get('family') == 'inet' and a.get('scope') == 'global']
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


class NetworkDiscovery:
    def __init__(self):
        self.lock = threading.Lock()
        self.services = {}
        self.zc = self.browser = None

    def start(self):
        try:
            from zeroconf import ServiceBrowser, Zeroconf, IPVersion
            self.zc = Zeroconf(ip_version=IPVersion.V4Only)
            self.browser = ServiceBrowser(self.zc, '_http._tcp.local.', self)
        except (ImportError, OSError):
            pass  # USB remains available; do not fabricate network results.

    def add_service(self, zc, kind, name):
        if 'nfc-reader' not in name.lower():
            return
        info = zc.get_service_info(kind, name, timeout=800)
        if info is None or info.port != 80:
            return
        networks = lan_networks()
        addresses = [a for a in info.parsed_addresses() if any(ipaddress.ip_address(a) in n for n in networks)]
        if addresses:
            with self.lock:
                self.services[name] = (addresses[0], time.monotonic())

    update_service = add_service

    def remove_service(self, _zc, _kind, name):
        with self.lock:
            self.services.pop(name, None)

    def devices(self, known_ips=()):
        with self.lock:
            services = list(self.services.items())[:16]
        networks = lan_networks()
        found = []
        for name, (address, seen) in services:
            if address in known_ips:
                continue
            if not any(ipaddress.ip_address(address) in n for n in networks):
                continue
            try:
                # Read-only, bounded metadata probe. No keys, card operations,
                # user-selected URL, redirect or off-LAN destination is accepted.
                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *args): return None
                opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
                with opener.open(f'http://{address}/api/status', timeout=.6) as response:
                    raw = response.read(16385)
                if len(raw) > 16384: continue
                status = json.loads(raw)
                version, chip = status.get('version', ''), status.get('system', {}).get('chip', '')
                if not version.startswith(('1.6.', '1.7.')) or not chip.startswith('ESP32'):
                    continue
                identity = hashlib.sha256(('mdns:' + name + ':' + address).encode()).hexdigest()[:24]
                found.append({'id': 'net-' + identity, 'model': chip + ' network reader', 'firmware': version, 'transport': 'network'})
            except (OSError, ValueError, TypeError):
                continue
        return found

    def close(self):
        if self.browser: self.browser.cancel()
        if self.zc: self.zc.close()
