# Integrated v0.2 product firmware

**Compiled; not flashed or physically validated.** This separate sketch adapts the current Fieldnote product source to the integrated PCB and ESP32-C3-MINI-1-N4X. The original `firmware/esp32_nfc_web` working tree remains unchanged. `../product-source-baseline.json` records the exact original files copied; this is a board-specific snapshot, not an automatically synchronized replacement for that source.

The product UI, `/api/status`, `/api/write`, `/health`, hostname `nfc-reader`, validated Wi-Fi persistence record and tag formats are retained. Writes still need explicit confirmation, the same recent writable UID, fresh UID reselection and read-back verification. Classic uses blocks 4–6; Type 2 uses pages 4–15; the 36-byte limit and protected-memory boundary remain unchanged. No account, credential or tag-data migration is performed.

| Function | ESP32 GPIO |
| --- | --- |
| I²C SDA / SCL | 4 / 5, 100 kHz |
| USB_LIMITED input | 6; HIGH = default/unattached, LOW = 1.5 A/3 A advertisement |
| PN532 reset/power-down | 7; LOW in service, HIGH after qualified cold startup |
| Green / amber / red LED | 1 / 3 / 10, active HIGH |
| Native USB D− / D+ | 18 / 19 |

At startup the CPU is set to 80 MHz, Wi-Fi stays off, PN532 is held in reset, and amber indicates service mode. A priority-3 supervisor samples qualification every 10 ms and requires 100 ms continuously sampled LOW before full operation. Stored Wi-Fi connection or serial enrollment begins only while qualified; PN532 starts after enrollment, an explicit reset and 1-second cold-start interval. Green means an available polling reader; red means reader failure. GPIO6 is never driven by firmware.

On qualification loss, the supervisor asserts GPIO7 LOW, disables NFC availability and requests the IDF radio to stop independently of HTTP, serial waits and the NFC mutex. The loop closes server/mDNS, turns the Arduino Wi-Fi mode off and invalidates tag state. Read/write phases recheck power. The hardware independently restores USB100 immediately; a brownout restart during downgrade is allowed. The nominal 10 ms task period is not measured stop latency. A power interruption during a write can leave partial tag data and prevent rollback: read the tag before retrying.

Install ESP32 Arduino **3.3.12**, Adafruit PN532 **1.3.4**, Adafruit BusIO **1.17.4** and ArduinoJson **7.4.3**. Build from this directory:

```sh
python3 tools/embed_web.py --check
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc --export-binaries .
```

Program through native USB using the actual enumerated port. Programming/service can use a default-current source. **First Wi-Fi enrollment requires a data-capable host/fixture that also advertises at least 1.5 A at 5 V**; an ordinary default-current host will remain in service mode and will not print `READY_FOR_WIFI`. Once qualified, use the copied provisioner:

```sh
python3 provision.py --port <actual-enumerated-port> --ssid <test-network>
```

The provisioner prompts privately for the password. Credentials are persisted only after successful network connection. They survive ordinary resets and qualification changes. The product uses the enrolled LAN and reported IP/`http://nfc-reader.local/`; the factory test AP is a separate diagnostic firmware.

Build results and all SHA-256 values are in `../product-build-manifest.json`. Application and bootloader both identify ESP-IDF **5.5.5**, with the shared v0.3 minimum/v1.99 maximum SDK profile supporting N4/v0.4 and N4X/v1.1. Physical default-current consumption, radio stop latency, boot/USB behavior, Wi-Fi/NFC concurrency, tag writes and rollback require the [manufacturing factory procedure](../../manufacturing/factory-test.md), including its product addendum.

Focused checks:

```sh
node tools/test_admin_ui.cjs
python3 tools/embed_web.py --check
c++ -std=c++11 -Wall -Wextra -Werror tools/test_power_qualification.cpp -o /tmp/fieldnote-power-test
/tmp/fieldnote-power-test
```

This change is scoped to the new product copy, its build artifacts and compatibility/test documents. No original product source or native CAD is modified, and no board is flashed by the build.
