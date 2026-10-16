#!/usr/bin/env bash
# Human-operated tools for the NEW standalone installation in SPONSOR-HANDOFF.md.
# Never deletes a database/volume, seeds sample users, or contacts a cloud API.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
[[ -f .env.sponsor ]] || { echo 'Copy docs/hosting/sponsor.env.example to .env.sponsor first.' >&2; exit 1; }
compose=(docker compose --env-file "$root/.env.sponsor" -f "$root/docs/hosting/compose.yml")
db() { "${compose[@]}" exec -T db sh -eu -c 'export PGPASSWORD="$(cat /run/secrets/db_password)"; exec "$@"' sh "$@"; }
node_script() { "${compose[@]}" run --rm --no-deps app sh -eu -c 'export PGPASSWORD="$(cat /run/secrets/db_password)"; exec node "$@"' sh "$@"; }
empty_db() {
  local count
  # Docker must not consume the operator's later confirmation on standard input.
  count=$(db psql -U arbor -d arbor -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'" </dev/null)
  [[ "$count" == 0 ]] || { echo 'STOP: this database already has tables. Nothing has been deleted or restored.' >&2; exit 1; }
}
confirm() {
  local answer
  printf '%s\n' "$1"
  read -r answer
  [[ "$answer" == "$2" ]] || { echo 'Cancelled. No database change made.' >&2; exit 1; }
}
backup() {
  umask 077
  mkdir -p .sponsor-backups
  local file=".sponsor-backups/arbor-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
  db pg_dump -U arbor -d arbor --format=custom --no-owner > "$file"
  [[ -s "$file" ]] || { echo 'Backup is empty; stop and investigate.' >&2; exit 1; }
  db pg_restore --list < "$file" >/dev/null
  printf 'Backup created and archive index checked: %s\n' "$file"
  echo 'Copy this backup to your private off-server backup location. A restore rehearsal is still required.'
}
case "${1:-help}" in
  check) "${compose[@]}" config --quiet; docker compose version; echo 'Configuration parses. This does not prove the server is deployed.' ;;
  build) "${compose[@]}" build app ;;
  start-db) "${compose[@]}" up -d --wait db ;;
  initialize-new)
    empty_db
    confirm 'NEW INSTALLATION ONLY. Type CREATE NEW DATABASE to create the empty schema.' 'CREATE NEW DATABASE'
    # Legacy DDL contains DROP statements: it is allowed only after the empty guard.
    db psql -U arbor -d arbor -v ON_ERROR_STOP=1 < ddl/collaboratory-db-create.sql
    node_script backend/dist/scripts/migrate.js
    echo 'Empty production schema initialized. No sample accounts or business data were loaded.'
    ;;
  restore-new)
    [[ -n "${2:-}" && -r "$2" ]] || { echo 'Usage: bash docs/hosting/arbor.sh restore-new /path/to/verified.dump' >&2; exit 2; }
    empty_db
    db pg_restore --list < "$2" >/dev/null
    confirm 'NEW EMPTY DATABASE ONLY. Type RESTORE NEW DATABASE to load the selected backup.' 'RESTORE NEW DATABASE'
    db pg_restore -U arbor -d arbor --no-owner --no-privileges --exit-on-error < "$2"
    echo 'Restore finished. Verify the recovered records before approving migrations or switching the domain.'
    ;;
  migrate)
    confirm 'This changes the database schema after creating a backup. Type APPLY REVIEWED MIGRATIONS only after reviewing the release instructions.' 'APPLY REVIEWED MIGRATIONS'
    backup
    node_script backend/dist/scripts/migrate.js
    ;;
  start) "${compose[@]}" up -d --wait ;;
  restart) "${compose[@]}" up -d --wait app proxy ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=80 app proxy ;;
  backup) backup ;;
  promote-owner)
    [[ -n "${2:-}" ]] || { echo 'Supply the confirmed owner email, not a password.' >&2; exit 2; }
    confirm 'FIRST ADMINISTRATOR ONLY. Type APPROVE FIRST ADMIN to grant this confirmed account administrator access.' 'APPROVE FIRST ADMIN'
    db psql -U arbor -d arbor -v ON_ERROR_STOP=1 -v owner_email="$2" < docs/hosting/first-admin.sql
    ;;
  *) printf '%s\n' 'Use: check | build | start-db | initialize-new | restore-new FILE | migrate | start | restart | status | logs | backup | promote-owner EMAIL' ;;
esac
