# GitHub Actions production deployment

This repository has independent `client/` and `server/` Node projects. The workflow at `.github/workflows/deploy.yml` runs CI for pushes to `main` and manual dispatches. Production is a separate job protected by the GitHub Environment named `production`. There is no deploy-on-push path that bypasses environment approval.

The workflow has not been used to deploy. Complete the VPS setup and GitHub configuration below, review the first release, and approve it in GitHub before any production change.

## 1. Architecture

1. The CI job checks out a main-branch commit, installs from both committed lockfiles, runs the server's existing test suite, and builds the client.
2. CI produces a release archive containing only `server/src`, the server package files, Prisma schema/config/migrations, the migration guard, `client/dist`, and a commit marker. The archive excludes `.env` files, dependencies, tests, local databases, Git metadata, and backups.
3. The separate deployment job cannot start until CI succeeds. It declares `environment: production`; GitHub pauses the job until an authorized reviewer approves it.
4. After approval, the deployment job verifies SSH using the pinned known-hosts secret, copies the archive to the VPS, installs locked dependencies in a unique release, and runs `prisma generate`. It prunes development dependencies after any approved migration step.
5. By default, the deploy script runs `prisma migrate status` only. If that reports pending migrations, the release is not activated. An operator must manually dispatch the same commit with `apply_migrations: true`; after the separate Environment approval, the VPS runs `prisma migrate deploy` from that release.
6. Only after migration status/application and release preparation succeed does it atomically switch `releases/current`, restart `lakshmi-hyundai-backend.service`, and check the local API health endpoint.
7. GitHub checks the public HTTP-to-HTTPS frontend, HTTPS frontend, and HTTPS API. If those checks fail, the workflow switches back to the previous release and restarts the backend. Releases are never automatically pruned.

The stable Nginx document root is `/opt/lakshmi-hyundai/releases/current/frontend/dist`. Deployments change the symlink, not Nginx configuration, so Nginx does not need a reload per release. The one-time document-root change below requires `nginx -t` and a reload. TLS, proxy, and certificate configuration remain unchanged.

## 2. GitHub repository variables and secrets

Configure these values in **Settings → Secrets and variables → Actions**:

Repository variables:

| Name | Example/requirement |
|---|---|
| `VITE_API_BASE_URL` | Production HTTPS API base, ending in `/api/v1`, for example `https://crm.example.com/api/v1`. Confirm the actual production API URL with the VPS administrator; do not copy the development or Render URL without verification. |
| `PRODUCTION_FRONTEND_URL` | Public production website HTTPS URL, for example `https://crm.example.com`. |

Add these as **Environment secrets** under the `production` environment, not as repository-wide secrets:

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS DNS name or IP address (SSH port 22). |
| `VPS_USER` | Dedicated account `lhcrm-deploy`. |
| `VPS_SSH_PRIVATE_KEY` | Private half of the deployment-only Ed25519 SSH key. |
| `VPS_SSH_KNOWN_HOSTS` | Verified SSH host-key line(s) for `VPS_HOST`; never generate trust dynamically during a deployment. |

Do not put `DATABASE_URL`, backend `.env`, JWT keys, or passwords in GitHub. The migration unit reads the existing `/opt/lakshmi-hyundai/shared/backend.env` via systemd; the deployment account does not need direct access to that file.

## 3. Protect the production Environment

In **Repository Settings → Environments → New environment**, create `production`:

1. Enable required reviewers and add the production approver(s).
2. Enable **Prevent self-review** where available.
3. Disable administrator bypass if the repository plan offers that control.
4. Restrict deployment branches to `main`.
5. Add the four SSH secrets above to this environment.

The Environment approval gates every SSH/deployment operation. Database migrations have an additional explicit `workflow_dispatch` input, `apply_migrations`, defaulting to `false`. Push-triggered runs and manual runs without this checkbox only run the migration status guard; if pending migrations exist, deployment stops before changing `releases/current`. To apply them, manually dispatch the exact commit and set `apply_migrations: true`, then obtain the normal Environment approval. The guard verifies the database name, requires Prisma migration history, verifies checksums of applied migrations, and only allows unapplied migration folders added since the active release. Then it runs `prisma migrate deploy` from committed migrations only. It never runs `db push`, `migrate reset`, or seed commands on production. If existing production schema history has not been baselined for Prisma Migrate, the guard fails closed; resolve that with an explicit, reviewed administrator procedure before enabling migration deployment. Migration changes are not automatically rolled back if an application release is rolled back.

## 4. One-time VPS preparation

