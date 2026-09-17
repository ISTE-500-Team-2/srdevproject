# Team ARBOR — Shared VM and Development Access

Updated September 9, 2026.

## Use the current shared VM

- **VM:** `Ubuntu-8802`
- **RLES business group:** `ISTE-501-Collaboratory`
- **Guest hostname:** `arbor-collaboratory`
- **Private VM address:** `172.16.0.2`
- **Working SSH destination:** `student@arbor8802live`, through `serveo.net`

`Ubuntu-8754` / `arbor8754` is the old rollback VM under `ISTE-501`. It is intentionally off. Older copies of this guide used `Host arbor-rles` with `HostName arbor8754`; do not use that destination for current team development. Add the new alias below instead. The private VM address is not directly reachable from the public internet.

## Three separate kinds of access

1. **RLES portal:** your RIT account needs access to the `ISTE-501-Collaboratory` business group. GitHub membership does not grant this.
2. **Guest SSH tunnel:** your machine's public SSH key must be installed on the VM. RLES access and GitHub repository permissions do not automatically install it.
3. **PostgreSQL/MinIO:** after opening the tunnel, sign in with the separate development-service credentials.

The steps below establish SSH/database access, not RLES group membership or an interactive VM shell.

## One-time SSH setup

1. Use an existing Ed25519 SSH key on your own machine, or create one using [GitHub's SSH-key setup instructions](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent). Do not overwrite an existing key.
2. Add its **public** `.pub` file to your GitHub account as an **Authentication key**, not only a signing key: [GitHub instructions](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account). The private key stays on your machine.
3. Give the infrastructure owner your GitHub username so the public key can be authorized on the current VM. Adding it to GitHub alone does not complete VM access.
4. The infrastructure owner uses their existing administrator SSH access and runs this on `Ubuntu-8802`:

   ```sh
   /srv/team-arbor/bin/arbor-authorize-tunnel-key.sh GITHUB_USERNAME
   ```

   `GITHUB_USERNAME` is the teammate's account name. This existing script only accepts the Team ARBOR allowlist and installs tunnel-only access to the development ports.

Add the following to your SSH config file: `~/.ssh/config` on macOS/Linux, or `.ssh\config` under your Windows user profile. If your matching private key has a different filename, update `IdentityFile` to that file.

```sshconfig
Host arbor-collaboratory
    HostName arbor8802live
    User student
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ProxyJump serveo.net
    ExitOnForwardFailure yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

The destination VM's verified Ed25519 host-key fingerprint is:

```text
SHA256:APOMAvlcYJg7ol+rWZJhl8/PGLwjOxBHpA3wJCM7TBw
```

That fingerprint identifies the **destination VM**, not the separate Serveo jump host. If the destination fingerprint differs, stop and have the infrastructure owner verify the route; do not disable host-key checking or blindly remove a warning.

## Open the development tunnel

This single-line command works in macOS/Linux terminals and Windows PowerShell with OpenSSH:

```sh
ssh -N -L 15432:127.0.0.1:15432 -L 19000:127.0.0.1:19000 -L 19001:127.0.0.1:19001 arbor-collaboratory
```

Keep that terminal open. A quiet terminal without a shell prompt is normal. The `-N` is required for the intended tunnel-only access: teammate keys cannot open a VM shell and can reach only these three development loopback ports. The SSH user is `student`, not your RIT or GitHub username.

## Connect your database/storage client

- PostgreSQL host: `127.0.0.1`, port: `15432`
- Database: `collaboratory_dev`
- Development database username: `arbor_dev_team`
- MinIO S3 API: `http://127.0.0.1:19000`
- MinIO console: `http://127.0.0.1:19001`
- MinIO bucket: `collaboratory-dev`

Obtain the service credentials through the infrastructure owner's approved secure credential-sharing method. Enter them in the client's password field; do not put them in commands, GitHub, Jira, or chat.

If `psql` is installed, this read-only check prompts locally for the database password:

```sh
psql -W -h 127.0.0.1 -p 15432 -U arbor_dev_team -d collaboratory_dev -c "SELECT current_database(), current_user;"
```

Development schema updates are separate from access setup. Opening this tunnel or merging a pull request does not automatically reset or migrate the shared database. Staging and production are not exposed by these forwards.

## Common failures

- **VM missing in RLES:** check business-group access; this is not an SSH-key problem.
- **`Unknown alias/port combination arbor8754:22`:** old destination. Use the new SSH config above.
- **`Unknown alias/port combination arbor8802live:22`:** the current reverse tunnel is not registered. The owner must check Ubuntu-8802's RLES power state and `arbor-reverse-ssh.service`.
- **Destination `Permission denied (publickey)`:** confirm the matching key is selected and the owner has installed its public key. Distinguish an error at the jump host from one at the destination.
- **SSH closes when trying to get a shell:** use the `-N` forwarding command; teammate access is intentionally tunnel-only.
- **`Address already in use`:** an existing local application/tunnel owns that port. Use another local port and configure your client to match; keep the remote destination unchanged.
- **Database password rejected:** the tunnel and database login are separate. Check the development account/password, not your RIT or GitHub password.

## Availability and verification

On September 9, authenticated SSH, PostgreSQL forwarding, both MinIO endpoints and the project's infrastructure preflight passed on Ubuntu-8802. The VM has a separate MVC demo stack; its application port is not included in these team database/storage forwards.

GCCIS agreed to a semester-long suspension exemption. Its effective setting on Ubuntu-8802 has not been independently verified: RLES showed the VM Off and it was resumed on September 9. Treat another missing tunnel as an availability incident to investigate, not automatic evidence of a bad teammate key.

The assigned official hostname/SSH port is not the verified access route described here. This temporary Serveo route is the working route tested for this guide.

Infrastructure-owner check, using an administrator-authorized key:

```sh
ssh arbor-collaboratory /srv/team-arbor/bin/arbor-preflight.sh
```

Do not reset the shared database as an access-troubleshooting step.
