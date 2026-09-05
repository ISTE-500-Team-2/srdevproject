# RLES Development Access

The Team ARBOR development data services run on RLES VM `Ubuntu-8754`.

## Current state

- PostgreSQL 16 database `collaboratory_dev` contains the reviewed 15-table schema, 17 foreign keys, and synthetic seed data.
- MinIO bucket `collaboratory-dev` is available for development objects.
- Staging and production remain empty and isolated pending a reviewed promotion.
- Development endpoints bind only to VM loopback and require an authorized SSH tunnel.
- Public application HTTPS and the RLES auto-suspend exemption still require GCCIS approval.
- No Node/Express application exists in this repository yet.

## One-time access

1. Add an Ed25519 SSH public key to your GitHub account.
2. Give the infrastructure owner your GitHub username so a tunnel-only key can be installed.
3. Get the development database and MinIO credentials privately from the infrastructure owner. Never commit or post them.

Add this host to `~/.ssh/config`:

```sshconfig
Host arbor-rles
    HostName arbor8754
    User student
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ProxyJump serveo.net
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Open the tunnel:

```bash
ssh -N \
  -L 15432:127.0.0.1:15432 \
  -L 19000:127.0.0.1:19000 \
  -L 19001:127.0.0.1:19001 \
  arbor-rles
```

Keep that terminal open while using:

- PostgreSQL: `127.0.0.1:15432`
- Database: `collaboratory_dev`
- MinIO S3 API: `http://127.0.0.1:19000`
- MinIO console: `http://127.0.0.1:19001`
- MinIO bucket: `collaboratory-dev`

The tunnel-only key cannot open a VM shell and can reach only these three development ports.
