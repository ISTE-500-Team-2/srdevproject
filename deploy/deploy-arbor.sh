#!/usr/bin/env bash
# Immutable app releases only. No schema migration, guest/volume deletion or seed.
set -euo pipefail
umask 077
mode=${1:-}; image=${2:-}; root=${3:-}; environment=${4:-}; network=${5:-}; port=${6:-}; key=${7:-}
[[ "$mode" == staging || "$mode" == production ]] || { echo 'Choose staging or production' >&2; exit 2; }
[[ "$image" =~ ^ghcr.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'An immutable GHCR image digest is required' >&2; exit 2; }
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$environment" =~ ^/[a-zA-Z0-9_./-]+$ && "$network" =~ ^[a-zA-Z0-9_.-]+$ && "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || { echo 'Invalid deployment target' >&2; exit 2; }
[[ -f "$environment" && -r "$environment" && -f "$root/compose.release.yml" ]] || { echo 'Existing protected environment and compose file required' >&2; exit 2; }
# The production server refuses to start without its JWT signing key (32+ random bytes).
[[ "$key" =~ ^/[a-zA-Z0-9_./-]+$ && -f "$key" && -r "$key" && $(wc -c < "$key") -ge 32 ]] || { echo 'Existing protected JWT signing key file required' >&2; exit 2; }
command -v docker >/dev/null; command -v flock >/dev/null
mkdir -p "$root/backups" "$root/releases"
exec 9>"$root/deployment.lock"; flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
export ARBOR_RELEASE_IMAGE="$image" ARBOR_ENV_FILE="$environment" ARBOR_DOCKER_NETWORK="$network" ARBOR_HTTP_PORT="$port" ARBOR_JWT_KEY_FILE="$key"
project="arbor-$mode"
compose=(docker compose -p "$project" -f "$root/compose.release.yml")
old=''; if [[ -f "$root/releases/current-image" ]]; then old=$(cat "$root/releases/current-image"); fi
if [[ -n "$old" && ! "$old" =~ ^ghcr.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; then echo 'Invalid stored prior image' >&2; exit 2; fi
# A managed existing stack must first be registered; never adopt another project.
if [[ -z "$old" && -z "${ARBOR_ALLOW_INITIAL_RELEASE:-}" ]]; then echo 'Register prior release or explicitly allow first release' >&2; exit 2; fi
"${compose[@]}" config --quiet
docker network inspect "$network" >/dev/null
docker pull "$image"
# The image's own user must be able to read the mounted key, or the release restart-loops.
docker run --rm --network none --env NODE_ENV=production --env JWT_SECRET_FILE=/run/secrets/jwt_key \
  --volume "$key:/run/secrets/jwt_key:ro" --entrypoint node "$image" \
  -e "import('./backend/dist/jwtKey.js').then(m=>m.readJwtKey())" >/dev/null || { echo 'The release image cannot read the JWT signing key file' >&2; exit 1; }
backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$mode.dump"
# Resolve DATABASE_URL using the exact application parser. libpq does not expand
# a URI merely assigned to PGDATABASE. Keep all credentials out of arguments.
connection=$(mktemp "$root/.backup-env.XXXXXX")
trap 'rm -f -- "$connection"' EXIT
docker run --rm --env-file "$environment" --entrypoint node "$image" backend/dist/scripts/backup-environment.js > "$connection"
docker run --rm --network "$network" --env-file "$environment" --env-file "$connection" postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8 pg_dump --format=custom --no-owner > "$backup"
[[ -s "$backup" ]] || { echo 'Database backup is empty; refusing rollout' >&2; exit 1; }
docker run --rm -i postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8 pg_restore --list < "$backup" >/dev/null
# Migrations are an explicit, separately reviewed operator step, never automatic.
docker run --rm --network "$network" --env-file "$environment" --entrypoint node "$image" backend/dist/scripts/verify-migrations.js
if ! "${compose[@]}" up -d --no-build --wait --wait-timeout 90; then
  if [[ -n "$old" ]]; then export ARBOR_RELEASE_IMAGE="$old"; "${compose[@]}" up -d --no-build --wait --wait-timeout 90; fi
  echo 'Release failed health checks; prior app image restored where available. Database untouched.' >&2; exit 1
fi
printf '%s\n' "$image" > "$root/releases/current-image.next"
mv "$root/releases/current-image.next" "$root/releases/current-image"
printf 'Release healthy; database backup retained: %s\n' "$backup"