Run these commands from the VPS administrator console. First verify paths, service configuration, Nginx configuration, and the baseline release. These commands do not connect to or alter the database.

```bash
sudo systemctl cat lakshmi-hyundai-backend.service
sudo systemctl show lakshmi-hyundai-backend.service -p User -p Group -p ExecStart -p WorkingDirectory -p EnvironmentFiles
sudo nginx -T
sudo test -r /opt/lakshmi-hyundai/shared/backend.env
sudo test -d /opt/lakshmi-hyundai/releases/initial
sudo find /opt/lakshmi-hyundai/releases/initial -maxdepth 3 -type f \
  \( -path '*/backend/src/server.js' -o -path '*/frontend/dist/index.html' \) -print
```

The first rollout requires a valid rollback release with `backend/` and `frontend/dist/index.html`. For migration application, the active baseline must also contain the complete `backend/prisma/migrations/` history for that deployed version. Do not modify or overwrite `releases/initial`. If the existing `initial` directory is not already in this layout, have the VPS administrator create a separate baseline release from the currently running application and verify it before setting `current`. The migration guard refuses to apply if it cannot compare that baseline.

Create dedicated accounts if they do not already exist. Preserve an existing non-root backend account if the service already uses one; if using another account, update both the migration unit and the backend service override consistently.

```bash
sudo groupadd --system lhcrm-app 2>/dev/null || true
sudo useradd --system --gid lhcrm-app --home-dir /nonexistent \
  --shell /usr/sbin/nologin lhcrm-app 2>/dev/null || true
sudo groupadd --system lhcrm-deploy 2>/dev/null || true
sudo useradd --system --gid lhcrm-deploy --create-home --home-dir /var/lib/lhcrm-deploy \
  --shell /bin/bash lhcrm-deploy 2>/dev/null || true
sudo install -d -o lhcrm-deploy -g lhcrm-deploy -m 0755 \
  /opt/lakshmi-hyundai/incoming /opt/lakshmi-hyundai/releases
```

The deployment account should be the only non-root writer of `incoming/` and `releases/`; do not add `lhcrm-app` or Nginx to the `lhcrm-deploy` group. Do not grant the deployment user write access to `shared/`, `postgres/`, `backups/`, or the application root. The release script makes deployed files world-readable but not world-writable so the backend and Nginx can read without modifying them. The release script never removes a release.

If the verified baseline has the required release layout and is readable by the backend service user:

```bash
sudo -u lhcrm-deploy ln -s /opt/lakshmi-hyundai/releases/initial \
  /opt/lakshmi-hyundai/releases/current
sudo -u lhcrm-deploy test -r /opt/lakshmi-hyundai/releases/current/backend/src/server.js
sudo -u lhcrm-deploy test -r /opt/lakshmi-hyundai/releases/current/frontend/dist/index.html
sudo -u lhcrm-app test ! -w /opt/lakshmi-hyundai/releases
```

Create a restricted root-owned command wrapper and sudoers entry:

```bash
sudo install -o root -g root -m 0755 deploy/lhcrm-deploy-control \
  /usr/local/sbin/lhcrm-deploy-control
sudo visudo -f /etc/sudoers.d/lhcrm-deploy
```

The sudoers file should contain only:

```sudoers
lhcrm-deploy ALL=(root) NOPASSWD: /usr/local/sbin/lhcrm-deploy-control
Defaults:lhcrm-deploy !setenv
```

Validate it with `sudo visudo -cf /etc/sudoers.d/lhcrm-deploy`. The root-owned helper accepts only backend restart/status and a validated release ID for the fixed migration unit; do not grant unrestricted root or generic `systemctl` access.

Install the migration status and migration deployment units:

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/lakshmi-hyundai-migrate@.service \
  /etc/systemd/system/lakshmi-hyundai-migrate@.service
sudo install -o root -g root -m 0644 \
  deploy/systemd/lakshmi-hyundai-migrate-status@.service \
  /etc/systemd/system/lakshmi-hyundai-migrate-status@.service
```

Ensure `/usr/bin/node` is the production Node 22 executable (`command -v node`, `node --version`); adjust the `ExecStart` in this unit if Node is installed elsewhere. Validate and load the unit:

```bash
sudo systemd-analyze verify /etc/systemd/system/lakshmi-hyundai-migrate@.service \
  /etc/systemd/system/lakshmi-hyundai-migrate-status@.service
