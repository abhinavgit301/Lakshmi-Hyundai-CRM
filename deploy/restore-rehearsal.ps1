[CmdletBinding()]
param(
  [string]$BackupPath = '/opt/lakshmi-hyundai/backups/pre-last-service-date-migration-20261105.dump',
  [string]$ToolRoot = 'D:\Projects\workshop CRM\phase7-design-a-tooling',
  [string]$RepositoryRoot = 'D:\Projects\workshop CRM\lakshmi-hyundai-crm',
  [string]$SourceEvidencePath = '',
  [string]$ActiveMigrationBaselinePath = '',
  [switch]$Execute
)

$expectedSize = [int64]246252251
$expectedSha256 = '7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234'
$postgresDigest = 'postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42'
$nodeDigest = 'node@sha256:6b9d4ea31e614e29f364bf75758458731eb1e105b80c99667438dd6b3fe262e0'
$runId = [guid]::NewGuid().ToString('N')
$networkName = "p7-restore-rehearsal-$runId"
$postgresName = "p7-restore-rehearsal-postgres-$runId"
$nodeContainer = "p7-restore-rehearsal-node-$runId"
$volumeName = "p7-restore-rehearsal-pgdata-$runId"
$databaseName = 'lakshmi_hyundai_crm'
$workspace = Join-Path (Join-Path $env:TEMP 'lhcrm-phase7-restore-rehearsal') $runId

function Fail([string]$message) {
  throw $message
}

function Assert-ExitCode([int]$ExitCode, [string]$FailureMessage, [string]$ExitFile = '') {
  if ($ExitFile) {
    $ExitCode.ToString() | Set-Content -Encoding ascii -ErrorAction Stop $ExitFile
  }
  if ($ExitCode -ne 0) { Fail "$FailureMessage (exit code $ExitCode)." }
}

if (-not $Execute) {
  Write-Output 'Print-only/preparation mode. No container, restore, migration or database command was executed.'
  Write-Output 'Required: -Execute after separate rehearsal authorization.'
  exit 0
}

$evidenceDirectory = Join-Path $workspace 'evidence'
$tempDirectory = Join-Path $workspace 'tmp'
New-Item -ItemType Directory -Force -Path $evidenceDirectory -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path $tempDirectory -ErrorAction Stop | Out-Null
$logDirectory = Join-Path $evidenceDirectory 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory -ErrorAction Stop | Out-Null

$networkAttempted = $false
$volumeAttempted = $false
$postgresAttempted = $false
$nodeAttempted = $false

