# Guided reader setup

## Administrator flow

1. Plug a compatible reader into the Orange Pi using a USB data cable. The Reader access page shows a new-reader notice; **Add reader** lists devices reported by the Pi.
2. Select a device, enter its name, choose the building/room/machine, and provide Wi-Fi details. Select **Use saved Wi-Fi** only when its saved connection already works. Network advertisements appear as hints but require USB to complete first-time pairing.
3. **Connect reader** starts a server-tracked job: private recovery backup → Wi-Fi → unique device pairing → NFC/server verification. Close and reopen to resume viewing progress. No manual reader ID, credential copying, terminal or firmware source editing is part of this flow.
4. The reader becomes enabled only after the newly generated backend credential has authenticated a fresh heartbeat and the bound gateway has verified a fresh, HMAC-authenticated poll with the PN532 ready. Then test a physical card; all existing membership, reservation, training and waiver rules still apply.

The dialog uses the existing Modal, management form, buttons, badges, fonts and colors. Manual registration remains under **Advanced manual setup**, for operator-managed legacy installations.

## Discovery and trust

The hosted website cannot scan the administrator's LAN. An unprivileged Pi agent reports stable USB hardware fingerprints and local mDNS `_http._tcp` advertisements from compatible `nfc-reader` devices. Network probes are read-only, bounded, non-redirecting and restricted to the Pi's attached IPv4 subnets. Advertisements alone never establish device ownership or receive credentials. The USB identity is hashed; raw USB serial numbers and card UIDs are not sent in discovery reports.

`POST /api/devices/setup/poll` uses a **dedicated host credential**, not a member session or an existing access-reader secret. Each request signs the exact timestamp/newline/body and has a 15-second clock window. A transactionally locked, strictly increasing signed timestamp and fresh report ID reject captured-frame replays without accumulating a per-heartbeat receipt table. Client timestamps remain monotonic across same-millisecond requests; ordinary restart uses the current synchronized clock. A backward clock jump fails closed until time synchronization recovers.

Only staff with `user_access:update` and valid CSRF may start/cancel jobs. Reader IDs and independent 32-byte backend/link secrets are generated automatically. Browser responses and audit records contain no signing secret or Wi-Fi password. Wi-Fi job data is encrypted at rest, delivered only to its authenticated Pi over HTTPS, and cleared on completion, cancellation, failure or when expiry is processed by a poll/status read. Jobs expire after 20 minutes; disconnected devices cannot start setup. Provisional/failed attempts stay disabled and are hidden from the normal reader list while their history remains available in setup/audit records.

The TLS listener supports independent HMAC/backend identities per device. Profile activation preserves replay counters; a stale status from a previous pairing cannot verify the new key. Lost acceptance replies retain the paired profile rather than incorrectly rolling back a committed setup. Recovery and retries on the same USB device execute in order, while another device has an independent worker.

## Supported hardware and recovery

Initial USB provisioning supports the retained **ESP32-C3 1.7.1-c3-checkin** profile: PN532 SDA0/SCL1, LEDs R7/Y6/G5 and the existing compiled HTTPS gateway/trust anchor. Unknown firmware/board layouts are rejected before credentials are written. This is not a factory-blank flashing wizard, an enterprise Wi-Fi/EAP provisioner or an arbitrary TLS-host migration tool. Existing classic ESP32 readers/services remain untouched.

Before provisioning, the Pi saves a private full-flash backup and verifies its partition checksum, C3 image identity and original NVS layout. Firmware, bootloader, partition table and eFuses are never rewritten. Failed/cancelled provisioning removes the new gateway profile and restores **only original NVS**, using the stable USB by-id identity and checked flash verification. A disconnected board can prevent recovery; the UI then explicitly reports that settings need recovery, rather than claiming success. Keep private backups; never publish them or include them in archives/PRs. Backup/restore subprocess output is private too.

The current retained firmware accepts new Wi-Fi details only when its saved connection fails. It cannot silently change a working network: choose **Use saved Wi-Fi**, or have an operator change that network separately. No fake card, lease, enrollment or entitlement is created during setup verification.

## One-time operator installation (not a normal administrator task)

Do not auto-deploy this over a running installation without its reviewed schema/host rollout.

1. Back up/rehearse and apply `029_reader_guided_setup.sql` through the existing owner migration process. Grant only the existing runtime role's necessary `SELECT,INSERT,UPDATE,DELETE` privileges on the three new `app_reader_setup_*` tables. The migration is additive; old readers/cards/bookings/policies are not rewritten. Identity/job changes are audited; routine liveness/counter updates do not flood the audit log.
2. Privately generate a dedicated host key. Configure the application with `ACCESS_SETUP_GATEWAYS_JSON` containing `{id,name,secret}` and store the matching secret in the Pi's owner-only `gateway_secret_file`. This host trust bootstrap happens once; **per-reader** keys are then automatic and never copied by staff.
3. Install `setup-requirements.txt` in an isolated Pi virtual environment. Copy the reviewed `deploy/reader` sources, existing TLS certificate/key and a private configuration based on `setup-host.example.json`. Do not change the firmware trust anchor or move a legacy profile to a different backend implicitly.
4. Run `install_setup.py --config /path/to/private-host.json` to validate without changing services. After review, run with `--apply` using the prepared virtual environment. It authenticates against the deployed application before switching listeners, adopts a matching legacy C3 profile, installs user services and preserves the prior service state for recovery. No sudo, root service or authorization popup is used. The already-working classic reader service is not edited/restarted.
5. Verify both user services, live discovery and an actual setup/card tap. The application rollout alone does **not** install the Pi agent.

User services are `arbor-reader-network.service` and `arbor-reader-setup.service`; the existing Pi user manager must already start at boot. If service activation fails, the installer stops the new units and restores the old C3 service's enabled/active state. For a deliberate host rollback, use `installation-before.json` to restore that state, retain backups/profiles for recovery and leave the classic reader service alone.

## Verification boundaries

Automated coverage includes real React → Express → PostgreSQL setup, dedicated gateway auth/CSRF/replays, concurrent starts, secret/privacy checks, new-reader heartbeat/PN532 gates, cancellation/expiry/staff revision changes, independent device keys/replays, stale pairing proof, lost acceptance replies, NVS-only rollback and per-device recovery ordering. Tests simulate the USB/Wi-Fi provisioning side; they do not imply a physical card was presented.

The owner-connected C3 was detected on the actual Pi and the new backup helper read and verified all 4,194,304 flash bytes with a valid C3/NVS layout, without writing settings. A real network/credential provisioning job and physical card acceptance remain deployment checks; no production migration, reader creation, Wi-Fi/key change or service cutover was performed while preparing this PR.
