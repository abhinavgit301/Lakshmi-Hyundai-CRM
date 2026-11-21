# Phase 7 production DBA evidence preparation

This procedure is read-only and planning-only until Gate A is approved.

## Execution environment

- PostgreSQL catalog queries run locally on the VPS through `sudo -u postgres psql`,
  or through an existing PostgreSQL container as an authenticated database DBA.
- `collect-phase7-dba-evidence.sh` must run on the VPS Linux shell.
- The script does not accept passwords or database URLs.
- Windows PowerShell is optional only for copying/redacting evidence after collection.
- No command in this procedure prints credentials or `pg_stat_activity.query`.

## Print-only verification

From the repository root:

```bash
bash deploy/collect-phase7-dba-evidence.sh \
  --database lakshmi_hyundai_crm \
  --output /tmp/phase7-dba-evidence
```

This print-only invocation does not execute `psql`.

## Authorized read-only execution

After Gate A approval:

```bash
sudo -u postgres \
  bash deploy/collect-phase7-dba-evidence.sh \
  --database lakshmi_hyundai_crm \
  --output /var/tmp/phase7-dba-evidence \
  --execute-read-only
```

The script creates mode `0700` output storage and mode `0600` evidence files.
The SQL starts `BEGIN TRANSACTION READ ONLY` and contains no DDL or DML.

## Protected identity-file finding

The migration units run as `lakshmi-deploy`. The database identity helper is
executed in that process and reads `/etc/lakshmi-hyundai/database-identity.json`
directly.

Root-owned mode `0600` is not readable by `lakshmi-deploy`.

The minimum secure installation for that existing policy is:

- Owner: `root`
- Group: `lakshmi-deploy`
- Proposed ownership notation: `root:lakshmi-deploy`
- Mode: `0640`
- Regular file
- No group/other write

This change is not implemented by this procedure.

## Source-vs-restored-evidence rule

Before any restore:

- Preserve the original custom archive.
- Preserve its size and SHA-256.
- Collect source ownership, ACLs and default privileges separately.
- Restore with `--no-owner --no-privileges` only into a disposable database.
- Recreate synthetic roles, owners and grants independently.
- Never infer source ownership from the normalized restore.

Expected backup verification:

```bash
stat -c '%n %s bytes' \
  /opt/lakshmi-hyundai/backups/pre-last-service-date-migration-20261105.dump

sha256sum \
  /opt/lakshmi-hyundai/backups/pre-last-service-date-migration-20261105.dump
```

Expected size: `246252251`

Expected SHA-256:
`7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234`

## Network-isolated disposable rehearsal

The rehearsal container must use an internal Docker network and no published
PostgreSQL port:

```bash
docker network create --internal p7-rehearsal
docker volume create p7-rehearsal-pgdata

docker run --detach \
  --name p7-rehearsal-postgres \
  --network p7-rehearsal \
  --network-alias postgres \
  --platform linux/amd64 \
  --mount type=volume,source=p7-rehearsal-pgdata,target=/var/lib/postgresql \
  postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42
```

Restoration requires separate approval and synthetic credentials.

Cleanup only the named resources:

```bash
docker rm -f p7-rehearsal-postgres
docker volume rm p7-rehearsal-pgdata
docker network rm p7-rehearsal

docker ps -a --filter name=p7-rehearsal
docker volume ls --filter name=p7-rehearsal-pgdata
docker network ls --filter name=p7-rehearsal
```
