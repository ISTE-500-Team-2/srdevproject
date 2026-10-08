# Reader authorization and relay adapter

Existing physical PN532 firmware and receipt receiver are preserved. This module adds the application-facing piece, not a claim of installed hardware.

`AccessClient` signs the exact JSON body plus a fresh millisecond timestamp and UUID, uses HTTPS and a 1.8-second timeout, checks response reader/event identity, and caps authorization at both the absolute expiry and five seconds. Keep each reader's secret in a protected service configuration, never a command-line argument.

`RelayLease` accepts a verified `set_relay(allowed)` callback. It starts off, bounds each lease, and switches off on timeout/denial/expiry/close. `RenewingAccessSession` records the first scan once and revalidates every second without duplicating check-ins. A denied/revoked/offline session stops; a new card scan must create a fresh session. Only the adapter should translate allowed/denied into actual electrical polarity.

Integration example, after physically verifying the callback and using protected configuration:

```python
client = AccessClient(base_url, configured_reader_id, reader_secret)
relay = RelayLease(verified_hardware_callback)
session = RenewingAccessSession(client, relay, observed_card_uid)
try:
    if session.start():
        wait_for_machine_session_end()
finally:
    session.close()
```

A standalone Pi service must connect the real UART/USB/Wi-Fi scan transport to this adapter and serialize sessions per physical resource. It must not replay a previously granted response. Verify GPIO, LEDs, safe relay behavior and a hardware watchdog/interlock for process or host failure before actual actuation. Do not expose an unauthenticated scan endpoint or assume a GPIO pin from sample code.

Tests: `python3 -m unittest discover -s deploy/reader -v`. These use simulated callbacks only; no GPIO, card reader or production endpoint is touched.
