# Time-limited access and relay prototype

Covers the remaining software/prototype work for [SDTA-204](https://teamarbor.atlassian.net/browse/SDTA-204) and [SDTA-134](https://teamarbor.atlassian.net/browse/SDTA-134).

SDTA-204 currently contains only its title. This change enforces existing reservation, membership/day-pass, waiver and machine-training windows. It does not invent opening hours or daily usage allowances. SDTA-134 explicitly permits a simulated relay for gate review. No actuator is installed, no machine is energized, and the Orange Pi/ESP32 firmware is unchanged.

## Time boundaries

After all existing account/resource/reservation/waiver/training checks pass, an authenticated reader gets a grant ending at the earliest applicable boundary:

- Five seconds after evaluation or the current confirmed reservation's end.
- End of the currently usable entitlement. Membership and day passes are alternatives; a valid pass can cover an expiring membership. Passes end at local midnight in the configured timezone, including daylight-saving changes.
- Expiry of a signature for a current required policy. Old, optional or superseded signatures do not shorten valid access. Missing current eligibility fails closed.
- Activation of an upcoming required policy, so the next decision checks the new requirement.
- Expiry of the assigned machine's training record or certification definition.

The client also enforces the absolute response expiry, subtracts the entire request duration from the server lease (so a slow response or a reader clock behind the server cannot extend access), and rejects malformed durations. Renewals do not add check-ins. `RenewingAccessSession` revalidates once per second; denial switches off when processed, and an unreachable backend cannot extend an old grant. The maximum outstanding authorization is five seconds, not an instantaneous remote cutoff guarantee. Startup, shutdown, reset and expiry are off; a stopped session needs a fresh scan. Successful renewals do not pulse the output off.

This Python controller is adapter-neutral. It is not silently installed on the real assembly. The existing ESP32 LED indication has its own documented shorter window.

## Incident and forced re-certification

For a machine safety incident, revoke that member's required machine certification through the existing Training workspace, with an incident reason:

1. The next signed decision for that machine returns denial/zero lease and no approved check-in.
2. Account/facility restoration does not restore the certification. A reservation override cannot bypass it.
3. Another authorized instructor/admin must verify newly completed in-person training, timestamped after revocation. Reusing the old training date returns `RETRAINING_REQUIRED`; unverified training and self-certification stay forbidden. The Training screen shows the revocation boundary.
4. A fresh scan/session may get a new grant only after approval and all other conditions pass. It cannot resurrect the stopped relay session.

This is targeted machine-training revocation, not automatic cancellation of every certification when an account is suspended. Safety re-certification requires a certification configured for the machine; equipment without one must not be presented as enforcing retraining.

## Gate-review stand-in and repeatable checks

From the repository root:

```sh
python3 deploy/reader/simulate_relay.py
python3 -m unittest discover -s deploy/reader -v
```

The visible demonstration prints `simulationOnly: true` and `physicalMachineSwitchingTested: false`. It uses fixture decisions to show startup off, short grant, expiry, denial, restart off and a fresh fixture grant. It makes no network request. It proves controller behavior, not a physical tap or newly completed training.

Separate real HTTP/PostgreSQL tests cover signed allow -> incident revocation -> denial -> old/unverified training rejected -> new instructor approval -> fresh decision allowed. Renewal/denial creates no duplicate visits and the training changes are audited. Use only an isolated, explicitly configured PostgreSQL instance:

```sh
PGHOST=127.0.0.1 PGPORT=56459 PGUSER=postgres PGDATABASE=postgres \
  npm run test:integration --prefix backend
```

`access-deadline.test.ts` covers reservation/membership/certification expiry, entitlement alternatives, both DST transitions, obsolete/current signatures and future policy activation. `relay-recertification.test.ts` exercises the incident workflow. Python tests cover deadlines, renewal, faults, malformed grants and restart behavior. These are automated prototype tests, not installed-machine acceptance.

## Migration/deployment boundary

Migration `020_recertification_after_revocation.sql` adds the last revocation timestamp, including direct database status revocations. Existing revoked records use their latest explicit audit event, otherwise migration time; they remain revoked. No account, booking, card or certification is restored automatically.

Back up and review before a separately approved deployment. Apply the migration before starting code that reads `revoked_at`; it does not delete records or change historical migration checksums. This PR does not deploy applications, mutate shared fixtures, change Jira status or flash hardware.

Actual machine switching still needs approved wiring/actuator/polarity, an independent fail-secure watchdog, power-loss testing and installed-machine acceptance. See [the existing NFC prototype](NFC-LED-PROTOTYPE.md). The ticket's simulated-relay allowance is distinct from physical completion.
