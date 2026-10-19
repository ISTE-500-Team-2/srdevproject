# Admin analytics and compliance workspace

Declan's `AdminAnalytics` screens use the operational APIs already on `main`.

- **Analytics** uses `/admin/reports`, not paginated `/admin/payments` history. The server reports all settled receipts in the selected window, including membership, day-pass and studio payments. Paid/refunded records contribute gross; refunds reduce net; void/unpaid records are excluded by the existing report ledger rules.
- Daily/weekly/monthly groups follow the server's reporting timezone. Weeks begin Monday. The browser only aggregates server buckets, preserving zero-revenue periods and chronological labels. Selected start/end dates are inclusive; backend timestamp bounds are start-inclusive/end-exclusive.
- The chart is **gross** receipts; gross/refunds/net totals and a matching data table are shown separately. Refunds reflect current confirmed refund state against the original purchase date, not a historical cash-flow ledger.
- Activity counts are unique approved check-in users over the selected window, not current occupancy. Current authenticated reader leases are separate and are not proof of machine operation. Class enrollment/capacity and verified attendance come from the same report snapshot, not mock fixtures.
- **Certifications and Waivers** consolidates existing compliance filters/export, waiver publishing/retirement, and certification/training management. It reuses `StaffCompliance`, `StaffPolicies`, and `TrainingPage`; signed versions remain immutable, training approval requires existing instructor/admin authorization and verification. Existing dedicated tabs remain available.
- Queries show loading/error/retry/empty states and refresh every 30 seconds. Reporting windows are limited to 93 inclusive days. The backend continues to enforce permissions; no new role grants or schema changes are introduced.

## Verification

`npm --prefix frontend run check` covers the production build and regression tests. `npm --prefix frontend run test:integration` requires an explicitly configured isolated PostgreSQL database. Added real HTTP/PostgreSQL UI cases cover more than 50 payments, paid/refunded/void status handling, date filtering, absence of mock metrics, and access to the consolidated management tools. Existing training/policy/compliance tests retain mutation and permission coverage.

This PR does not deploy the website, alter shared data, close Jira tasks, or prove live machine switching.
