# NFC acceptance evidence

Raw verification JSON files named below are retained separately by the project team; this repository contains the reviewable test summary, not credentials or private reader dumps.

## Scope

Isolated RLES demo backend; reader `arbor-pi-01-test`; equipment3 (3D Printer). No schema changes, production deployment, business-user changes or physical machine actuation. Existing PN532 SDA0/SCL1 and LED G5/Y6/R7 wiring unchanged.

## Completed

- Direct ESP32 HTTPS/HMAC communication from home to campus, with verified TLS and Mac tunnel disabled; Pi18081 listener absent. Pi user service is enabled and orangepi lingering enabled/read-back verified, so service lifecycle does not require an SSH login. `direct-link-proof.json` records connection checks.
- Gateway1.7.1 requests actual check-in and preserves/validates member ID, name, email, membership/day-pass flags. Those fields are returned in the signed reader reply and a private0600 proof file, not general status. Previously the gateway discarded identity and requested `checkIn:false`. No backend release was needed.
- Three-account signed API matrix: active member5 → ELIGIBLE, correct name/email and one approved check-in (event26); expired member6 → ENTITLEMENT_REQUIRED, no check-in (event27); inactive/suspended membership member7 → ENTITLEMENT_REQUIRED, no check-in (event28). These are synthetic API requests, not physical presentations. `acceptance-matrix-proof.json`.
- Actual idle gateway interruption → issue/yellow and greenGPIO off; restart → ready/red. Persistent-session shutdown fixed and retested; stop completed in0.81seconds. `direct-outage-proof.json`.
- Actual Pi-to-backend route interruption: only the test gateway route temporarily pointed to a refused localhost port. Reader reported backend unavailable, green off; exact original route restored and ready/red recovered. `backend-outage-proof.json`.
- Software-controlled full USB power cycle: verified Espressif303a:1001 on Apple front hub2-1 port1; off3seconds/on. PN532 recovered on its first initialization; yellow/green-off while clock/network started, then direct ready/red. No manual unplug, wire changes or SSD-port operation. `usb-power-cycle-proof.json`.
- 40 Python tests pass, including identity preservation/rejection, replay/error/expired lease handling. Native C++ LED tests cover wrong-scan, timeout, active-grant fault invalidation and mutually exclusive colors.
- Firmware1.7.1-c3-checkin compiled/flashed with hash verification and original NVS/partition layout preserved. LED task no longer performs USB logging; bounded open-drain I2C recovery added after a failed initialization.

- **Real direct identity/check-in passed:** sessione2c94b64 scan4, event32/request362bda52-319c-482e-811c-4759cbb47702, check-in5. Correct test name/email and actual greenGPIO5, then locked/red. `identity-checkin-proof.json`.
- **Real expired membership passed:** same card, scan8/event36, ENTITLEMENT_REQUIRED; red flashes, no green and no added check-in. `physical-expired-proof.json`.
- **Real inactive membership passed:** same card, scan9/event37, ENTITLEMENT_REQUIRED; red flashes, no green and no added check-in. `physical-inactive-proof.json`. Original member5 membership dates/status restored and read back; `acceptance-restore-proof.json`.

- **Actual active-grant connection failure passed:** physical scan10 showed green, Pi gateway was paused, green did not persist beyond its bounded lease, yellow indicated the fault, and resume recovered ready/red without restoring old green. `active-grant-fault-proof.json`.

- **Final firmware host-only reset regression passed:** three consecutive real ESP32 USB reset trials produced fresh signed boot sessions, PN532 ready, network recovery and locked/red with green off. No manual unplug or Mac authorization controller. See `reader-reboot-trial-1.json`, `reader-reboot-trial-2.json`, `reader-reboot-trial-3.json`, `reboot-regression-results.json`.

## Remaining physical integration

- Physical equipment switching: no relay is connected. SDTA-134 remains open; see [LED relay prototype](NFC-LED-PROTOTYPE.md).

## Earlier fault and recovery boundary

Firmware1.7.0 host-only reset testing exposed a PN532 SCL-low initialization failure. Full controlled USB power cycling recovered it without manual action. Firmware1.7.1 removes blocking LED-task debug output, adds bounded open-drain I2C recovery on initialization retry, and passed the three subsequent reset trials. These are observed regression results, not a claim that every possible hardware lockup is software-recoverable or that debug logging caused the original PN532 failure.

## Fixture controls and operating limits

Only dedicated demo users5/6/7 are involved. Short audited overrides bypass reservation only, not membership/waiver/training/account gates. Expired/inactive fixture users have no day-pass fallback. Member5's original membership dates/status were temporarily changed only for the two physical-negative cases, then restored and read back. No real email or payment is performed.

Normal authorization does not use the Mac. Power recovery through the Mac's switchable USB port is operator maintenance, not an ESP32-autonomous PN532 reset and not a new authorization transport. Standalone power arrangements may need a reset/power-control mechanism if host-only reset cannot recover the PN532.
