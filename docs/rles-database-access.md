# RLES database access and operations

Verified September 24, 2026. This is the implemented setup, not a claim that staging or production applications are complete. See [team SSH quick start](rles-team-quick-start.md) for the existing tunnel configuration.

## Credential handoff status

On September 24, 2026, individual credentials, this guide, the SSH quick-start and the public CA were emailed separately to all seven addresses in the team contract (including Max). This records sending, not confirmation that recipients opened the emails or connected successfully. No passwords are included in the repository.

## Team access

Website accounts and roles are separate from SSH and database accounts. Changing database authentication does not grant or remove website admin permissions.

1. Keep your existing authorized SSH key. The SSH destination remains `arbor-collaboratory` (Ubuntu-8802 via the existing Serveo jump route). Existing teammate keys are tunnel-only; no VM shell or Docker access is granted.
2. Obtain **your own** development database password privately from the infrastructure owner. Individual passwords are supplied separately in private onboarding messages, not in this document. Assigned passwords can be used directly; choosing a new password is optional during this development handoff. Never use another person's login or put passwords in Git, Jira, chat, shell commands, or this document.
3. Open the tunnel:

   ```sh
   ssh -N -L 15432:127.0.0.1:15432 arbor-collaboratory
   ```

4. Configure your database client:

   - Host: `127.0.0.1`
   - Port: `15432`
   - Database: `collaboratory_dev`
   - User: your named account below
   - TLS/SSL mode: **verify-full** (certificate and hostname verification)
   - Root CA: [`certificates/rles-database-ca.crt`](certificates/rles-database-ca.crt)
   - Password: enter privately in the client's password field

   `localhost` and `127.0.0.1` are included in the development server certificate for SSH-tunnel clients. Encryption-only / trust-all-certificate modes are not the intended setup.

   From the repository root, psql prompts for the password without putting it in the command:

   ```sh
   psql -W "host=127.0.0.1 port=15432 dbname=collaboratory_dev user=arbor_dev_matt sslmode=verify-full sslrootcert=docs/certificates/rles-database-ca.crt" -c "SELECT current_database(), current_user;"
   ```

5. Keep the SSH terminal open while using the database. Close it when finished.

### Named development accounts

- Max: `arbor_dev_max`
- Matt: `arbor_dev_matt`
- Edwin: `arbor_dev_edwin`
- Declan: `arbor_dev_declan`
- Antwoine: `arbor_dev_antwoine`
- Raika (GitHub `rkamalaraj`): `arbor_dev_rkamalaraj`
- Elise (GitHub `eoh7792`): `arbor_dev_eoh7792`

These accounts inherit `arbor_developers`: SELECT/INSERT/UPDATE/DELETE on development tables and USAGE/SELECT on development sequences. No superuser, database creation, role creation, schema DDL, or access to another environment. Schema migrations remain an administrator deployment operation.

Existing installed keys were preserved. The SSH inventory already contains keys associated with Matt, Edwin, Declan, Antwoine, and `rkamalaraj`, plus the infrastructure owner's key. A key for `eoh7792` was not identified; that person's SSH onboarding still needs a verified public key. A provisioned database account alone does not establish end-to-end access from a teammate's laptop.

### Transitional shared login

The existing `arbor_dev_team` login **temporarily remains enabled** with its existing password and developer-level permissions, now requiring TLS. This avoids locking out teammates before private password handoff. It is not the final individual-account model. After each teammate has verified their named login, disable the shared role with `ALTER ROLE arbor_dev_team NOLOGIN;` and check for old connections. Do not silently disable it before handoff.

MinIO and its existing credentials/tunnels were not changed by this database work. The full storage tunnel command in the quick-start still applies.

## Implemented boundaries

- Public application: `arbor-email-app`, loopback HTTP port 8082, database `arbor-email-db` / `arbor_email_dev`, runtime role `arbor_public_app`.
- Isolated demo: `arbor-mvc-current`, loopback HTTP port 8081, database `arbor-mvc-db-1` / `arbor_mvc_dev`, runtime role `arbor_demo_app`.
- Public DB is only on `arbor-public-dbnet` (internal). Public app also uses `arbor-public-egress` for email and external services.
- Demo DB is only on `arbor-demo-dbnet` (internal). Demo app also uses `arbor-demo-egress`.
- Public/demo apps and DBs are no longer members of the shared `arbor-mvc_mvc` network. Stopped rollback containers may still be listed there; do not start them directly.
- Public and demo signing keys are distinct and were rotated. Existing browser sessions may require login again.
- All five PostgreSQL instances (public, demo, development, staging, production) require SCRAM-SHA-256 authentication and TLS for allowed TCP connections. Network superuser login is explicitly rejected. Other environments/roles/databases fall through to reject rules.
- Local administrative maintenance uses peer authentication for the database owner, mapped only from container OS users `root` and `postgres`. This is not network passwordless access. Docker/host administrators remain trusted and can override container protections.
- Applications have DML permissions, not schema ownership or superuser powers. Migration history is SELECT-only for application roles. Run migrations separately with the maintenance account.
- Read-only group roles exist for public/demo/staging/prod but have no team login members automatically granted. No public database TCP port was opened. Development's 15432 and the pre-existing demo maintenance port 25432 remain host-loopback-only; existing teammate tunnel rules do not automatically permit 25432.
- Unrelated application settings, deployed image versions, real-email enablement and 1-second polling were preserved.

For approved public-data inspection, the infrastructure owner must arrange a separate named login, grant only the appropriate read-only group, and establish a restricted access route. Developer accounts do not automatically gain public-site data access.

## Application configuration

Public/demo containers use private env files and read-only key/CA mounts. The non-secret pattern is:

```dotenv
PGHOST=arbor-email-db
PGDATABASE=arbor_email_dev
PGUSER=arbor_public_app
PGSSLMODE=verify-full
NODE_EXTRA_CA_CERTS=/run/arbor/ca.crt
JWT_SECRET_FILE=/run/arbor/jwt.key
# PGPASSWORD is provided only by the private runtime environment file.
```

Never disable certificate verification to make deployment work. The deployed node-postgres version was checked: verify-full enables Node TLS verification; the private CA is loaded through `NODE_EXTRA_CA_CERTS`. Both trusted connections and rejection of an untrusted CA were tested.

## Infrastructure-owner maintenance

The private operational directory on Ubuntu-8802 is `/home/student/arbor-security-20260924` (mode 0700). It contains credentials, private signing material, recovery snapshots and runtime env files. **Do not copy that directory into Git or attach it to Jira.** Only the public CA certificate belongs in this repository.

- `before/`: five custom-format database backups, role/global SQL, database authentication configs, and pre-change container/network snapshots. Every custom dump was restored successfully into a network-disabled disposable PostgreSQL server.
- `team-accounts/`: separate private handoff files for each named developer. Deliver only the intended user's credential through an approved private method; they may use the assigned password directly, or request a change.
- `arbor-email-app.env`, `arbor-mvc-current.env`: application runtime settings including restricted database passwords.
- `arbor-email-db.env`, `arbor-mvc-db-1.env`: secure database initialization settings; no `POSTGRES_HOST_AUTH_METHOD=trust`.
- `public.jwt.key`, `demo.jwt.key`: separate runtime signing keys.
- `certs/`: private CA/server keys and public certificates.
- `runtime-manifest.json`: post-change container/runtime reconstruction reference. Sensitive; retain mode 0600. It is a snapshot, not an executable deployment script.

For interactive administrator maintenance, after connecting with the infrastructure owner's existing SSH key:

```sh
docker exec -it arbor-dev-db psql -X -U arbor_dev -d collaboratory_dev
```

Use `\password arbor_dev_matt` (replace the name) inside psql for a hidden password prompt. Do not paste a password into SQL command-line arguments. This changes the live password; update the private handoff record appropriately without committing it.

New schema objects must retain the reviewed object-owner/default-privilege pattern. Check runtime permissions after a migration; objects created by a new migration owner do not inherit a different owner's default ACLs.

### Future deployments

Do not reuse pre-hardening container snapshots or the old shared-network MVC Compose definition for the active public/demo apps. They refer to the old shared signing key and/or superuser connection settings. Use the post-hardening runtime manifest and private env files, keep each app on its own backend/egress networks, preserve its current volume mounts, and change only the application image when appropriate. Never initialize a fresh empty volume as a shortcut for an existing deployment.

Legacy `/srv/team-arbor` development/staging/production infrastructure remains separate. Those database volumes now contain TLS/HBA configuration. Do not reinitialize them or overwrite their authentication files with old templates. A future IaC/Compose consolidation is separate work; no claim is made that every historical deployment script has been rewritten.

### Verification after changes

- Public HTTPS `/api/health` returns 200 with database connected.
- Public/demo password login, authenticated session, profile save/persistence, logout and token rejection work.
- Runtime `pg_stat_ssl` reports encryption; roles are not superusers and cannot create tables.
- Missing/incorrect passwords, plaintext connections and untrusted CA fail.
- Demo cannot reach public DB IP; public app cannot reach demo DB IP.
- Named development login works through the approved tunnel with verify-full.
- Email polling remains 1000ms; an actual new email-delivery test was not sent as part of this hardening.

### Certificates

CA SHA-256 fingerprint:

```text
52:CA:70:14:0E:43:0C:05:DA:4E:4A:2F:5B:AB:25:DB:4A:95:49:15:BE:15:F5:27:BB:19:D7:45:CC:47:C0:FB
```

Server certificates were issued for one year on September 24, 2026; renew before their September 2027 expiration. The CA expires September 21, 2036. Keep the CA private key on the administration host only. Replace certificates in the persistent database data directories with PostgreSQL-readable ownership, private key mode 0600, then reload and verify. If the CA changes, distribute the new public CA through the reviewed repository and update app mounts before cutover.

### Recovery

Old public/demo app and database containers are retained stopped with suffix `-before-security-20260924`; existing data volumes were preserved. Do not start an old database container while its replacement uses the same volume, and do not start old apps against their old superuser/shared-network configuration.

For an application regression, prefer rolling back just the application image while retaining the new credentials, TLS, network boundaries and signing-key mounts. For database-authentication recovery, use the administrator's local peer-authenticated socket to repair the specific rule. Do not restore `trust` rules as a default fix.

A full pre-change restoration is an emergency maintenance procedure: stop affected applications, preserve any records created since the backup, ensure only one database server owns each data volume, and deliberately restore the reviewed snapshot. Never overwrite current data automatically to undo an authentication change.

## Remaining work / claims we are NOT making

- Named credentials are delivered individually; verification on teammates' own devices is still required before retiring the shared developer login.
- Staging and production database/storage foundations exist, but their databases remain without the application schema and no staging/production application parity is established. The currently public site still uses `arbor_email_dev`; this work did not rename or migrate it.
- RIT-managed at-rest encryption remains unverified. TLS is not evidence of disk encryption. Obtain confirmation from RIT before closing that criterion.
- This does not close the scheduler's 98% on-time requirement or address the separate Orange Pi incident.

## References

- [PostgreSQL 16 authentication rules](https://www.postgresql.org/docs/16/auth-pg-hba-conf.html)
- [node-postgres TLS configuration](https://node-postgres.com/features/ssl)
