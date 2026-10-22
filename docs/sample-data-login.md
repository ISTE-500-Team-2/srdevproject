# Development sample logins

The SQL seed stores bcrypt cost-12 hashes, not plaintext. Enter the original test password in the login form; do not enter the hash. These are public test accounts, not production credentials.

- johndoe@example.com: `JohnDemo123!`
- janesmith@example.com: `janesmith`
- JDeen1999@gmail.com: `1!J$$D!@`
- RoseyM@gmail.com: `MaryLamb428`
- MarkBar13@yahoo.com: `mYp@ssw0rd111` (inactive; login must remain blocked)
- KatKat@yahoo.com: `123barry987`

John’s former `johndoe` password was shorter than the API minimum; use `JohnDemo123!`. Other sample passwords are unchanged.

For an existing development database, apply `database/fixes/repair-sample-passwords.sql`. It updates only exact known sample IDs/emails/plaintext values, is safe to rerun, and does not reset already-hashed or non-sample accounts. Do not rerun the full insert script over an existing database.

These seed instructions are for isolated sample development, not the public site.
The public website uses `arbor_email_dev`; the separate demo/NFC test app uses
`arbor_mvc_dev`, and the team SQL development tunnel points to `collaboratory_dev`.
Updating one does not change the others. Do not apply sample password repairs or
seed scripts to real website accounts. See [environment separation and the
proposed integration plan](UNIFIED-ENVIRONMENT.md). Use current main for local
bcrypt-compatible integration.
