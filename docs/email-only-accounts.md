# Email-only accounts

Registration, sign-in, email confirmation and password recovery use email addresses.
Registration requires no username, and account/profile responses contain no username
field. Sign-in accepts `{ email, password, remember? }`; the former `identifier`
alias has been removed.

Email validation trims surrounding whitespace and lowercases addresses. The existing
`app_user_email_case_insensitive` unique database index prevents multiple accounts
with the same email, including concurrent registrations and changes in capitalization.
A duplicate registration returns HTTP 409 (`EMAIL_ALREADY_REGISTERED`), and the signup
form returns to the email step with the other entered details preserved.

Apply the normal migrations before starting the updated application:

```sh
npm run migrate --prefix backend
```

Use the database connection settings for the intended installation. Migration
`030_email_only_accounts.sql` marks the old nullable username column as deprecated.
It deliberately retains its data, format constraint and index so the still-running
previous release and rollback target do not break during blue-green deployment.
The new application never accepts, fills, returns or authenticates against it.
A separate contract migration may remove storage after all old readers are retired.
Account IDs, emails, passwords, memberships, roles and sessions are preserved.
Previously applied migrations, including `023_usernames.sql`, remain unchanged.

New requests stay in `app_pending_registration` until a single-use inbox link is
consumed. Duplicate pending requests remain neutral and do not overwrite passwords
or enqueue repeated emails; an already-confirmed account produces the existing
recoverable email-unavailable error. Verification remains required before membership.

Regression coverage checks email-only signup and sign-in, email confirmation, invalid
credentials, case-insensitive duplicates (including simultaneous registrations and
direct SQL writes), upgrade preservation, migration replay, and correction of an
existing-email error in the signup form.