sudo systemctl daemon-reload
```

Configure the backend service to use the stable symlink. Use a systemd drop-in and retain all existing service environment settings; keep the existing `/opt/lakshmi-hyundai/shared/backend.env` unchanged. The example uses `lhcrm-app`; use the already verified service user/group if preserving an existing non-root account.

```bash
sudo systemctl edit lakshmi-hyundai-backend.service
```

Drop-in:

```ini
[Service]
User=lhcrm-app
Group=lhcrm-app
WorkingDirectory=/opt/lakshmi-hyundai/releases/current/backend
ExecStart=
ExecStart=/usr/bin/node /opt/lakshmi-hyundai/releases/current/backend/src/server.js
```

If the existing unit does not already load the shared environment, add this line to the drop-in:

```ini
EnvironmentFile=/opt/lakshmi-hyundai/shared/backend.env
```

Do not add or replace production environment values in the drop-in. Verify the effective unit before restarting:

```bash
sudo systemctl daemon-reload
sudo systemctl cat lakshmi-hyundai-backend.service
sudo systemctl show lakshmi-hyundai-backend.service -p User -p Group -p ExecStart -p WorkingDirectory -p EnvironmentFiles
```

In the existing HTTPS Nginx site, change only the SPA `root` directive to:

```nginx
root /opt/lakshmi-hyundai/releases/current/frontend/dist;
```

Keep the existing `server`, TLS certificate, API proxy, headers, and `try_files` behavior. Then validate and reload Nginx once:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Confirm the current site and API still work before adding the CI deployment key. Do not copy or replace TLS certificates.

### SSH key and host-key pinning

Generate a dedicated key on a trusted administrator workstation; do not commit the files:

```bash
ssh-keygen -t ed25519 -a 100 -C 'github-actions-lhcrm-deploy' \
  -f ./lhcrm-deploy-ed25519
```

Add only the public key to `/var/lib/lhcrm-deploy/.ssh/authorized_keys`, with forwarding and PTY disabled:

```text
restrict ssh-ed25519 AAAA... github-actions-lhcrm-deploy
```

Set ownership and permissions:

```bash
sudo install -d -o lhcrm-deploy -g lhcrm-deploy -m 0700 /var/lib/lhcrm-deploy/.ssh
sudo chown lhcrm-deploy:lhcrm-deploy /var/lib/lhcrm-deploy/.ssh/authorized_keys
sudo chmod 0600 /var/lib/lhcrm-deploy/.ssh/authorized_keys
sudo passwd -l lhcrm-deploy
```

In the VPS console, obtain the trusted host-key fingerprint:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the administrator workstation, collect the public key line, compare its fingerprint with the VPS-console value, and only then save the verified line as `VPS_SSH_KNOWN_HOSTS`:

```bash
ssh-keyscan -t ed25519 "$VPS_HOST" > ./lhcrm-known-hosts
ssh-keygen -lf ./lhcrm-known-hosts
```

`ssh-keyscan` is only a collection step; do not trust its result until the fingerprint matches through the trusted VPS console. Runtime deployment uses `StrictHostKeyChecking yes` and does not run `ssh-keyscan`.

## 5. CI and production deployment behavior

- CI uses Node.js 22, `npm ci` in each project, the existing `npm test` server suite, and `npm run build` in the client. A disposable PostgreSQL 18.6 service is used for tests that exercise Prisma. CI creates only that ephemeral test schema with `prisma db push --skip-generate`; this is not a production migration path. The build requires repository variable `VITE_API_BASE_URL` and verifies `client/dist/index.html`.
- Third-party actions are pinned to full commit SHAs in the workflow.
- Pushes to `main` run CI and then wait at the `production` environment approval gate.
- Manual runs must originate from `main`. Optionally supply `deploy_sha` with a full commit SHA that is already an ancestor of `origin/main`; CI tests and packages that exact commit. `apply_migrations` defaults to false and must be explicitly enabled to apply pending committed migrations.
- The production concurrency group serializes deployments and does not cancel an active deployment. CI runs for an outdated ref can be canceled.
- The workflow logs the selected commit SHA and unique release ID. It does not print secrets or backend environment values.
- Production feature flags and `backend.env` are never written by the workflow.
- Migration status is checked before switching. The default run will refuse a commit with pending migrations. With explicit manual input and Environment approval, the migration guard checks the expected database name, history table, prior checksums, and migration delta before applying. Migration failure leaves the active symlink and service unchanged. If a migration succeeds but later health checks fail, application rollback does not reverse database changes.
- Old release directories are never pruned automatically. Only the exact uploaded archive is removed after a successful deployment; failed uploads/releases remain for investigation.

## 6. Health checks and logs

The VPS script checks `http://127.0.0.1:4000/api/v1/health`, verifies the service is active, and checks recent logs for known startup-fatal messages before reporting the release as locally healthy. GitHub checks the frontend over HTTP (following the expected HTTPS redirect), checks the HTTPS site directly, and checks `${VITE_API_BASE_URL}/health` over HTTPS. A failed public check invokes the rollback script. If the production backend does not listen on port 4000, adjust the health URL in both release scripts to the verified local listener before provisioning.

