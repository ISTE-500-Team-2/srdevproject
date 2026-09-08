# Collaboratory MVC — quick handoff

## Run the attached source package

Requirements: Docker and Docker Compose.

1. Extract the ZIP and open a terminal in `Collaboratory-MVC`.
2. Run `docker compose -f compose.mvc.yml up --build -d`.
3. Open **http://localhost:8081** and select **Member demo**.

The database is isolated development data. It persists across app/container restarts. No public DNS or Figma connection is needed.

## Five-minute walkthrough

1. Home reads account status from PostgreSQL. The demo account has an active sample membership; its sample waiver initially needs agreement.
2. Reservations → 3D Printer → choose a future time within the next 30 days → Confirm reservation.
3. Reload the page: the session and booking are still there. Use My reservations to cancel it.
4. Certifications & Waivers → Review and agree → read the sample policy → explicitly agree.
5. Home → Check in. The new timestamp appears in recent check-ins.
6. Profile → change a name or phone → Save. Reload to see persistence.

Newly registered accounts do not automatically receive membership access. The one-click demo identities are explicitly enabled only for development. The Admin demo has a real staff-role session, but its charts are still sample previews.

## Current VM demo (Max's configured Mac)

The app is also running separately on Ubuntu-8802, bound only to VM loopback port 8081. From the Mac with the existing `arbor-collaboratory` SSH alias:

```sh
ssh -N -L 127.0.0.1:8081:127.0.0.1:8081 arbor-collaboratory
```

Then open **http://localhost:8081** on that Mac. If the MVC session's forwarding tunnel is already running, no second tunnel is needed. Other teammates can use the ZIP locally; they do not need Max's SSH configuration. This is not the public GCCIS hostname.

## Read next

- [Architecture, API, setup and remaining work](MVC.md)
- [Verified tests and limits](VERIFICATION-2026-09-08.md)

The current team database, the original React-only branch and the rollback VM are preserved. This package is the MVC foundation and working member/equipment/reservation slice, not a completed full application.
