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
`030_email_only_accounts.sql` removes the stored username column and its format
constraint and unique index. Account IDs, emails, passwords, memberships, roles and
sessions are preserved. Previously applied migrations, including `023_usernames.sql`,
remain unchanged so existing migration checksums continue to validate. New installs
run the full migration chain and finish without the column.

Regression coverage checks email-only signup and sign-in, email confirmation, invalid
credentials, case-insensitive duplicates (including simultaneous registrations and
direct SQL writes), upgrade preservation, migration replay, and correction of an
existing-email error in the signup form.