For investigation on the VPS:

```bash
sudo systemctl status lakshmi-hyundai-backend.service --no-pager
sudo journalctl -u lakshmi-hyundai-backend.service -n 200 --no-pager
sudo journalctl -u 'lakshmi-hyundai-migrate@*.service' -n 200 --no-pager
sudo journalctl -u 'lakshmi-hyundai-migrate-status@*.service' -n 200 --no-pager
sudo readlink -f /opt/lakshmi-hyundai/releases/current
sudo readlink -f /opt/lakshmi-hyundai/releases/previous
```

Do not paste logs containing customer data or secrets into public issues or workflow output.

## 7. Rollback

Automatic application rollback switches `releases/current` to `releases/previous`, restarts the previous backend, and verifies its local health endpoint when deployment or public health checks fail. It retains both releases and all logs. Database changes are not automatically reversed.

To manually roll back after inspecting status, create a temporary SSH config using the same pinned host key and key file used by the workflow (host and user are read from this config rather than passed as command arguments):

```bash
cd /path/to/Lakshmi-Hyundai-CRM
cat > ./lhcrm-ssh-config <<'EOF'
Host production-vps
  HostName REPLACE_WITH_VPS_HOST
  User lhcrm-deploy
  IdentityFile ./lhcrm-deploy-ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ./lhcrm-known-hosts
  StrictHostKeyChecking yes
  BatchMode yes
EOF
chmod 600 ./lhcrm-ssh-config
ssh -F ./lhcrm-ssh-config production-vps \
  'bash -s' < deploy/rollback-release.sh
```

For a manual command, use a temporary SSH config with the same pinned host key and key restrictions as the workflow. Do not place a private key or password on a command line. The rollback script refuses to act if either pointer is missing, invalid, or outside `releases/`.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| CI refuses the frontend build | Confirm `VITE_API_BASE_URL` is an HTTPS URL ending in `/api/v1`. |
| Environment approval does not appear | Confirm the job targets the `production` Environment and the reviewer is an authorized required reviewer. |
| SSH host verification fails | Re-verify `VPS_SSH_KNOWN_HOSTS` against the VPS console fingerprint; do not disable strict checking. |
| SSH permission denied | Check account/key ownership, `authorized_keys` permissions, the locked password, and the restricted sudo wrapper. |
| Deployment says current release is invalid | Inspect `releases/current`; ensure it points to a verified baseline/release containing `backend/` and `frontend/dist/index.html`. |
| Migration fails | Inspect the migration systemd journal and database connectivity from the VPS. The release is not activated; investigate before rerunning. |
| Migration guard refuses the baseline | Verify the DB name is `lakshmi_hyundai_crm`, Prisma migration history/checksums are consistent, and `releases/current/backend/prisma/migrations` represents the deployed baseline. Do not bypass the guard; reconcile/baseline history through a separately reviewed DBA procedure. |
| Service fails after switching | The deploy script restores the previous symlink on local failure. Inspect `systemctl status`, `journalctl`, and both release pointers. |
| Public health check fails | Verify the HTTPS website/API URLs and Nginx upstream. Workflow attempts application rollback; it does not alter Nginx/TLS or database schema. |

## 9. First deployment checklist

1. Review the workflow, release scripts, committed migrations, and the exact `main` commit to be deployed.
2. Complete the VPS preparation and verify the backend, frontend, Nginx, existing shared environment, and baseline rollback target.
3. Configure `VITE_API_BASE_URL` and `PRODUCTION_FRONTEND_URL` repository variables.
4. Configure the `production` Environment with required reviewers and the four SSH secrets.
5. Push to `main` or manually dispatch from `main` with an optional already-merged `deploy_sha`.
6. Wait for backend tests and frontend build to pass; inspect test skip reasons and the packaged commit.
7. Review the pending production deployment and approve it only after confirming the commit and migrations.
8. For a release with pending migrations, stop and manually dispatch that exact commit with `apply_migrations: true`; do not rely on the push-triggered run to apply them.
9. Verify the backend unit, local health, public HTTP/HTTPS frontend, and API health. Confirm `releases/current` and `releases/previous`.

No deployment has been run as part of this implementation. The first production deployment must follow this checklist and receive explicit GitHub Environment approval.
