# Automatic updates for the shared RIT website

Merge the reviewed PR into **main**. After all required main-branch checks pass,
the RLES VM builds that exact commit and updates the existing public and private
demo/NFC application containers. No laptop needs to stay on. Open/unmerged PRs do
not deploy. The gateway, database containers, volumes, credentials and Pi stay put.

## What happens

1. A user-level systemd timer checks main about once a minute, after the previous
   check/release finishes. Idle checks use `git ls-remote`, not GitHub API polling.
   While a new SHA waits for CI, its GitHub check status is read at most every
   four minutes (unauthenticated reads are limited to 60 an hour, two per check),
   so a release can start up to four minutes after its checks pass.
2. A new SHA must pass application verification, sponsor-container rehearsal,
   Docker developer smoke and the Linux/macOS/Windows launcher tests. All checks
   must be from GitHub Actions on the exact SHA; successful main push workflows
   are required too. Pending, failed, skipped, cancelled or missing checks hold.
   Application verification now runs backend, frontend and deployment/reader
   regressions on independent runners. The required `verify` aggregation runs
   even when a lane fails/skips and passes only if every lane succeeded.
3. The VM fetches/builds that immutable SHA. No GitHub token, inbound webhook,
   self-hosted Actions runner, GitHub SSH secret or exposed Docker socket is used.
   Tracked public source gets its canonical readable/executable permissions before
   Docker builds. The protected release parent, Git metadata and untracked operator
   secrets remain private; the operator's restrictive umask is not weakened.
