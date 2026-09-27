# Run the app locally

Use this instead of copying environment commands from Discord. The commands are
identical in Mac Terminal and Windows PowerShell. Start in the repository root.

## Before starting

- Install Node **22.18+** (`node -v`) and Docker Desktop with Compose v2; start Docker.
- Use your working branch with the current main changes incorporated. Save your work
  before updating branches. Do not reset your files to follow this guide.
- Stop old local backend/Vite processes using ports **8080** and **5173**.

## Normal frontend work

```sh
npm run dev
```

The command installs dependencies when needed, starts a dedicated local database,
initializes/migrates it, and starts the backend and Vite with hot reload.
Open **http://localhost:5173**. Use **Member demo** or **Admin demo**.
Save frontend edits to see them automatically; no Docker rebuild is needed.

Real email is OFF. New signup records can be created for UI testing, but they
cannot complete confirmation in this mode. Use demo accounts to get into the app.
No SSH connection, shared DB password, or API key is required.

## Test signup and real email

1. Copy `.env.example` to `.env.local` in your editor (at the repository root).
2. Put the team's authorized Brevo key in `BREVO_API_KEY`. Do not commit/share this
   file or put the key in frontend code. The launcher does not print the key.
3. Stop `npm run dev` with Ctrl+C, then run:

```sh
npm run dev:email
```

Open **http://localhost:5173**. Register with an inbox you control; allow about a
minute for the worker, check spam, then open the confirmation link **on this same
computer**. Resend confirmation if the link expires. Demo login is OFF.
This is real sending, not a simulated inbox. Do not use someone else's address
without their permission.

The email mode has its own database and persistent signing key. Demo signups do
not appear in it, and switching modes cannot flush old demo emails to real people.
Create your test account again in email mode. The key in `.env.local` is explicitly
required; inherited shell API keys are not used. Sender defaults are in the example.

For a remote recipient or gate-review demo, use a separately configured, reachable
shared development deployment: localhost links point to the recipient's computer.
This PR does not deploy or configure that server or its public webhook. Provider
acceptance is not proof of inbox delivery; check Brevo logs when investigating.

## What runs where

- Browser/Vite: **5173** (strict; startup fails if occupied).
- Backend API: **8080**; health check: http://localhost:8080/api/health.
- Demo DB: **25434**, database `arbor_mvc_dev`, Compose project `arbor-team-demo`.
- Email-test DB: **25435**, database `arbor_email_mvc_dev`, project `arbor-team-email`.
- Both use local role `arbor_mvc`; isolated synthetic-data databases only.

These are separate from the older Docker demo DB on 25432 and shared SSH DB on
15432. The launcher does not touch either. Ctrl+C stops API/Vite, leaving the
local database and its volume intact. Run the same command to resume.

`.env.local` supplies only email settings in email mode. Ports, origins, mode and
DB settings are controlled by the launcher so stale shell variables cannot select
the shared database. Existing direct backend commands still use their own shell
configuration; this file is not automatically loaded by them.

## Full Docker preview (optional)

```sh
docker compose -f compose.mvc.yml up --build --wait
```

Open **http://localhost:8081**. This is the older self-contained demo, not the Vite
hot-reload setup; source changes need a rebuild. It does not load `.env.local` or
send real email. Do not mix its URL with the launcher instructions above.

## If something fails

- Docker unavailable: start Docker Desktop and check `docker info`.
- Port busy: stop your old backend/Vite terminal; don't accept a different Vite port.
- Setup/migration failure: startup stops. Share the error, not environment values.
- Can't log in: check backend output and `/api/health`; select demo buttons in demo
  mode. Email-mode accounts must be confirmed first.
- Email not arriving: check startup says real email ON, then use resend. Check Brevo
  logs and backend worker errors. Do not keep re-registering the same address.
- Do not delete volumes or run destructive DDL to fix a generic request error.

Focused launcher tests: `npm run test:dev`. No email is sent by these tests.
