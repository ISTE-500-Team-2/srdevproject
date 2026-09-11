# Collaboratory MVC — quick handoff

**Updated primary workflows:** see [TEAM-HANDOFF.md](TEAM-HANDOFF.md) for the staff/member walkthrough, API/schema details, operating rules and remaining sponsor decisions. The original equipment walkthrough below still works.

## Run the attached source package

Requirements: Docker and Docker Compose.

1. Extract the ZIP and open a terminal in its source root (the folder containing `compose.mvc.yml`).
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

Newly registered accounts do not automatically receive membership access. Staff can now issue it through **Admin demo → Staff workspace → Members**. Create/edit offers under **Plans**, inspect recorded payments under **Payment history**, and review policy versions/change logs. The analytics tab is still a labeled sample preview. One-click demo identities are explicitly enabled only for development.

## Current VM demo (Max's configured Mac)

The app is also running separately on Ubuntu-8802, bound only to VM loopback port 8081. From the Mac with the existing `arbor-collaboratory` SSH alias:

```sh
ssh -N -L 127.0.0.1:8081:127.0.0.1:8081 arbor-collaboratory
```

Then open **http://localhost:8081** on that Mac. If the MVC session's forwarding tunnel is already running, no second tunnel is needed. Other teammates can use the ZIP locally; they do not need Max's SSH configuration. This is not the public GCCIS hostname.

## Read next

- [Architecture, API, setup and remaining work](MVC.md)
- [Historical foundation verification](VERIFICATION-2026-09-08.md)
- [Primary workflow verification](PRIMARY-VERIFICATION.md)
- [Detailed team handoff](TEAM-HANDOFF.md)
- [Requirements and testing evidence](REQUIREMENTS-TRACEABILITY.md)

The current team database, the original React-only branch and the rollback VM are preserved. This package includes the MVC foundation, primary membership/staff-access workflows and the equipment-reservation slice. It is not completion of every secondary feature or sponsor approval of the operating rules.
