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

The RLES hosted app currently uses `arbor_mvc_dev`, while the team SQL tunnel points to `collaboratory_dev`; updating one does not change the other. The older hosted app only supports scrypt and must not receive these bcrypt sample rows without an auth deployment. Use current main for bcrypt-compatible local integration.
