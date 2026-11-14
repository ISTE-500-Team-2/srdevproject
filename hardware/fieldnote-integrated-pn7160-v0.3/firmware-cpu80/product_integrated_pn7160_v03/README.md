# Fieldnote PN7160 v0.3 product firmware

This separate sketch ports the frozen integrated v0.2 product to **PN7160A1HN/C100E** and ESP32-C3-MINI-1-N4X. It builds an original NCI 2.0 driver. No PN532 source, frozen board or existing product credentials are changed. **Compiled software and mock tests do not establish physical tag or RF parity; no board has been flashed.** See `../product-build-manifest.json` for the final reproducible build and verification record.

The web page, `/api/status`, `/api/write`, `/health`, `nfc-reader.local`, validated Wi-Fi persistence and native USB provisioner remain. The status JSON retains the historical `pn532` object for existing consumers; its `chip` is explicitly `PN7160`, and transport/address/IRQ/VEN diagnostics report this board. The visible UI labels PN7160. `scan.activation_retries=0` is a legacy field; this driver uses bounded host discovery rather than PN532 RFConfiguration retries.

Tag writes still need confirmation, the same recent writable UID and a fresh RF selection. Classic default Key A authentication uses PN7160 hardware Crypto1, and blocks 4–6 retain the 48-byte NFCWEB01 record and CRC. Type 2 pages 4–15 retain short text/HTTP(S) URL NDEF, the 36 UTF-8 byte limit, empty-first-page commit sequence, full read-back and attempted verified rollback. The driver itself rejects accesses outside these safe blocks/pages. Classic writes require both command and data-stage four-bit ACKs. New RF activation/deactivation during an operation invalidates the reader session rather than moving writes or rollback onto a different tag; only fresh selection can establish a new session. A failed session requests one immediate reset/reinit; failed bring-up then uses the usual 30-second retry. A power cut/removal may prevent rollback; failed writes require inspecting the tag before retrying.

| Function | ESP32 GPIO / setting |
|---|---|
| I2C SDA/SCL | 4/5, 100 kHz, 30 ms bus timeout, 258-byte Wire buffers |
| PN7160 address | 0x28 seven-bit; both address straps GND |
| VEN | 7 active HIGH; LOW during service/reset |
| IRQ | 20 active HIGH; A005=00, WUP_REQ disabled |
| USB_LIMITED | 6 input; HIGH service, LOW ≥1.5 A advertisement |
| Green/amber/red | 1/3/10 active HIGH |
| Native USB D−/D+ | 18/19; CDC-on build required |

**GPIO20 is IRQ, so UART0 RX must not be enabled.** The sketch rejects CDC-off builds. The production strap configuration is R27 fitted (NFC_IRQ→GPIO20), R28 DNP (UART RX disconnected). ROM UART service requires depopulating R27 and fitting R28; normal NFC firmware will not operate in that service configuration. Native USB requires no strap change.

The priority-3 USB supervisor is preserved: CPU 80 MHz, radio off and VEN LOW in default-current service; require 100 ms continuous qualification; monitor every 10 ms independently of NFC mutex/HTTP/provisioning. First VEN/capacitor charge and NCI initialization finish before Wi-Fi starts; RF polling waits until enrollment/network startup. This reduces deliberate startup overlap and does not establish an inrush bound. Later reader retries can still occur over active Wi-Fi. Falling qualification asserts VEN LOW and stops the IDF radio; loop cleanup closes network services and invalidates tag state. Hardware USB100 limiting is independent. Transition brownout remains allowed and needs bench qualification; the task period is not a measured stop latency.

Bring-up uses RESET(KEEP EEPROM), NCI2 INIT, read-modify/write-if-changed configuration and a second RESET/INIT only if values changed. A003 selects the 27.12 MHz crystal and clears bit4, which is reserved in selected C100E firmware12.50.05. A00E selects **CFG2 without external DC/DC, 3.3 V internal TXLDO** for qualified USB with approximately 4.4 V on VBAT/VDDUP. Its ON-mode clock source explicitly follows A003 instead of external RF. It disables the unsuitable 3.6/5 V VUP checks and preserves other fields. DPC configuration is explicitly read from A00B (87 bytes), with only byte0 enable bits E0 cleared; the complete LUT and other fields are preserved. Full clock, PMU and DPC readbacks must match the requested settings after any required reset. Failed configuration/readback blocks RF discovery. The NDK NX2016SA-27.12MHZ-EXS00A-CS06346 crystal and provisional RF passives are hardware choices, not validated RF calibration. This firmware does not apply the OM27160 demonstration antenna's RF_CONF. **Battery-only full operation is not enabled by this USB profile; future battery use requires a lower-voltage-aware TXLDO policy and hardware qualification.**

Receive reads wait for active IRQ, consume the three-byte header, then read payload immediately without requiring a second IRQ. Writes drain pending notifications first and only retry full I2C frames on address/data NACK, at most three attempts. Split short reads, ambiguous bus errors, unexpected reset, invalid packets and bounded response/credit timeouts force reader recovery. The driver dispatches credits, RF activation/deactivation and resets rather than treating the first packet as the requested data. It tracks IDLE/discovery/active RF phases and skips RF_DEACTIVATE when already IDLE; active-session stopping requires its notification. DATA credit piggybacking is supported; malformed reserved bits and fragmented packets fail closed. The current product exchanges fit one packet, so multi-packet reassembly is intentionally not an exposed feature.

Build using ESP32 Arduino **3.3.12** and ArduinoJson **7.4.3**:

```sh
python3 tools/embed_web.py --check
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc --export-binaries .
node tools/test_admin_ui.cjs
c++ -std=c++11 -Wall -Wextra -Werror tools/test_power_qualification.cpp -o /tmp/fieldnote-pn7160-power-test
/tmp/fieldnote-pn7160-power-test
c++ -std=c++11 -Wall -Wextra -Werror -Itools/stubs tools/test_wire_transport.cpp -o /tmp/fieldnote-pn7160-wire-test
/tmp/fieldnote-pn7160-wire-test
c++ -std=c++11 -Wall -Wextra -Werror tools/test_tag_policy.cpp -o /tmp/fieldnote-pn7160-tag-policy-test
/tmp/fieldnote-pn7160-tag-policy-test
```

Run the independent protocol/record suite in `../tests/` as documented there. Program only the actual enumerated native USB port. First enrollment needs a data-capable fixture/host advertising at least 1.5 A at 5 V; default-current hosts stay in service and do not print `READY_FOR_WIFI`. `python3 provision.py --port <port> --ssid <network>` prompts privately for the password. Credentials are stored only after successful connection, with the same namespace/record as v0.2.

Expected C100E controller firmware is **12.50.05**, reported from CORE_RESET_NTF manufacturer bytes. Model ID must be 0x61 before the product marks the reader ready. Factory verification must check the actual part and reported firmware. Later C101E/firmware revisions have different advertised NFC modes; no upgrade is performed automatically. The application implements Classic/Type 2 reading and writing, not phone-to-PCB emulation, P2P or a BLE service. Preserving unused PN532 silicon capabilities requires separate mode-level validation.

Physical release gates include both USB orientations and source advertisements, boot/programming, read/write/rollback on genuine Classic and Type 2 media, phone-read NDEF, in-case read/write range, all-LED/Wi-Fi/NFC concurrency, current/ripple/thermal, downgrade/replug and missing/stuck-reader recovery. Follow the variant's manufacturing factory procedure before ordering further units or enabling battery operation.
