# GitHub Actions production deployment

The GitHub repository has two application directories: `client/` (React/Vite) and `server/` (Express/Prisma). Releases keep those names unchanged.

The production layout is:

```text
/opt/lakshmi-hyundai/
├── current -> releases/<40-character-commit-sha>
├── releases/
│   ├── initial/                 # existing; retained
│   ├── baseline-7fec106/        # existing; retained
│   └── <commit-sha>/
│       ├── client/dist/
│       └── server/
│           ├── src/
│           ├── package.json
│           └── node_modules/
└── shared/backend.env           # existing; never copied or replaced
```

The old `/opt/lakshmi-hyundai/releases/current` link, if present, is legacy state. This deployment uses only the top-level `/opt/lakshmi-hyundai/current` link. Existing release directories are not renamed, removed, or overwritten.

## Deployment flow

1. CI checks out the requested full commit SHA (a manual `deploy_sha` must already be an ancestor of `main`), tests the backend, validates Prisma, and builds the client with `VITE_API_BASE_URL=/api/v1`.
2. CI packages only the selected source/configuration files from `server/` and `client/` plus `RELEASE_COMMIT`. It rejects secrets, `.env`, `node_modules`, tests, backups, links, and unexpected archive members.
3. The production job waits for approval of the GitHub `production` Environment. Before SCP it verifies the existing `lakshmi-deploy` identity, Node.js `/usr/bin/node` `v24.22.2`, top-level `current`, protected helper/configuration, and installed systemd/Nginx configuration.
4. The remote deployment script verifies the archive marker equals the requested SHA, extracts safely, and creates `releases/<sha>` without renaming either application directory. For a new release, it runs `npm ci --omit=dev` in `server/`, generates Prisma Client, and verifies both Prisma Client and `@prisma/adapter-pg` import. It runs a full `npm ci` in `client/` so Vite development dependencies are present, then builds with `VITE_API_BASE_URL=/api/v1`.
5. Before activation, it checks required files, verifies every local asset referenced by `client/dist/index.html`, validates the active systemd and Nginx configuration, and checks migration status. Production dependencies include `prisma`, `@prisma/client`, `@prisma/adapter-pg`, and `pg`; the server lockfile is used.
6. Only a manual run with `apply_migrations: true`, after production Environment approval, can apply migrations. The release-specific Ed25519 authorization is time-limited, nonce-protected, and checked by the root-owned verifier. Ordinary deployment does not apply migrations.
7. The root-owned helper atomically switches top-level `current` to `releases/<sha>`. The script preserves the prior release through `releases/previous`, restarts the backend, reloads Nginx, and checks the backend health endpoint and local HTTPS frontend response. GitHub then checks the public frontend and `/api/v1/health`.
8. A failure after activation triggers locked, idempotent recovery to the previous release, followed by backend restart, Nginx reload, and health checks. Recovery never reverses database migrations or deletes releases. Migration compatibility must be backward-compatible across the active and rollback releases.

An already active and healthy commit is a no-op: it does not reinstall dependencies or switch links.

## GitHub configuration

Configure these repository variables:

| Variable | Requirement |
|---|---|
| `PRODUCTION_FRONTEND_URL` | HTTPS URL of the production site, such as `https://lakshmi-hyundai-crm.tech`. |

Configure these as **secrets on the `production` Environment**:

| Secret | Requirement |
|---|---|
| `VPS_HOST` | VPS DNS name or IP. |
| `VPS_USER` | Exactly `lakshmi-deploy`. |
| `VPS_SSH_PRIVATE_KEY` | Deployment Ed25519 private key; keep it only in GitHub and the ephemeral runner. |
| `VPS_SSH_KNOWN_HOSTS` | Host key verified out-of-band against the VPS console fingerprint. |
| `MIGRATION_AUTH_PRIVATE_KEY` | Ed25519 signing key for short-lived migration authorizations. |

Create the `production` Environment, require authorized reviewers, enable prevent-self-review where available, disable administrator bypass where supported, and restrict deployment branches to `main`. Third-party workflow actions are pinned to full commit SHAs. SSH requires strict host-key checking.

Do not configure `DATABASE_URL`, backend `.env`, JWT keys, or database passwords in GitHub. The workflow never transfers or prints the existing `shared/backend.env`.

## VPS prerequisites (manual; not performed here)

The VPS already has the backend service, PostgreSQL, environment file, and releases. Do not create/rename/delete users or alter the existing release directories. Keep using `lakshmi-deploy` for SSH, backend, and migration execution.

### One-time layout and service configuration

First inspect the running service and links without printing environment values:

```bash
sudo systemctl show lakshmi-hyundai-backend.service \
  -p User -p Group -p WorkingDirectory -p ExecStart -p EnvironmentFiles
sudo readlink -f /opt/lakshmi-hyundai/releases/current
sudo readlink -f /opt/lakshmi-hyundai/current
sudo test -s /opt/lakshmi-hyundai/releases/initial/server/src/server.js
sudo test -s /opt/lakshmi-hyundai/releases/initial/client/dist/index.html
id lakshmi-deploy
/usr/bin/node --version
```

