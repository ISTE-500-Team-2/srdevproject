# Reading and maintaining the code

Start with the source files below. Module comments describe responsibilities;
function comments explain contracts, side effects and non-obvious choices.
Existing test names describe the behavior each scenario protects.

| Area | Start here | Responsibility |
| --- | --- | --- |
| Server startup | `backend/src/server.ts`, `app.ts`, `routes.ts` | Configuration, middleware order and endpoint wiring |
| Request handling | `backend/src/controllers/` | Parse HTTP input and adapt service results |
| Business rules | `backend/src/services/` | Permissions, eligibility and transactional changes |
| Persistence | `backend/src/models/`, `db.ts` | SQL, row locks and transaction clients |
| Authentication | `middleware/auth.ts`, `models/SessionModel.ts`, `accountMode.ts` | Sign-in, revocation and staff acting for members |
| Payments | `backend/src/billing/`, `studios/` | Quotes, checkout and provider reconciliation |
| Reader access | `deviceAccess.ts`, `services/ReaderEligibility.ts`, `accessDeadline.ts` | Signed decisions and short-lived access leases |
| Reader software | `deploy/reader/` | Provisioning, gateway communication and relay control |
| Email | `backend/src/notifications/` | Transactional outbox, rendering, dispatch and delivery events |
| Browser routing | `frontend/src/App.tsx`, `areas/` | Public/member/staff routes and bundle loading |
| Browser state | `context/AuthContext.tsx`, `lib/api.ts`, `lib/useApi.ts` | Session identity, authenticated requests and read lifecycles |
| Screens | `frontend/src/pages/`, `components/` | Member and staff workflows |
| Release tooling | `deploy/`, `.github/workflows/` | Verification gates, release scope and rollback |

Paths in the middle rows are relative to their area's source directory. The
existing [architecture guide](MVC.md) covers the broader structure, and
[local development](LOCAL-DEVELOPMENT.md) explains how to run it.

## Constraints to preserve

- Pass the transaction client to models and notification enqueue operations.
  Related record changes, audit evidence and queued notices must commit together.
- Keep the real operator distinct from the member whose account staff opened.
  The API authorizes requests; browser visibility is only a navigation aid.
- A checkout redirect is navigation, not proof of payment. Reconcile provider
  state before granting paid access or reporting a completed refund.
- Treat date-only values, facility calendar dates and UTC instants separately.
  Rental months and fixed 365-day compliance validity have different rules.
- **Do not edit applied migration files, even to add comments.** The migration
  runner verifies exact content checksums. Describe historical SQL in adjacent
  documentation and implement future schema changes in a new migration.
- Keep JSON manifests valid JSON and preserve generated files, dependency locks,
  policy wording and third-party attribution. These do not need filler comments.

## Verification

Backend and frontend `npm run check` run their unit checks/builds;
`npm run test:integration` exercises real PostgreSQL workflows with isolated test
databases. Deployment and reader regression commands are recorded in
`.github/workflows/mvc-verify.yml`, including the reader test dependencies.
The Dockerfile's `verify` target runs both application check/integration suites.