try {
  if (-not $SourceEvidencePath -or
      -not (Test-Path -LiteralPath $SourceEvidencePath -PathType Leaf) -or
      (Get-Item -LiteralPath $SourceEvidencePath).Length -eq 0) {
    Fail 'BLOCKED: a nonempty source ownership, ACL and default-privilege evidence file is required before restore.'
  }
  $sourceEvidence = Get-Content -Raw -LiteralPath $SourceEvidencePath -ErrorAction Stop
  $requiredSections = @(
    '=== Application schemas and ownership ==='
    '=== Tables, partitioned tables, views and materialized views ==='
    '=== Table relation ACLs and PUBLIC privileges ==='
    '=== Sequence ownership ==='
    '=== Sequence ACLs and PUBLIC privileges ==='
    '=== Schema ACLs and PUBLIC privileges ==='
    '=== Function ownership and execution mode ==='
    '=== Function ACLs and PUBLIC privileges ==='
    '=== Type ownership and ACLs ==='
    '=== Default privileges ==='
  )
  foreach ($section in $requiredSections) {
    if (-not $sourceEvidence.Contains($section)) {
      Fail "BLOCKED: source evidence is missing the required section: $section"
    }
  }
  if ($sourceEvidence -notmatch '(?m)^COMMIT\s*$') {
    Fail 'BLOCKED: source evidence does not show completion of the read-only collection.'
  }
  Copy-Item -LiteralPath $SourceEvidencePath `
    -Destination (Join-Path $evidenceDirectory 'source-owner-acl-evidence.txt') -ErrorAction Stop

  if (-not $ActiveMigrationBaselinePath -or
      -not (Test-Path -LiteralPath $ActiveMigrationBaselinePath -PathType Container)) {
    Fail 'BLOCKED: an independently verified active-release migration baseline directory is required.'
  }
  $baseline = Get-Item -LiteralPath $ActiveMigrationBaselinePath -ErrorAction Stop
  if ($baseline.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Fail 'BLOCKED: the active-release migration baseline must not be a reparse point.'
  }
  foreach ($path in @(
    (Join-Path $RepositoryRoot 'deploy\check-prisma-migrations.mjs'),
    (Join-Path $RepositoryRoot 'deploy\database-identity.mjs'),
    (Join-Path $RepositoryRoot 'deploy\migration-policy.mjs'),
    (Join-Path $RepositoryRoot 'server\prisma.config.ts'),
    (Join-Path $RepositoryRoot 'server\prisma\schema.prisma'),
    (Join-Path $ToolRoot 'engines\schema-engine-debian-openssl-3.0.x')
  )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "BLOCKED: required file is missing: $path" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot 'server\node_modules') -PathType Container)) {
    Fail 'BLOCKED: Linux-compatible server dependencies are missing.'
  }

  if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
    Fail "Approved backup is unavailable: $BackupPath"
  }

  $backupLength = (Get-Item -LiteralPath $BackupPath).Length
  if ($backupLength -ne $expectedSize) {
    Fail "Backup size mismatch: expected $expectedSize bytes, found $backupLength."
  }

  $backupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupPath).Hash.ToLowerInvariant()
  if ($backupHash -ne $expectedSha256) {
    Fail "Backup SHA-256 mismatch: expected $expectedSha256, found $backupHash."
  }

  $imageNode = docker image inspect --format '{{.Os}}/{{.Architecture}}|{{json .RepoDigests}}' $nodeDigest
  if ($LASTEXITCODE -ne 0) { Fail 'Pinned Node image is unavailable locally.' }
  if ($imageNode -notmatch '^linux/amd64') { Fail 'Pinned Node image is not Linux/AMD64.' }

  $imagePostgres = docker image inspect --format '{{.Os}}/{{.Architecture}}|{{json .RepoDigests}}' $postgresDigest
  if ($LASTEXITCODE -ne 0) { Fail 'Pinned PostgreSQL image is unavailable locally.' }
  if ($imagePostgres -notmatch '^linux/amd64') { Fail 'Pinned PostgreSQL image is not Linux/AMD64.' }

  $backupHash | Set-Content -Encoding ascii -ErrorAction Stop (Join-Path $evidenceDirectory 'backup.sha256.txt')
  $backupLength.ToString() | Set-Content -Encoding ascii -ErrorAction Stop (Join-Path $evidenceDirectory 'backup.size.txt')

  $networkCreateLog = Join-Path $logDirectory 'network-create.log'
  $networkAttempted = $true
  docker network create --internal --driver bridge $networkName *> $networkCreateLog
  if ($LASTEXITCODE -ne 0) { Fail 'Could not create isolated rehearsal network.' }
  $networkInspectLog = Join-Path $logDirectory 'network-inspect.log'
  docker network inspect $networkName *> $networkInspectLog
  Assert-ExitCode $LASTEXITCODE 'Could not inspect isolated rehearsal network'
  $networkInternal = docker network inspect --format '{{.Internal}}' $networkName
  Assert-ExitCode $LASTEXITCODE 'Could not verify internal network'
  if ($networkInternal -ne 'true') { Fail 'Rehearsal network is not internal.' }

  $volumeCreateLog = Join-Path $logDirectory 'volume-create.log'
  $volumeAttempted = $true
  docker volume create $volumeName *> $volumeCreateLog
  if ($LASTEXITCODE -ne 0) { Fail 'Could not create rehearsal volume.' }

  $postgresStartLog = Join-Path $logDirectory 'postgres-start.log'
  $postgresAttempted = $true
  docker run --detach --name $postgresName `
    --platform linux/amd64 `
    --network $networkName `
    --network-alias postgres `
    --read-only `
    --tmpfs /tmp:rw,noexec,nosuid,size=1024m `
    --tmpfs /run:rw,noexec,nosuid,size=16m `
    --tmpfs /var/run/postgresql:rw,noexec,nosuid,size=16m `
    --mount "type=volume,source=$volumeName,target=/var/lib/postgresql" `
    --security-opt=no-new-privileges `
    --env POSTGRES_DB=postgres `
    --env POSTGRES_USER=postgres `
    --env POSTGRES_PASSWORD=synthetic-rehearsal-password `
    --env POSTGRES_HOST_AUTH_METHOD=scram-sha-256 `
    $postgresDigest *> $postgresStartLog
  if ($LASTEXITCODE -ne 0) { Fail 'Could not start disposable PostgreSQL.' }

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $pgIsReadyLog = Join-Path $logDirectory 'pg-isready.log'
    docker exec $postgresName pg_isready -U postgres -d postgres *> $pgIsReadyLog
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { Fail 'Disposable PostgreSQL did not become ready.' }

  $postgresIp = (docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $postgresName).Trim()
  Assert-ExitCode $LASTEXITCODE 'Could not inspect disposable PostgreSQL address'
  $parsedIp = $null
  if (-not [Net.IPAddress]::TryParse($postgresIp, [ref]$parsedIp) -or
      $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    Fail 'Disposable PostgreSQL did not have exactly one IPv4 address.'
  }
  $ports = docker inspect --format '{{json .HostConfig.PortBindings}}' $postgresName
  Assert-ExitCode $LASTEXITCODE 'Could not inspect PostgreSQL published ports'
  if ($ports -ne 'null' -and $ports -ne '{}') { Fail 'PostgreSQL has published ports.' }

  $prerequisiteLog = Join-Path $logDirectory 'postgres-prerequisites.log'
  docker exec $postgresName sh -c 'set -eu; for cmd in sh df awk sha256sum chmod pg_restore psql createdb pg_isready pg_config; do command -v "$cmd" >/dev/null; done; case "$(pg_config --version)" in "PostgreSQL 18.6"|"PostgreSQL 18.6 "*) ;; *) exit 1;; esac; df -Pk /tmp /var/lib/postgresql; df -Pk /tmp | awk ''NR==2 {if ($4 < 786432) exit 1} END {if (NR != 2) exit 1}''; df -Pk /var/lib/postgresql | awk ''NR==2 {if ($4 < 4194304) exit 1} END {if (NR != 2) exit 1}''' *> $prerequisiteLog
  Assert-ExitCode $LASTEXITCODE 'PostgreSQL tools, version or minimum free storage check failed'

  $createDatabaseLog = Join-Path $logDirectory 'create-database.log'
  docker exec -e PGPASSWORD=synthetic-rehearsal-password $postgresName `
    createdb -U postgres $databaseName *> $createDatabaseLog
  if ($LASTEXITCODE -ne 0) { Fail 'Could not create disposable rehearsal database.' }

  $containerBackup = '/tmp/pre-last-service-date-migration-20261105.dump'
  docker cp $BackupPath "${postgresName}:$containerBackup"
  if ($LASTEXITCODE -ne 0) { Fail 'Could not copy the verified backup into the disposable container.' }
  $backupContainerLog = Join-Path $logDirectory 'backup-container-verification.log'
  docker exec $postgresName sh -c "set -eu; chmod 0444 '$containerBackup'; printf '%s  %s\n' '$expectedSha256' '$containerBackup' | sha256sum -c -" *> $backupContainerLog
  Assert-ExitCode $LASTEXITCODE 'Copied backup checksum or read-only permission check failed'

  $archiveListLog = Join-Path $logDirectory 'archive-list.txt'
  docker exec $postgresName pg_restore --list --file=- $containerBackup *> $archiveListLog
  Assert-ExitCode $LASTEXITCODE 'Backup archive inspection failed'

  $restoreLog = Join-Path $logDirectory 'restore.log'
  docker exec -e PGPASSWORD=synthetic-rehearsal-password $postgresName pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges `
    --dbname $databaseName --username postgres $containerBackup *> $restoreLog
  if ($LASTEXITCODE -ne 0) { Fail 'Normalized disposable restore failed.' }

  $normalization = @(
    '--no-owner: original object ownership is not restored.'
    '--no-privileges: original table, sequence, function, schema, type and database ACLs are not restored.'
    '--clean --if-exists: only a disposable fresh database; no production target is touched.'
  )
  $normalization | Set-Content -Encoding utf8 -ErrorAction Stop (Join-Path $evidenceDirectory 'normalization.txt')

  $setupSql = @'
CREATE ROLE migration_login LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'synthetic-migration-password';
CREATE ROLE runtime_login LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'synthetic-runtime-password';
REVOKE ALL ON DATABASE lakshmi_hyundai_crm FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE lakshmi_hyundai_crm TO migration_login, runtime_login;
'@
  $syntheticRolesLog = Join-Path $logDirectory 'synthetic-roles.log'
  $setupSql | docker exec -i -e PGPASSWORD=synthetic-rehearsal-password $postgresName `
    psql -v ON_ERROR_STOP=1 -U postgres -d $databaseName *> $syntheticRolesLog
  if ($LASTEXITCODE -ne 0) { Fail 'Synthetic role setup failed.' }

  $normalizationSql = Join-Path $RepositoryRoot 'deploy\restore-rehearsal-normalize.sql'
  $normalizeLog = Join-Path $logDirectory 'normalize.log'
  Get-Content -Raw -LiteralPath $normalizationSql -ErrorAction Stop |
    docker exec -i -e PGPASSWORD=synthetic-rehearsal-password $postgresName `
      psql -v ON_ERROR_STOP=1 -U postgres -d $databaseName *> $normalizeLog
  if ($LASTEXITCODE -ne 0) { Fail 'Synthetic normalization failed.' }

  docker cp (Join-Path $RepositoryRoot 'deploy\restore-rehearsal-evidence.sql') "${postgresName}:/tmp/restore-rehearsal-evidence.sql"
  Assert-ExitCode $LASTEXITCODE 'Could not copy evidence SQL'
  $evidenceLog = Join-Path $logDirectory 'evidence.log'
  docker exec -e PGPASSWORD=synthetic-rehearsal-password $postgresName `
    psql -v ON_ERROR_STOP=1 -U postgres -d $databaseName `
    -f /tmp/restore-rehearsal-evidence.sql *> $evidenceLog
  Assert-ExitCode $LASTEXITCODE 'Evidence SQL failed'

  $postgresIsolationLog = Join-Path $logDirectory 'postgres-isolation.log'
  docker inspect --format '{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}|{{json .Mounts}}|{{json .Config.Image}}' $postgresName *> $postgresIsolationLog
  Assert-ExitCode $LASTEXITCODE 'PostgreSQL isolation inspection failed'
  $networkIsolationLog = Join-Path $logDirectory 'network-isolation.log'
  docker network inspect $networkName *> $networkIsolationLog
  Assert-ExitCode $LASTEXITCODE 'Network isolation inspection failed'

  $nodeStartLog = Join-Path $logDirectory 'node-start.log'
  $nodeAttempted = $true
  docker run --detach --name $nodeContainer `
    --platform linux/amd64 `
    --network $networkName `
    --read-only `
    --tmpfs /tmp:rw,noexec,nosuid,size=64m `
    --tmpfs /etc/lakshmi-hyundai:rw,noexec,nosuid,size=1m `
    --tmpfs /opt/lakshmi-hyundai:rw,noexec,nosuid,size=2m `
    --mount "type=bind,source=$ToolRoot,target=/work/tooling,readonly" `
    --mount "type=bind,source=$RepositoryRoot,target=/work/repository,readonly" `
    --mount "type=bind,source=$RepositoryRoot\deploy,target=/work/deploy,readonly" `
    --mount "type=bind,source=$RepositoryRoot\server\node_modules,target=/work/node_modules,readonly" `
    --mount "type=bind,source=$RepositoryRoot\server\node_modules,target=/work/repository/server/node_modules,readonly" `
    --mount "type=bind,source=$ActiveMigrationBaselinePath,target=/work/active-migrations,readonly" `
    --workdir /work/repository/server `
    --env PRISMA_SCHEMA_ENGINE_BINARY=/work/tooling/engines/schema-engine-debian-openssl-3.0.x `
    $nodeDigest sh -c "tail -f /dev/null" *> $nodeStartLog
  if ($LASTEXITCODE -ne 0) { Fail 'Could not start Node 24.22.2 rehearsal container.' }

  docker exec $nodeContainer sh -c 'set -eu; mkdir -p /opt/lakshmi-hyundai/current/server/prisma; ln -s /work/active-migrations /opt/lakshmi-hyundai/current/server/prisma/migrations' *> $null
  Assert-ExitCode $LASTEXITCODE 'Could not install read-only migration baseline'
  $nodePrerequisiteLog = Join-Path $logDirectory 'node-prerequisites.log'
  docker exec $nodeContainer sh -c 'set -eu; for cmd in sh node tail mkdir ln base64 chown chmod cmp; do command -v "$cmd" >/dev/null; done; test "$(node --version)" = v24.22.2; test -x /work/tooling/engines/schema-engine-debian-openssl-3.0.x; /work/tooling/engines/schema-engine-debian-openssl-3.0.x --version; test -r /work/deploy/check-prisma-migrations.mjs; test -d /opt/lakshmi-hyundai/current/server/prisma/migrations; cmp -s prisma/schema.prisma node_modules/.prisma/client/schema.prisma; node -e ''const fs=require("fs"); for (const [name,version] of [["pg","8.23.1"],["prisma","7.10.1"],["@prisma/client","7.10.1"],["@prisma/adapter-pg","7.10.1"]]) { if (JSON.parse(fs.readFileSync("node_modules/"+name+"/package.json")).version !== version) throw Error("Unexpected package version: "+name); if (name !== "prisma") require(name); } require("dotenv/config")''; node /work/repository/server/node_modules/prisma/build/index.js --version' *> $nodePrerequisiteLog
  Assert-ExitCode $LASTEXITCODE 'Node tools or Linux dependencies failed validation'

  $migrationUrl = "postgresql://migration_login:synthetic-migration-password@${postgresIp}:5432/$databaseName`?schema=public"
  $runtimeUrl = "postgresql://runtime_login:synthetic-runtime-password@${postgresIp}:5432/$databaseName`?schema=public"
  $identityJson = @{
    database = $databaseName
    host = $postgresIp
    port = 5432
    username = 'migration_login'
  } | ConvertTo-Json -Compress
  $identityBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($identityJson))

  docker exec $nodeContainer sh -c "mkdir -p /etc/lakshmi-hyundai && printf '%s' '$identityBase64' | base64 -d > /etc/lakshmi-hyundai/database-identity.json && chown 0:0 /etc/lakshmi-hyundai/database-identity.json && chmod 0600 /etc/lakshmi-hyundai/database-identity.json" *> $null
  Assert-ExitCode $LASTEXITCODE 'Could not install synthetic identity file'

  $migrationStatusLog = Join-Path $logDirectory 'migration-status.log'
  docker exec --env "MIGRATION_DATABASE_URL=$migrationUrl" $nodeContainer `
    node /work/deploy/check-prisma-migrations.mjs status *> $migrationStatusLog
  Assert-ExitCode $LASTEXITCODE 'Migration status failed' (Join-Path $logDirectory 'migration-status.exit')

  $migrationPreflightLog = Join-Path $logDirectory 'migration-preflight.log'
  docker exec --env "MIGRATION_DATABASE_URL=$migrationUrl" $nodeContainer `
    node /work/deploy/check-prisma-migrations.mjs preflight *> $migrationPreflightLog
  Assert-ExitCode $LASTEXITCODE 'Migration preflight failed' (Join-Path $logDirectory 'migration-preflight.exit')

  $prismaStatusLog = Join-Path $logDirectory 'prisma-status.log'
  docker exec --env "MIGRATION_DATABASE_URL=$migrationUrl" $nodeContainer `
    node /work/repository/server/node_modules/prisma/build/index.js migrate status *> $prismaStatusLog
  Assert-ExitCode $LASTEXITCODE 'Prisma status failed' (Join-Path $logDirectory 'prisma-status.exit')

  $prismaDeployLog = Join-Path $logDirectory 'prisma-deploy.log'
  docker exec --env "MIGRATION_DATABASE_URL=$migrationUrl" $nodeContainer `
    node /work/repository/server/node_modules/prisma/build/index.js migrate deploy *> $prismaDeployLog
  Assert-ExitCode $LASTEXITCODE 'Prisma deploy failed' (Join-Path $logDirectory 'prisma-deploy.exit')

  docker cp (Join-Path $RepositoryRoot 'deploy\restore-rehearsal-runtime.js') "${nodeContainer}:/tmp/restore-rehearsal-runtime.js"
  Assert-ExitCode $LASTEXITCODE 'Could not copy runtime verification script'
  $runtimePrismaLog = Join-Path $logDirectory 'runtime-prisma.log'
  docker exec --env "DATABASE_URL=$runtimeUrl" --env "NODE_PATH=/work/repository/server/node_modules" $nodeContainer `
    node /tmp/restore-rehearsal-runtime.js *> $runtimePrismaLog
  Assert-ExitCode $LASTEXITCODE 'Runtime verification failed' (Join-Path $logDirectory 'runtime-prisma.exit')
}
finally {
  if ($networkAttempted -or $volumeAttempted -or $postgresAttempted -or $nodeAttempted) {
    try { if ($nodeAttempted) { docker rm -f $nodeContainer 2>$null | Out-Null } } catch { Write-Warning 'Node container removal could not be attempted.' }
    try { if ($postgresAttempted) { docker rm -f $postgresName 2>$null | Out-Null } } catch { Write-Warning 'PostgreSQL container removal could not be attempted.' }
    try { if ($volumeAttempted) { docker volume rm $volumeName 2>$null | Out-Null } } catch { Write-Warning 'Volume removal could not be attempted.' }
    try { if ($networkAttempted) { docker network rm $networkName 2>$null | Out-Null } } catch { Write-Warning 'Network removal could not be attempted.' }

    $containers = @()
    $volumes = @()
    $networks = @()
    $containerListExit = $volumeListExit = $networkListExit = -1
    try {
      $containers = @(docker container ls -a --format '{{.Names}}' 2>$null)
      $containerListExit = $LASTEXITCODE
    } catch { Write-Warning 'Container cleanup verification could not be attempted.' }
    try {
      $volumes = @(docker volume ls --format '{{.Name}}' 2>$null)
      $volumeListExit = $LASTEXITCODE
    } catch { Write-Warning 'Volume cleanup verification could not be attempted.' }
    try {
      $networks = @(docker network ls --format '{{.Name}}' 2>$null)
      $networkListExit = $LASTEXITCODE
    } catch { Write-Warning 'Network cleanup verification could not be attempted.' }
    $verified = $containerListExit -eq 0 -and $volumeListExit -eq 0 -and $networkListExit -eq 0
    $postgresExists = $postgresName -in $containers
    $nodeExists = $nodeContainer -in $containers
    $volumeExists = $volumeName -in $volumes
    $networkExists = $networkName -in $networks
    $passed = $verified -and -not ($postgresExists -or $nodeExists -or $volumeExists -or $networkExists)

    $cleanupEvidence = Join-Path $evidenceDirectory 'cleanup.txt'
    @(
      "verification_commands_succeeded=$verified"
      "postgres_container_exists=$(if ($containerListExit -eq 0) { $postgresExists } else { 'unknown' })"
      "node_container_exists=$(if ($containerListExit -eq 0) { $nodeExists } else { 'unknown' })"
      "volume_exists=$(if ($volumeListExit -eq 0) { $volumeExists } else { 'unknown' })"
      "network_exists=$(if ($networkListExit -eq 0) { $networkExists } else { 'unknown' })"
      "cleanup_pass=$passed"
    ) | Set-Content -Encoding ascii -ErrorAction Stop $cleanupEvidence
    if (-not $passed) { Fail 'Cleanup verification failed or could not be completed.' }
  }
}
