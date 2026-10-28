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

## Reader setup and tap enrollment

Apply `027_reader_enrollment.sql` through the normal migration command before rolling out this version. Keep the existing `ACCESS_CARD_HASH_KEY` unchanged: it fingerprints NFC cards and encrypts stored reader credentials. A deployment with just this key can add its first reader in **Reader access → Readers**. `ACCESS_READERS_JSON` is optional; existing entries are imported once per ID, retaining their credentials. Later admin renames and disabled states take precedence over the environment. Removing an environment entry does not delete its reader: disable it in the admin screen.

The admin screen creates a reader ID and a one-time secret. Install both in the reader's protected service configuration. Names and enabled state can then be changed without a server redeploy. A disabled reader returns a denial on its next request, including lease renewals.

Call `client.status()` every 15 seconds while idle. It is a signed heartbeat, returns `mode` (`access`, `enroll`, or `disabled`) and an optional enrollment expiry, and never grants a relay lease. Display the enrollment indicator when mode is `enroll`; a failed heartbeat must not restore a previous access grant. A reader is shown online only if an authenticated heartbeat or decision arrived within the last 45 seconds. The adapter/service owns this scheduling, just as it owns the physical scan loop.

To enroll, staff choose a member and reader and start a two-minute scan session. The next **physical** tap is captured, access remains denied, and staff explicitly confirm the card and member. Changing member or leaving the workflow cancels the session when the request can reach the server; its server expiry remains the fallback. Lookup uses the same scan mode and shows current and previous assignments without assigning a card. While an assignment awaits confirmation, other taps cannot overwrite it or activate the resource.

Updated clients send `renewal: false` for a physical tap and `renewal: true` for lease renewal. `RenewingAccessSession` does this automatically. Legacy signed decisions continue working; only legacy `checkIn: true` calls can capture an enrollment, so old idle/renewal traffic cannot enroll a card. Upgrade the adapter for reliable heartbeat status and separation of physical tap history from renewals.

Raw NFC IDs are not stored. Events and assignments keep a keyed fingerprint plus the final four hexadecimal characters; older assignments show no suffix until replaced/reissued. Revoked assignments remain in history, and only one active assignment may own a fingerprint. Restoring the previous application code is possible with the additive reader tables left in place, but reintroducing the old all-history unique constraint requires resolving reissued-card history first; do not reverse this migration on populated data.
