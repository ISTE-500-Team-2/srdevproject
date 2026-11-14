#!/usr/bin/env python3
"""Review factory power/control source structure and exact verified-header reuse."""
from pathlib import Path
import hashlib
import json

SKETCH = Path(__file__).resolve().parents[1]
FIRMWARE = SKETCH.parent
report = json.loads((FIRMWARE / "tests/verification-results.json").read_text())
for name in ("pn7160_nci.h", "pn7160_arduino.h", "integrated_power.h"):
    actual = (SKETCH / name).read_bytes()
    product = (FIRMWARE / "product_integrated_pn7160_v03" / name).read_bytes()
    assert actual == product, "Factory/product header differs: " + name
    assert hashlib.sha256(actual).hexdigest() == report["inputs_sha256"]["firmware/product_integrated_pn7160_v03/" + name]
print("PASS 3 factory headers exactly match independently tested product sources")
contracts = FIRMWARE / "tests/run_product_contract_tests.py"
scope = {"__file__": str(contracts), "__name__": "factory_lexical_helper"}
exec(compile(contracts.read_text().split("\nsource = SKETCH.read_text()", 1)[0], str(contracts), "exec"), scope)
function = scope["function"]
source = (SKETCH / "factory_test_pn7160_v03.ino").read_text()
setup = function(source, "setup")
monitor = function(source, "monitorPower")
initialize = function(source, "initializeReader")
service = function(source, "enterService")
apply = function(source, "applyLeds")
led = function(source, "setLedMode")
loop = function(source, "loop")
poll = function(source, "pollTags")
low = "digitalWrite(integrated::kPnResetPin, LOW)"
high = "digitalWrite(integrated::kPnResetPin, HIGH)"
assert setup.index(low) < setup.index("pinMode(integrated::kPnResetPin, OUTPUT)")
assert "setCpuFrequencyMhz(80)" in setup and "WiFi.mode(WIFI_OFF)" in setup
assert low in monitor and "esp_wifi_stop()" in monitor and "Mutex" not in monitor
assert "kMonitorIntervalMs" in monitor and '"usb-power", 4096, nullptr, 3' in setup
assert low in service and "WiFi.mode(WIFI_OFF)" in service and "ledMode = Auto" in service
assert initialize.index(low) < initialize.index("waitQualified(10)") < initialize.index(high)
assert initialize.index(high) < initialize.index("waitQualified(1000)") < initialize.index("reader.begin")
assert "reader.model() != 0x61" in initialize
assert loop.index("initializeReader()") < loop.index("startAp()")
assert "apStarted && readerReady && allowsNfc()" in poll
assert apply.index("if (!fullPower())") < apply.index("mode == All")
assert led.index("if (!fullPower())") < led.index("ledMode = All") and "server.send(503" in led
assert 'server.on("/api/load", HTTP_GET' in source and "body.reserve(4096)" in source
load = source.split('server.on("/api/load", HTTP_GET', 1)[1].split('server.on("/health"', 1)[0]
gate = "if (!fullPower() || ledMode != All)"
assert load.count(gate) == 2 and load.index(gate) < load.index("body.reserve(4096)")
assert load.rindex(gate) > load.index("body +=") and load.rindex(gate) < load.index('server.send(200')
assert 'server.on("/api/led", HTTP_POST' in source
assert "!ARDUINO_USB_CDC_ON_BOOT" in source and "UART0 RX must not claim GPIO20" in source
assert not any(call in source for call in (".writeBlock(", ".writePage(", ".authenticate(", "Preferences", '"/api/write"'))
print("PASS factory source guards: active-HIGH VEN, default service, qualification/downgrade/recovery, LED power gate, bounded load gated twice by power+All mode, native CDC and read-only NFC")
print("NOTE source review and host mocks do not execute GPIO/FreeRTOS/HTTP/Wi-Fi or establish physical shutdown latency")