4. Read-only migration/checksum verification runs against both existing databases.
   **It never applies migrations, seeds, recreates volumes or resets data.** If a
   release needs a migration, an operator must review and authorize it separately.
   For migrations 045 to 055, use the guarded owner script for the numbered
   SQL, then run the post-commit online phase, including validation of the 055
   pending-registration constraint. The deployer checks that validation before
   starting standby. Keep cutover paused until both databases pass verification
   and the reader compaction grant is in place.
   [Migration procedure](prewarmed-production-releases.md#applying-migrations-045-to-055)
5. Fresh public/demo database dumps must succeed and pass `pg_restore --list`.
   This establishes readable archives, not a complete recovery test.
6. Localhost-only canaries (18082/18081) use the new image with email disabled.
   Database health, admin login, APIs, assets and anonymous denial are verified.
7. The VM rechecks main, CI, pause state and unchanged live configuration. Only
   the two existing application image fields are replaced. Health and live HTTPS
   smoke checks must pass; failure restores the previous Compose configuration
   and application images. No automatic database rollback is attempted.

Build/test time varies; the one-minute interval is a check interval, not a
promise that each merge will be live in a minute. If main changes during a build,
that build is not switched live. A failed SHA stays blocked until a newer SHA or
an explicit operator retry, avoiding an endless broken-release loop.

## Check it

On the existing VM as `student`:

```sh
systemctl --user status arbor-auto-release.timer
cat /srv/arbor-full/auto-deploy/status.json
tail -80 /srv/arbor-full/auto-deploy/service.log
```

`deployedSha` identifies the successful release. `candidateSha` is the latest
observed main. `phase` is `waiting-for-ci`, `deploying`, `deployed`, `blocked` or
`paused`. Build/rollout diagnostics stay in the protected service log. A blocked
release does **not** mean the old live application was taken down.

No user data, password, access token, environment file or database dump belongs in
a GitHub issue or Discord message. Share only the failed step and relevant SHA.

## Self-serve operator commands and progress

The existing `student` operator can use the installed `~/arbor-site` shortcut:

```sh
~/arbor-site status
~/arbor-site source
~/arbor-site update --wait
~/arbor-site watch --timeout 600
```

`status` shows the actual routed live revision, observed candidate, release stage
and required CI check counts. `status --json` returns only the safe progress
fields. No environment file or credential is included. `watch` follows the
observed candidate without making GitHub requests or changing deployment state.
`update --wait` establishes the exact requested main SHA, calls the existing
locked/gated deployer, then waits for that exact revision to become verified live.
A started process, a timeout, a pause, a failed release or a different newer main
must not be reported as successful completion.

The entrypoint is `deploy/arbor_site.py`. It does not grant new access. The exact
live checkout is `/srv/arbor-full/auto-deploy/releases/<SHA>/source`; do not edit
or `git pull` in that immutable directory. Develop in a separate checkout and
merge a reviewed PR normally. Ubuntu updates/reboots are a separate operation.

## Optional prepare-while-CI-runs mode

After the tested controller upgrade is explicitly installed, the private
`auto-deploy/prebuild.enabled` marker permits building the current **main**
revision while CI is pending. It does not start an application, run a migration,
send notifications or alter public routing. Known failed required checks hold
speculative preparation. Less than 2 GiB free holds it too; nothing is pruned or
deleted. A failed speculative build leaves the old website running, is not marked
as a failed application rollout, and is not endlessly retried on each timer tick.

`prepared-image.json` binds the exact commit to an immutable local image ID.
Reuse requires that commit's pristine checkout and matching image revision label;
a mutable tag is never sufficient. A dirty checkout is refused, not silently
cleaned or built under a false commit label. A removed/mismatched cache is rebuilt.
Database schema checks, fresh backups, main/CI/pause/config rechecks, authenticated
smokes, atomic promotion and rollback are still required after preparation.

Progress stages distinguish image preparation, schema/backups, standby start and
verification, demo update, promotion-gate recheck, public promotion and live
verification. Stage history stays bounded and owner-only. Preparation and cutover
metrics remain separate; faster CI/preparation is not a claim of zero CI wait.

## Daily database backups

Release dumps only exist when a release happens. A second user-level timer,
`arbor-daily-backup.timer`, backs up the same public and demo databases once a
day at about 03:30 (server time; `Persistent=true` catches up after the VM was
off). `deploy/daily_backup.py` uses the deployer's own dump step
(`auto_release.dump_database`: `pg_dump --format=custom --no-owner` as the owner
inside each database container, then `pg_restore --list` must read it), so a
daily dump is the same kind of archive as a release dump.

- Each run writes `/srv/arbor-full/auto-deploy/daily-backups/<UTC stamp>/`
  with one `<database>.dump` per database (folder 0700, files 0600). It is built
  as `<stamp>.partial` and renamed only once every database has been dumped and
  checked; a failed or interrupted run leaves nothing half-written.
- Only after a successful run, the oldest daily folders beyond `--keep` (14 in
  the installed service) are deleted. Release dumps under `releases/` and any
  other folder are never touched.
- It takes the same `deployment.lock` as the release deployer. While a release
  holds it, the backup waits up to 40 minutes, then gives up; while the backup
  holds it, the release timer simply tries again a minute later.
- It does not run while `auto-deploy/PAUSED` exists (an operator is working on the
  databases and takes their own backups), or with less than 2 GiB free. Nothing
  is deleted to make room.
- A skipped run exits 75 and a failed run exits 1, so either shows as a failed
  unit. `auto-deploy/daily-backup.json` records the last success and the last
  problem; details are in `auto-deploy/daily-backup.log`.

```sh
systemctl --user list-timers arbor-daily-backup.timer
cat /srv/arbor-full/auto-deploy/daily-backup.json
tail -40 /srv/arbor-full/auto-deploy/daily-backup.log
ls /srv/arbor-full/auto-deploy/daily-backups/
# Take one now, for example after a skipped day (waits for a running release):
systemctl --user start arbor-daily-backup.service
```

Fourteen days of both dumps stay on the VM's disk; check `df -h /srv` after the
first few runs. These are readable archives on the same VM, not an off-site copy
or a restore test.

### Install the daily backup timer

Not installed automatically. As `student` on the VM, from a checkout of the
merged revision (not the immutable release checkout):

```sh
cp -p /srv/arbor-full/auto-deploy/auto_release.py /srv/arbor-full/auto-deploy/auto_release.py.before-daily-backup
install -m 0600 deploy/auto_release.py deploy/daily_backup.py /srv/arbor-full/auto-deploy/
install -m 0644 deploy/arbor-daily-backup.service deploy/arbor-daily-backup.timer ~/.config/systemd/user/
python3 -m py_compile /srv/arbor-full/auto-deploy/daily_backup.py
systemctl --user daemon-reload
systemctl --user start arbor-daily-backup.service   # first backup now; check the log
systemctl --user enable --now arbor-daily-backup.timer
```

`daily_backup.py` imports the installed `auto_release.py`, so install both from
the same revision, under the usual controller-installation rules below (keep the
`local-frontend-tools` copy of `auto_release.py` identical). Install while no
release is running, for example with the release timer stopped.

## Pause, recover and retry

```sh
# Prevent a new cutover; an in-flight build rechecks this before switching.
touch /srv/arbor-full/auto-deploy/PAUSED
systemctl --user stop arbor-auto-release.timer
```

Each release keeps `previous-compose.json` and two database dumps under
`/srv/arbor-full/auto-deploy/releases/<SHA>/`. Old images and archives are retained;
there is no automatic deletion policy. Monitor disk space before many releases.
`PAUSED` also holds the [daily database backup](#daily-database-backups); take one
by hand after resuming if a day was skipped.

Keep applied migrations in place during application rollback. The previous release
cannot confirm or resend a usable link for staged sign-ups created, replaced or
resent by the new release. Those members can continue once the password-aware
release returns, or sign up again if their request has expired.

For an operator-directed manual rollback, keep the timer paused, restore the
recorded previous Compose file (save the current one first), then run:

**This legacy Compose procedure is not valid with `blue-green.enabled`.** For
the current prewarmed install, follow `docs/prewarmed-production-releases.md`:
restore a healthy retained public slot and its recorded route, not the legacy
public template. Interrupted activations are recovered by the existing journal.
Never restore a database backup as an application-image rollback.

```sh
docker compose -p arbor-full -f /srv/arbor-full/compose.json up -d --no-deps --no-build --wait arbor-email-app arbor-mvc-current
```

Verify login, health and the public URL. Rollback does not restore database data
or reverse schema changes. Keep automation paused while diagnosing the failure.

After a reviewed fix or explicitly authorized migration, resume/retry:

```sh
# Only if PAUSED exists: retain the pause marker instead of deleting it.
mv /srv/arbor-full/auto-deploy/PAUSED /srv/arbor-full/auto-deploy/PAUSED.previous
python3 /srv/arbor-full/auto-deploy/auto_release.py --retry
systemctl --user enable --now arbor-auto-release.timer
```

## Install or update the deployer itself

This is an RLES-specific adapter, not the sponsor-hosting template. It expects
the existing `/srv/arbor-full/compose.json`, public admin verification credentials
in the existing protected `admin.private.json`, Docker access and the existing
public/demo databases/networks. It refuses a missing stack instead of creating one.

After reviewing and merging changes, copy `deploy/auto_release.py` to
`/srv/arbor-full/auto-deploy/auto_release.py` (directory 0700, script 0600).
Install the matching `deploy/blue_green_release.py` under the same deployment
lock, backing up both existing controller files first. `auto_release.py` also
holds the CI check selection and required workflow list that
`local_frontend_release.py` uses. When the owner-local frontend tools are
installed (see `docs/local-frontend-releases.md`), copy the same `auto_release.py`
and the matching `local_frontend_release.py` into
`auto-deploy/local-frontend-tools/` in the same step, so both `auto_release.py`
copies stay identical. Install `deploy/arbor_site.py` as `~/arbor-site` (0700)
for the existing operator. Syntax-check the new files
before replacement. Enable `prebuild.enabled` only after this matching upgrade;
the old app and its data do not need a reset or OS upgrade.
Copy the matching `.service` and `.timer` files into `~/.config/systemd/user/`.
Run `systemctl --user daemon-reload`, then enable the timer above. The VM's
`student` user already has lingering enabled, so this continues without a login
and starts after VM reboot. Verify `loginctl show-user student -p Linger` on a
replacement host; do not silently change host privileges.

The installed deployer does **not** overwrite itself from main. A change to the
release machinery requires this explicit operator installation. Normal app
changes deploy automatically. The old SSH/GHCR workflow remains manual-only for
separately configured hosting and no longer creates failing automatic staging
deployments on every merge.