The currently running service uses `initial`; the reported top-level `current` link points to `baseline-7fec106`, which has the legacy `backend/` and `frontend/` layout. Preserve that legacy release and `/opt/lakshmi-hyundai/releases/current` link. After confirming the inspected service still runs `initial` and the top-level link is either absent or points to that legacy baseline, point only the top-level link at the valid rollback release. This leaves both existing release directories untouched:

```bash
sudo ln -s /opt/lakshmi-hyundai/releases/initial /opt/lakshmi-hyundai/.current.next
sudo mv -Tf /opt/lakshmi-hyundai/.current.next /opt/lakshmi-hyundai/current
```

If inspection shows any other target or the `initial` validation fails, stop and investigate rather than replacing the link.

Install the service override and hardening drop-in as root, retaining any other existing drop-ins and environment settings:

```bash
sudo install -d -o root -g root -m 0755 \
  /etc/systemd/system/lakshmi-hyundai-backend.service.d
sudo install -o root -g root -m 0644 \
  deploy/systemd/lakshmi-hyundai-backend-current.conf \
  /etc/systemd/system/lakshmi-hyundai-backend.service.d/20-current-release.conf
sudo install -o root -g root -m 0644 \
  deploy/systemd/lakshmi-hyundai-backend-hardening.conf \
  /etc/systemd/system/lakshmi-hyundai-backend.service.d/30-readonly.conf
```

The override sets the required `WorkingDirectory=/opt/lakshmi-hyundai/current/server`, `ExecStart=/usr/bin/node src/server.js`, `User/Group=lakshmi-deploy`, and existing environment-file path. It does not contain or replace environment values. Review the effective unit and validate before the deployment job is enabled:

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/lakshmi-hyundai-backend.service
sudo systemctl cat lakshmi-hyundai-backend.service
sudo systemctl show lakshmi-hyundai-backend.service \
  -p User -p Group -p WorkingDirectory -p ExecStart -p EnvironmentFiles
```

Keep `/opt/lakshmi-hyundai/shared/backend.env` and its values intact. It should remain root-owned and inaccessible to the `lakshmi-deploy` login; systemd reads it before starting the service. Never print it, copy it into a release, or place secrets in a unit drop-in.

### Nginx configuration

In the existing HTTPS virtual host for `lakshmi-hyundai-crm.tech` and `www.lakshmi-hyundai-crm.tech`, change only the SPA root to the repository-owned fragment:

```nginx
root /opt/lakshmi-hyundai/current/client/dist;
```

The fragment is `deploy/nginx/lakshmi-hyundai-crm-root.conf`. Preserve the existing domain names, TLS/SSL directives, `/api/` proxy to `http://127.0.0.1:4000`, proxy headers, security settings, and SPA `try_files` fallback. Do not replace the VPS virtual-host file with a generic template.

Validate the edited site before enabling deployment:

```bash
sudo nginx -t
sudo nginx -T 2>&1 | grep -E 'server_name|root |proxy_pass|try_files'
```

Verify that the effective config retains both hostnames, the `current/client/dist` root, the existing `/api/` proxy target, and the SPA fallback. The deployment script repeats `systemd-analyze verify` and `nginx -t` before activation and reloads Nginx only after switching `current`.

### Release directory and trusted deployment controls

Provision `/opt/lakshmi-hyundai/incoming` and `/opt/lakshmi-hyundai/releases` so the existing `lakshmi-deploy` account can upload/create new release directories and atomically update the `releases/previous` pointer, while the root-owned helper seals releases. Do not chown, rename, or delete `initial`, `baseline-7fec106`, or any backup.

Install root-owned, non-writable copies of the helper, migration verifier, public key, database identity file, and all migration systemd templates. Install the root-owned restricted sudoers entry naming only `/usr/local/sbin/lakshmi-hyundai-deploy-control`; the helper permits only fixed validated actions (seal, activate a direct release child, validate configuration, restart/reload/status, and release-scoped migration actions). Do not grant direct `systemctl`, shell, or arbitrary root commands. Run `visudo -cf` and `systemd-analyze verify` on the installed units.

Install migration templates from `deploy/systemd/` under `/etc/systemd/system/` and run `daemon-reload`. Migration units use `/opt/lakshmi-hyundai/releases/%i/server`; the instance is the exact 40-character commit SHA. Keep authorization replay state and the Ed25519 public key root-owned. The migration guard verifies the configured database identity and Prisma history/checksums. Production deploys never run `db push`, reset, seed, or automatic startup repairs.

The deployment and backend processes share the same Unix account. Systemd read-only/private filesystem restrictions, root-sealed releases, protected helpers and configuration, and keeping the SSH private key only in GitHub reduce exposure, but cannot eliminate same-UID process inspection risk. Do not claim Unix identity isolation between the backend and SSH session.

