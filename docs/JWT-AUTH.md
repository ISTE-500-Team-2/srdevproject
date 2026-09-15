# JWT authentication

Implements the authentication contract in the team's [System Architecture](https://docs.google.com/document/d/1CeyE5pD_pmIZr6uXAO0zj9VhvVfYmsID3w42Trb4ly4/edit), security model. This corrects the earlier JWT-cookie implementation.

## Request flow

1. Password registration uses bcrypt with cost 12 through [bcryptjs](https://github.com/dcodeIO/bcrypt.js). Reject new passwords longer than 72 UTF-8 bytes rather than silently truncating them. Previously stored scrypt credentials remain verifiable and upgrade on successful login when within that limit; longer legacy passwords remain scrypt until a password-reset workflow is available. Plaintext fixtures never authenticate through password login.
2. Login/register/demo return `user`, `csrfToken`, `accessToken`, and `expiresIn`. HS256 access JWTs contain `sub`, `role`, `roles`, `jti`, `iss`, `aud`, `iat`, `nbf`, and `exp`. Default lifetime is 15 minutes. React holds the access token in module memory only and sends `Authorization: Bearer ...`; no localStorage, sessionStorage or access-token cookie.
3. The independent random refresh token is stored in an HttpOnly, SameSite=Lax `arbor_refresh` cookie scoped to `/api`, Secure in production. Refresh family lifetime is 30 days, absolute from sign-in. Remember me makes the cookie persistent; otherwise it is browser-session scoped, with the same server-side maximum.
4. On reload/401, the client fetches `/auth/csrf`, then POSTs JSON to `/auth/refresh` with the CSRF header and browser-owned cookie. Same-origin response access and Origin/Fetch-Metadata/JSON checks protect renewal. Concurrent requests within one page share a renewal promise. The cookie alone never authorizes ordinary API requests.
5. Rotation locks the family transactionally, consumes the old refresh token and issues a new refresh/access pair. Reusing a consumed refresh token with valid CSRF revokes the entire family, including all its access tokens. This is deliberately strict: cross-tab simultaneous refresh, or a lost response followed by retry of the consumed token, can require sign-in again. No grace/replay window is implemented.
6. Protected routes verify signature, HS256-only algorithm, token type, required identity/role/time claims and issuer/audience. The token hash/subject must match an unexpired registry row belonging to an active refresh family. Current account status/roles are fetched from PostgreSQL; role claims are a snapshot, never a substitute for current permission checks.
7. Writes retain CSRF and origin checks. Logout revokes the entire refresh family and clears the refresh cookie. A successful re-login revokes the prior family presented by that browser; other browser families remain independent.

## Lifetime configuration

`JWT_ACCESS_SECONDS`: default 900, allowed 1–3600. `JWT_REFRESH_SECONDS`: default 2592000, allowed 1–7776000. These are nonsecret duration settings. Refresh rotation never extends the family's absolute expiry. Expired families and their token rows are cleaned on login. Signing-key replacement invalidates existing access tokens, but unrevoked refresh families can issue new ones; incident response must also revoke families when needed. Multi-key rollover is not implemented.

## Signing key configuration

**Production:** provision at least 32 cryptographically random bytes through the deployment's secret manager, mount the key as a read-only file readable by the app user, and set `JWT_SECRET_FILE` to its path. This setting contains only a path, never the key itself. Startup rejects a missing/unreadable/undersized key. Production never generates a fallback, and all replicas must use the same mounted key. Keep key material out of Git, chat, command arguments and logs.

**Local development:** absent `JWT_SECRET_FILE`, the app generates a private 32-byte key at `.local/jwt-signing.key` relative to its working directory. `JWT_DEV_KEY_FILE` optionally changes that development-only location. File creation is atomic, mode 0600, under a private directory; subsequent starts reuse it. A supplied `JWT_SECRET_FILE` must already exist even in development. An existing undersized key is never silently replaced.

**Docker demo:** Compose uses `/app/.local/jwt-signing.key` on the separate `mvc-auth` named volume, owned by the non-root app user. The key therefore survives container recreation as well as application restart. The volume is not part of the image; `.local` is excluded from Git and Docker build context. Keep the auth volume if preserving active demo sign-ins. Local hot reload and the Docker demo have independent development keys/sign-ins.

## Upgrade and scope

Apply additive migration `004_refresh_tokens.sql` with the normal migration command, after migration 003. It adds refresh families/hashed rotation records and the session-family foreign key; existing business data and historical migrations remain unchanged. No reset is needed. Legacy access cookies are rejected and cleared on the next successful login, so users sign in once after upgrade. This code change does not deploy or reset the shared database.

Password recovery, full six-role RBAC coverage, cross-tab renewal coordination, and production deployment remain separate work. Existing waiver/training role restrictions remain unchanged pending specification reconciliation.

## Verification

Unit and PostgreSQL HTTP tests cover bcrypt/UTF-8 limits, legacy credential upgrade, configurable lifetimes, signed claims, tampering, expiry, live roles/status, subject binding, no cookie-only access, refresh rotation/reuse/concurrency, origin/CSRF, logout and restart. React-to-PostgreSQL tests exercise member and real staff workflows, memory-cleared reload and empty persistent browser storage. Docker CI verifies both access and refresh after container recreation. No physical-device or production deployment validation is implied.
