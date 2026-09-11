# JWT authentication

This implements the team's Node.js + JSON Web Tokens decision, confirmed in [Matt's September 8 backend message](https://discord.com/channels/1461394966998814781/1546906482837291158/1546941376233480304). It replaces the opaque token implementation previously on this branch.

## Request flow

1. Registration, password login and development-only demo login issue a signed HS256 JWT through [jose](https://github.com/panva/jose). The payload contains `sub` (user ID), unique `jti`, `iss`, `aud`, `iat`, `nbf` and `exp`; no password, email or authorization grants.
2. The browser sends it in the `arbor_session` HttpOnly, SameSite=Lax cookie scoped to `/api`. Production also sets Secure. **JWT is the token format; the cookie is its transport.** There is no localStorage token, JavaScript-readable access token or new Authorization-header interface.
3. Protected endpoints verify the signature with an explicit HS256-only allowlist, JWT type, issuer/audience, required claims and time limits. Invalid tokens produce the same 401 response without logging the token. No token-supplied algorithm, key URL or role is trusted.
4. The verified token hash and subject must match an unexpired `app_session` row. This existing table is the issued-token/revocation registry and holds the session-bound CSRF value. Only the JWT hash is stored, not the signed token. This deliberately retains server-side revocation; it is **not a stateless JWT design**.
5. Account status and roles are fetched from PostgreSQL on every request. Staff mutations also retain their transactional authorization checks. Role changes and account deactivation take effect without waiting for JWT expiry.

The frontend's response contract (`user`, `csrfToken`) and `/auth/session` route remain unchanged. JSON writes still require the existing Origin/Fetch-Metadata checks and matching CSRF header; JWTs do not replace CSRF protection when transported in cookies.

## Expiry and revocation

- Normal login: signed token expires after 12 hours; the cookie is browser-session scoped.
- Remember me: token and persistent cookie expire after seven days.
- Logout deletes the registry entry and clears the cookie. A captured copy of that JWT no longer authenticates.
- Successful re-login invalidates the token previously presented by that browser and issues a fresh JWT ID and CSRF token. Other independently logged-in browsers are unchanged.
- There is no refresh-token endpoint or automatic renewal in this change; expiry requires signing in again.
- Changing the signing key invalidates all previously signed tokens. Multi-key rollover is not implemented.

## Signing key configuration

**Production:** provision at least 32 cryptographically random bytes through the deployment's secret manager, mount the key as a read-only file readable by the app user, and set `JWT_SECRET_FILE` to its path. This setting contains only a path, never the key itself. Startup rejects a missing/unreadable/undersized key. Production never generates a fallback, and all replicas must use the same mounted key. Keep key material out of Git, chat, command arguments and logs.

**Local development:** absent `JWT_SECRET_FILE`, the app generates a private 32-byte key at `.local/jwt-signing.key` relative to its working directory. `JWT_DEV_KEY_FILE` optionally changes that development-only location. File creation is atomic, mode 0600, under a private directory; subsequent starts reuse it. A supplied `JWT_SECRET_FILE` must already exist even in development. An existing undersized key is never silently replaced.

**Docker demo:** Compose uses `/app/.local/jwt-signing.key` on the separate `mvc-auth` named volume, owned by the non-root app user. The key therefore survives container recreation as well as application restart. The volume is not part of the image; `.local` is excluded from Git and Docker build context. Keep the auth volume if preserving active demo sign-ins. Local hot reload and the Docker demo have independent development keys/sign-ins.

## Upgrade and scope

No SQL migration or database reset is needed. Applied migrations remain unchanged; `app_session` already stores a SHA-256 hash, user ID, CSRF value and expiry. Old opaque tokens cannot pass JWT verification, so users sign in again once when upgrading. Existing application data is unaffected; expired registry rows are cleaned up during login as before.

PR #3's `permission` / `role_permission` integration, refresh-token rotation, password recovery and production deployment remain separate work. This JWT correction does not merge either PR, deploy the app or modify the shared database.

## Verification

`backend/test/integration/jwt.test.ts` exercises real HTTP authentication against disposable PostgreSQL, including invalid JWTs deliberately given live registry rows. This distinguishes signature/claim validation from rejection merely because a hash was absent. It covers expiry, required claims, algorithm/type restrictions, captured-token replay after logout/re-login, subject binding, live roles/status, CSRF/origin checks, restart/key rotation and registry expiry. `backend/test/jwtKey.test.ts` covers persistent private development keys and fail-closed production setup. Existing member/staff and React-to-PostgreSQL suites run unchanged apart from supplying a per-test signing key.