### SSH and first deployment

Append the restricted deployment public key to the existing `lakshmi-deploy` `authorized_keys` only after reviewing existing entries. Preserve the account UID/GID, home, SSH ownership/configuration, and all existing authorized keys. The private key remains a GitHub Environment secret, never on the VPS.

Before the first approved deployment, verify:

- The top-level `current` symlink points to the active valid `initial` server/client release.
- Effective systemd service uses `current/server` and the existing shared environment file.
- Nginx serves `current/client/dist` and still proxies `/api/` to port 4000 with HTTPS and SPA fallback unchanged.
- Root helper, sudoers, release directories, migration verifier/keys, and systemd templates are installed and validated.
- `/usr/bin/node --version` is exactly `v24.22.2`.

No VPS provisioning, existing-release modification, production database operation, migration, or deployment is part of repository validation.

## Deployment and recovery commands

Use the approved GitHub Actions production job as the deployment entry point; do not invoke the release script directly on the VPS because that would bypass the workflow’s approval boundary. From the repository checkout, request a normal deployment of a full commit SHA already merged to `main`:

```bash
gh workflow run deploy.yml --ref main \
  --field deploy_sha=<FULL_40_CHARACTER_COMMIT_SHA> \
  --field apply_migrations=false
```

GitHub will then require the configured `production` Environment approval. Applying migrations requires a separate manual run with `apply_migrations=true`, the same environment approval, and a valid short-lived signed authorization.

After runtime preflight, the approved job transfers the archive and safe extractor, then executes the repository deployment script remotely with the checked-out SHA for both the release directory and commit marker:

```bash
ssh -F "$RUNNER_TEMP/lhcrm-ssh/config" production-vps \
  "bash -s -- '$RELEASE_ID' '$DEPLOY_SHA' '$APPLY_MIGRATIONS'" \
  < deploy/deploy-release.sh
```

Here `RELEASE_ID` must equal the approved full `DEPLOY_SHA`; the archive and extractor must already be staged under `/opt/lakshmi-hyundai/incoming/`. Do not bypass the approved workflow to deploy a different commit.

The workflow runs recovery on failed or uncertain SSH outcomes:

```bash
ssh -F "$RUNNER_TEMP/lhcrm-ssh/config" production-vps \
  "bash -s -- '$RELEASE_ID'" < deploy/recover-release.sh
```

Manual rollback after inspection:

```bash
ssh -F "$RUNNER_TEMP/lhcrm-ssh/config" production-vps \
  'bash -s' < deploy/rollback-release.sh
```

Rollback changes the application only; it does not reverse database migrations. Keep both active and previous application versions compatible with any expanded schema.

## Service contact status rollout

The `20261114000000_service_contact_status` migration adds nullable vehicle status columns and a nullable unique appointment request key. It does not backfill historical calls; existing rows remain intact. The new Prisma client can select these columns even when `SERVICE_CONTACT_STATUS_ENABLED=false`, so **the migration must be applied before this release is activated**. Older application code can use the expanded schema; rollback does not remove it.

1. Review all changes included in the exact release commit, including the unrelated performance and workshop-graph changes, and verify CI for that commit. CI exercises this migration against existing test rows and runs the service status workflow integration test on disposable PostgreSQL. These checks do not substitute for testing against a production-like restored copy.
2. Before approval, verify a recent, restorable database backup and rehearse the migration and rollback-release compatibility on a representative isolated restore. Review the existing service-classification audit and any other pending migrations; the workflow applies **all** pending committed migrations, not only this one. Stop if an unexpected migration is pending or the prior release is incompatible.
3. Keep `SERVICE_CONTACT_STATUS_ENABLED` unset or `false`. Pushes to `main` start an approval-gated deployment with migrations disabled; an unapplied migration blocks activation. After the commit is on `main`, use the approved manual workflow with `apply_migrations=true` for that exact SHA. The existing preflight and signed authorization must succeed before migration and activation. Do not edit the database or bypass the workflow to force activation.
4. With the feature still off, verify startup and health checks, login, Master Call List, due lists, follow-ups and appointment creation using authorized test records. Confirm migration status using the existing controlled workflow; do not expose credentials or customer data in logs.
5. In a separately approved change, set `SERVICE_CONTACT_STATUS_ENABLED=true` in the protected shared backend environment without printing or replacing unrelated values, then restart the backend through the existing operational procedure. Verify a new contacted call, a follow-up, and a successfully booked service-call appointment appear consistently in Master and the active due list, in Pending → Contacted → Follow-up → Appointment order across pages. Confirm a failed booking does not set Appointment and that other teams cannot access the test records.
6. If verification fails, set the flag back to `false` and restart; use the documented application recovery procedure if needed. Do not drop the new columns or reverse the migration during application rollback. Actions taken while the flag is off are not backfilled and status changes made while it was on remain stored; document and review any resulting gaps before re-enabling.

No production backup, migration, environment change, deployment, or smoke test is performed by preparing this repository.
