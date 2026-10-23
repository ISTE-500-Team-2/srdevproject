#!/usr/bin/env bash
# Disposable GitHub CI only. No provider credentials, emails or live records.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'This rehearsal is for disposable GitHub Actions runners only.' >&2; exit 1; }
cp docs/hosting/sponsor.env.example .env.sponsor
umask 077
mkdir -p .sponsor-secrets
openssl rand -hex 32 > .sponsor-secrets/db-password
openssl rand 32 > .sponsor-secrets/jwt.key
# GitHub runner UID differs from the runtime application UID.
sudo -n chown 1000:1000 .sponsor-secrets/db-password .sponsor-secrets/jwt.key
sudo -n chmod 600 .sponsor-secrets/db-password .sponsor-secrets/jwt.key
bash docs/hosting/arbor.sh check
bash docs/hosting/arbor.sh build
bash docs/hosting/arbor.sh start-db
printf '%s\n' 'CREATE NEW DATABASE' | bash docs/hosting/arbor.sh initialize-new
if printf '%s\n' 'CREATE NEW DATABASE' | bash docs/hosting/arbor.sh initialize-new; then
  echo 'ERROR: nonempty database was accepted' >&2; exit 1
fi
compose=(docker compose --env-file .env.sponsor -f docs/hosting/compose.yml)
"${compose[@]}" up -d --wait app
"${compose[@]}" exec -T app node -e "fetch('http://127.0.0.1:8080/api/health').then(async r=>{if(!r.ok)throw Error(await r.text());console.log('Production health OK')})"
"${compose[@]}" exec -T app node -e "fetch('http://127.0.0.1:8080/api/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'admin'})}).then(r=>{if(r.ok)throw Error('Demo login accepted in production');console.log('Production demo login refused')})"
"${compose[@]}" exec -T db psql -U arbor -d arbor -v ON_ERROR_STOP=1 -c "INSERT INTO \"user\"(firstname,lastname,email,password,phone,status,email_confirmed) VALUES ('CI','Owner','owner@example.invalid','not-a-login-password','0000000000','active',false)"
if printf '%s\n' 'APPROVE FIRST ADMIN' | bash docs/hosting/arbor.sh promote-owner owner@example.invalid; then
  echo 'ERROR: unconfirmed owner accepted' >&2; exit 1
fi
"${compose[@]}" exec -T db psql -U arbor -d arbor -v ON_ERROR_STOP=1 -c 'UPDATE "user" SET email_confirmed=true'
printf '%s\n' 'APPROVE FIRST ADMIN' | bash docs/hosting/arbor.sh promote-owner owner@example.invalid
if printf '%s\n' 'APPROVE FIRST ADMIN' | bash docs/hosting/arbor.sh promote-owner owner@example.invalid; then
  echo 'ERROR: repeat bootstrap accepted' >&2; exit 1
fi
bash docs/hosting/arbor.sh backup
"${compose[@]}" exec -T db createdb -U arbor arbor_restore_ci
archive=$(find .sponsor-backups -name '*.dump' -type f -print -quit)
"${compose[@]}" exec -T db pg_restore -U arbor -d arbor_restore_ci --no-owner --no-privileges --exit-on-error < "$archive"
result=$("${compose[@]}" exec -T db psql -U arbor -d arbor_restore_ci -Atc "SELECT (SELECT count(*) FROM \"user\")||':'||(SELECT count(*) FROM app_staff_audit WHERE action='user.first_admin_bootstrap')")
[[ "$result" == '1:1' ]] || { echo 'Restored records did not match' >&2; exit 1; }
echo 'PASS: sponsor containers, empty-database guard, production health, first-admin guards, backup and new-database restore.'
