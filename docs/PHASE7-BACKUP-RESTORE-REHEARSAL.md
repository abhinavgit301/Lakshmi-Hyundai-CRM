# Phase 7 isolated backup restore rehearsal

This package prepares a disposable PostgreSQL 18.6 rehearsal. It does not execute
the restore or start Docker containers by default.

## Required local prerequisites

- The verified dump at a path supplied with `-BackupPath`.
- Pinned Node image: `node@sha256:6b9d4ea31e614e29f364bf75758458731eb1e105b80c99667438dd6b3fe262e0`.
- Pinned PostgreSQL image: `postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42`.
- The acquired tooling directory, by default `D:\Projects\workshop CRM\phase7-design-a-tooling`.
- The CRM repository, by default `D:\Projects\workshop CRM\lakshmi-hyundai-crm`.
- Docker Desktop Linux engine.
- `server/node_modules` must contain Linux/AMD64-compatible dependencies and a
  Prisma client generated from the exact current `server/prisma/schema.prisma`.
  The runner checks `pg` 8.23.1, Prisma CLI, client and adapter 7.10.1,
  `dotenv/config`, the generated schema bytes, Node 24.22.2, and executable
  Linux schema engine. A Windows install is not evidence of Linux compatibility.
- `-ActiveMigrationBaselinePath` must point to a separately verified copy of
  the actual active release's `server/prisma/migrations` directory. It must not
  be reconstructed from the candidate release or inferred from the backup.
- The source ownership, ACL and default-privilege evidence file produced by
  `deploy/collect-phase7-dba-evidence.sh`. Before Docker use, the script
  requires its inventory section headers and completed transaction marker.
  These checks do not prove the evidence is genuine or complete; the database
  owner must review it.

**Not ready for rehearsal:** these checks and the normalization SQL have not
been run in PostgreSQL 18.6 against the restored schema. The actual backup,
baseline, extension/object inventory, Linux packages and image behavior require
review and isolated validation. No readiness or cleanup result is implied.

## Verification-only command

```powershell
powershell -ExecutionPolicy Bypass -File deploy/restore-rehearsal.ps1 `
  -BackupPath 'D:\path\pre-last-service-date-migration-20261105.dump'
```

This prints the preparation status and executes no Docker or restore command.

## Separate authorized execution command

This command must be used only after separate restore-rehearsal approval:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/restore-rehearsal.ps1 `
  -Execute `
  -BackupPath 'D:\path\pre-last-service-date-migration-20261105.dump' `
  -SourceEvidencePath 'D:\path\phase7-dba-evidence.txt' `
  -ActiveMigrationBaselinePath 'D:\path\verified-active-release\server\prisma\migrations'
```

## Backup integrity

Before every restore:

- Verify size `246252251`.
- Verify SHA-256 `7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234`.
- Never modify or delete the source backup.
- Preserve the source archive and hash evidence.
- The PostgreSQL `/tmp` is a 1 GiB tmpfs. The runner requires at least 768 MiB
  free there and 4 GiB free in the PostgreSQL data filesystem before copying
  the 246252251-byte archive. These are minimum checks, not a guarantee of
  sufficient space for an expanded restore, indexes, WAL or concurrent disk use.
- After copying, the container copy is mode 0444 and its SHA-256 is rechecked
  before inspection or restore. The original backup is not mounted or modified.

## Isolation

The script uses:

- A uniquely named Docker network with `--internal`.
- Uniquely named PostgreSQL and Node containers and PostgreSQL volume.
- No published PostgreSQL port.
- Synthetic passwords in container/environment variables only.
- Read-only PostgreSQL and Node container roots where supported.

## Normalization

The restore uses:

- `pg_restore --no-owner`: original object ownership is not restored.
- `pg_restore --no-privileges`: original ACLs, grants and default-privilege
  equivalents in the archive are not restored.
- `--clean --if-exists`: defensive disposable database recreation only.

After restore, the script:

- Creates synthetic `migration_login` and `runtime_login` roles.
- Reassigns non-system relation, sequence, view, function and type ownership
  to `migration_login`.
- Grants synthetic runtime DML/SELECT/sequence/function/type privileges.
- Revoke synthetic runtime migration-history and schema CREATE access.
- Runs normalization in one transaction; non-default extensions and
  non-function routines cause a stop for schema-specific review rather than
  guessing their ownership or grants. Generated array and table row types are
  not independently reassigned.

The normalized restore does not prove source ownership or source grants.
Source evidence must be supplied separately.
The synthetic grants are not a production grant design. SQL and ownership
assertions must still be tested against the actual restored objects.

## Identity and migration validation

The script mounts the actual repository `deploy` directory at `/work/deploy`
and the server dependencies at `/work/node_modules` so the unchanged ESM
precheck resolves `pg`. Its working directory is the candidate `server`
directory; the separately provided active baseline is read-only at the path
expected by the preflight. The helper requires database
`lakshmi_hyundai_crm`; both URLs and the root-owned mode-0600 synthetic
identity file use the inspected disposable PostgreSQL IPv4 address and port
5432. The helper verifies the live address and all Design A attributes.

The script stops on any nonzero status, including a pending-migration result
from the status precheck. Consequently a backup with pending migrations
currently stops before preflight and deploy; no bypass is provided. Runtime
identity and permission checks run only if all preceding checks succeed. The
runner does not independently establish Prisma migration-engine identity, and
does not yet prove runtime DML or all grants.

The script preserves migration and runtime credentials only in memory or
synthetic container environment variables. It does not print URLs or passwords.
Docker can expose synthetic environment variables to local privileged users.
Evidence and the restored database can contain sensitive CRM information;
restrict access and securely handle retained evidence.

## Evidence

The script writes evidence under a unique temporary run directory:

- Backup size and SHA-256.
- Archive list.
- Restore log.
- Synthetic role setup.
- Normalization SQL log.
- Schema/owner/row-count/RLS/trigger/migration evidence.
- Migration status/preflight/deploy logs.
- Runtime identity log.
- Container/network isolation logs.
- Cleanup verification.

## Cleanup

After resource creation is attempted, cleanup runs in `finally` and targets
only this run's unique container, volume and network names. It verifies all
four names are absent using successful Docker listing commands. If Docker
cannot be reached or any resource remains, cleanup is reported as failed;
manual investigation is required. Before any resource creation is attempted,
there is no Docker cleanup to verify.

The original backup is never deleted or modified.
