# Automatic updates for the shared RIT website

Merge the reviewed PR into **main**. After all required main-branch checks pass,
the RLES VM builds that exact commit and updates the existing public and private
demo/NFC application containers. No laptop needs to stay on. Open/unmerged PRs do
not deploy. The gateway, database containers, volumes, credentials and Pi stay put.

## What happens

1. A user-level systemd timer checks main about once a minute, after the previous
   check/release finishes. Idle checks use `git ls-remote`, not GitHub API polling.
2. A new SHA must pass application verification, sponsor-container rehearsal,
   Docker developer smoke and the Linux/macOS/Windows launcher tests. All checks
   must be from GitHub Actions on the exact SHA; successful main push workflows
   are required too. Pending, failed, skipped, cancelled or missing checks hold.
3. The VM fetches/builds that immutable SHA. No GitHub token, inbound webhook,
   self-hosted Actions runner, GitHub SSH secret or exposed Docker socket is used.
4. Read-only migration/checksum verification runs against both existing databases.
   **It never applies migrations, seeds, recreates volumes or resets data.** If a
   release needs a migration, an operator must review and authorize it separately.
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

## Pause, recover and retry

```sh
# Prevent a new cutover; an in-flight build rechecks this before switching.
touch /srv/arbor-full/auto-deploy/PAUSED
systemctl --user stop arbor-auto-release.timer
```

Each release keeps `previous-compose.json` and two database dumps under
`/srv/arbor-full/auto-deploy/releases/<SHA>/`. Old images and archives are retained;
there is no automatic deletion policy. Monitor disk space before many releases.

For an operator-directed manual rollback, keep the timer paused, restore the
recorded previous Compose file (save the current one first), then run:

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
