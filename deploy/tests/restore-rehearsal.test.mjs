import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDatabaseIdentity, validateExpectedDatabaseIdentity } from '../database-identity.mjs';

const script = readFileSync(new URL('../restore-rehearsal.ps1', import.meta.url), 'utf8');
const normalize = readFileSync(new URL('../restore-rehearsal-normalize.sql', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../restore-rehearsal-evidence.sql', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../../docs/PHASE7-BACKUP-RESTORE-REHEARSAL.md', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../restore-rehearsal-runtime.js', import.meta.url), 'utf8');

const parseDockerCommands = () => {
  const command = `
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:REHEARSAL_SCRIPT, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] -and $x.GetCommandName() -eq 'docker' }, $true) |
      ForEach-Object { [pscustomobject]@{ arguments = @($_.CommandElements | ForEach-Object { $_.Extent.Text }) } }) | ConvertTo-Json -Depth 5 -Compress
  `;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, REHEARSAL_SCRIPT: fileURLToPath(new URL('../restore-rehearsal.ps1', import.meta.url)) },
  })).map(({ arguments: args }) => args);
};

test('restore rehearsal is print-only unless Execute is explicitly supplied', () => {
  assert.match(script, /\[switch\]\$Execute/);
  assert.match(script, /if \(-not \$Execute\)/);
  assert.match(script, /No container, restore, migration or database command was executed/);
});

test('backup size and SHA-256 are fail closed', () => {
  assert.match(script, /\$expectedSize = \[int64\]246252251/);
  assert.match(script, /\$expectedSha256 = '7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234'/);
  assert.match(script, /Backup size mismatch/);
  assert.match(script, /Backup SHA-256 mismatch/);
});

test('PostgreSQL and Node images are pinned to Linux/AMD64 digest references', () => {
  assert.match(script, /\$postgresDigest = 'postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42'/);
  assert.match(script, /\$nodeDigest = 'node@sha256:6b9d4ea31e614e29f364bf75758458731eb1e105b80c99667438dd6b3fe262e0'/);
  assert.match(script, /\-\-internal/);
  assert.match(script, /--name \$postgresName/);
  assert.match(script, /-network \$networkName/);
});

test('restore normalization is explicitly no-owner and no-privileges', () => {
  assert.match(script, /--no-owner/);
  assert.match(script, /--no-privileges/);
  assert.match(script, /--clean --if-exists/);
  assert.match(script, /source-owner-acl-evidence.txt/);
});

test('normalized ownership and runtime grants are isolated to synthetic roles', () => {
  assert.match(normalize, /ALTER SCHEMA public OWNER TO migration_login/);
  assert.match(normalize, /OWNER TO migration_login/);
  assert.match(normalize, /GRANT USAGE ON SCHEMA/);
  assert.match(normalize, /REVOKE CREATE ON SCHEMA/);
  assert.match(normalize, /TO runtime_login/);
  assert.match(normalize, /REVOKE ALL ON TABLE .*runtime_login/);
});

test('evidence query inventories row counts, RLS, triggers and migration history', () => {
  assert.match(evidence, /FROM pg_stat_activity/);
  assert.match(evidence, /FROM pg_policies/);
  assert.match(evidence, /FROM pg_trigger/);
  assert.match(evidence, /_prisma_migrations/);
  assert.match(evidence, /count\(\*\)/);
});

test('cleanup removes only exact rehearsal resources in every execution path', () => {
  assert.match(script, /finally \{/);
  assert.match(script, /docker rm -f \$postgresName/);
  assert.match(script, /docker rm -f \$nodeContainer/);
  assert.match(script, /docker volume rm \$volumeName/);
  assert.match(script, /docker network rm \$networkName/);
  assert.match(script, /\$runId = \[guid\]::NewGuid\(\)/);
  assert.match(script, /verification_commands_succeeded=\$verified/);
  assert.match(script, /\$passed = \$verified -and -not \(\$postgresExists -or \$nodeExists -or \$volumeExists -or \$networkExists\)/);
  assert.match(script, /if \(-not \$passed\) \{ Fail 'Cleanup verification failed/);
  assert.ok(script.indexOf('$nodeContainer = ') < script.indexOf('try {'));
  assert.match(script, /\$containerListExit = \$volumeListExit = \$networkListExit = -1/);
  assert.match(script, /\$containerListExit -eq 0 -and \$volumeListExit -eq 0 -and \$networkListExit -eq 0/);
});

test('PowerShell AST has valid Docker run and createdb arguments with no embedded assignments', () => {
  const commands = parseDockerCommands();
  assert.ok(commands.length > 20);
  for (const args of commands) {
    assert.ok(!args.includes('='), `embedded assignment in Docker command: ${args.join(' ')}`);
  }
  const pgRun = commands.find((args) => args[1] === 'run' && args.includes('$postgresName'));
  assert.ok(pgRun);
  assert.equal(pgRun.at(-1), '$postgresDigest');
  const nodeRun = commands.find((args) => args[1] === 'run' && args.includes('$nodeContainer'));
  assert.deepEqual(nodeRun.slice(-4), ['$nodeDigest', 'sh', '-c', '"tail -f /dev/null"']);
  const createDb = commands.find((args) => args.includes('createdb'));
  assert.deepEqual(createDb.slice(-5), ['$postgresName', 'createdb', '-U', 'postgres', '$databaseName']);
  assert.ok(script.indexOf('$postgresStartLog = ') < script.indexOf('docker run --detach --name $postgresName'));
  assert.ok(script.indexOf('$createDatabaseLog = ') < script.indexOf('    createdb -U postgres'));
});

test('literal Linux shell commands parse without executing them', {
  skip: !existsSync('C:\\Program Files\\Git\\usr\\bin\\sh.exe') && 'Git sh is unavailable',
}, () => {
  const command = `
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:REHEARSAL_SCRIPT, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] -and $x.GetCommandName() -eq 'docker' }, $true) |
      ForEach-Object {
        $elements = $_.CommandElements
        for ($i = 0; $i -lt $elements.Count - 2; $i++) {
          if ($elements[$i].Extent.Text -eq 'sh' -and $elements[$i+1].Extent.Text -eq '-c' -and
              $elements[$i+2] -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            [pscustomobject]@{ value = $elements[$i+2].Value }
          }
        }
      }) | ConvertTo-Json -Compress
  `;
  const commands = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, REHEARSAL_SCRIPT: fileURLToPath(new URL('../restore-rehearsal.ps1', import.meta.url)) },
  }));
  assert.ok(commands.length >= 3);
  for (const { value } of commands) {
    execFileSync('C:\\Program Files\\Git\\usr\\bin\\sh.exe', ['-n'], { input: value });
  }
});

test('all required evidence and migration commands check the immediately preceding exit code', () => {
  const checks = [
    [/pg_restore --list --file=- \$containerBackup \*> \$archiveListLog/, 'Backup archive inspection failed'],
    [/-f \/tmp\/restore-rehearsal-evidence\.sql \*> \$evidenceLog/, 'Evidence SQL failed'],
    [/check-prisma-migrations\.mjs status \*> \$migrationStatusLog/, 'Migration status failed'],
    [/check-prisma-migrations\.mjs preflight \*> \$migrationPreflightLog/, 'Migration preflight failed'],
    [/index\.js migrate status \*> \$prismaStatusLog/, 'Prisma status failed'],
    [/index\.js migrate deploy \*> \$prismaDeployLog/, 'Prisma deploy failed'],
    [/restore-rehearsal-runtime\.js \*> \$runtimePrismaLog/, 'Runtime verification failed'],
  ];
  assert.match(script, /if \(\$ExitCode -ne 0\) \{ Fail/);
  for (const [command, message] of checks) {
    const match = command.exec(script);
    assert.ok(match, `${message}: command missing`);
    const followingLine = script.slice(match.index + match[0].length).split(/\r?\n/)[1];
    assert.ok(followingLine.includes(`Assert-ExitCode $LASTEXITCODE '${message}'`), `${message}: not checked immediately`);
  }
});

test('missing, empty or incomplete collector evidence blocks before Docker or restore', () => {
  const gate = script.indexOf("Fail 'BLOCKED: a nonempty source ownership, ACL and default-privilege evidence file");
  assert.ok(gate > 0);
  assert.ok(gate < script.indexOf('docker image inspect'));
  assert.ok(gate < script.indexOf('pg_restore --exit-on-error --clean'));
  assert.match(script, /-not \$SourceEvidencePath -or/);
  assert.match(script, /-not \(Test-Path -LiteralPath \$SourceEvidencePath -PathType Leaf\)/);
  assert.match(script, /\(Get-Item -LiteralPath \$SourceEvidencePath\)\.Length -eq 0/);
  for (const section of [
    'Application schemas and ownership',
    'Tables, partitioned tables, views and materialized views',
    'Table relation ACLs and PUBLIC privileges',
    'Sequence ownership',
    'Sequence ACLs and PUBLIC privileges',
    'Schema ACLs and PUBLIC privileges',
    'Function ownership and execution mode',
    'Function ACLs and PUBLIC privileges',
    'Type ownership and ACLs',
    'Default privileges',
  ]) {
    assert.ok(script.includes(`=== ${section} ===`), `missing evidence section: ${section}`);
  }
  assert.match(script, /if \(-not \$sourceEvidence\.Contains\(\$section\)\)/);
  assert.match(script, /source evidence does not show completion of the read-only collection/);
  assert.ok(script.indexOf('foreach ($section in $requiredSections)') < script.indexOf('docker image inspect'));
});

test('documentation preserves source evidence and no-credential requirements', () => {
  assert.match(docs, /246252251/);
  assert.match(docs, /7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234/);
  assert.match(docs, /--no-owner/);
  assert.match(docs, /--no-privileges/);
  assert.match(docs, /No published PostgreSQL port/);
  assert.doesNotMatch(docs, /postgres(?:ql)?:\/\/[^`]*:[^`]*@/);
});

test('real precheck is mounted with ESM dependencies and a separate active baseline', () => {
  assert.match(script, /source=\$RepositoryRoot\\deploy,target=\/work\/deploy,readonly/);
  assert.match(script, /source=\$RepositoryRoot\\server\\node_modules,target=\/work\/node_modules,readonly/);
  assert.match(script, /node \/work\/deploy\/check-prisma-migrations\.mjs status/);
  assert.match(script, /node \/work\/deploy\/check-prisma-migrations\.mjs preflight/);
  assert.match(script, /source=\$ActiveMigrationBaselinePath,target=\/work\/active-migrations,readonly/);
  assert.match(script, /ln -s \/work\/active-migrations \/opt\/lakshmi-hyundai\/current\/server\/prisma\/migrations/);
  assert.ok(script.indexOf('an independently verified active-release migration baseline') < script.indexOf('docker image inspect'));
});

test('synthetic identity is accepted by the unmodified helper and mismatches fail', () => {
  const expected = validateExpectedDatabaseIdentity({
    database: 'lakshmi_hyundai_crm', host: '172.29.0.2', port: 5432, username: 'migration_login',
  });
  const url = new URL('postgresql://migration_login:synthetic@172.29.0.2:5432/lakshmi_hyundai_crm');
  const actual = {
    session_user: 'migration_login', current_user: 'migration_login', database: expected.database,
    server_address: expected.host, server_port: 5432, rolsuper: false, rolinherit: false,
    rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
    rolcanlogin: true, membership_count: 0,
  };
  assert.doesNotThrow(() => assertDatabaseIdentity(url, actual, expected));
  for (const [key, value] of Object.entries({
    current_user: 'runtime_login', server_address: '172.29.0.3', server_port: 5433,
    rolinherit: true, rolsuper: true, rolbypassrls: true, rolcreaterole: true,
    rolcreatedb: true, rolreplication: true, rolcanlogin: false, membership_count: 1,
  })) assert.throws(() => assertDatabaseIdentity(url, { ...actual, [key]: value }, expected), key);
  assert.match(script, /\$databaseName = 'lakshmi_hyundai_crm'/);
  assert.match(script, /host = \$postgresIp/);
  assert.match(script, /--format '\{\{range \.NetworkSettings\.Networks\}\}\{\{\.IPAddress\}\}\{\{end\}\}'/);
  assert.match(script, /@\$\{postgresIp\}:5432\/\$databaseName/);
});

test('backup staging has verified capacity, checksum, read-only copy and fail-fast restore', () => {
  assert.match(script, /--tmpfs \/tmp:rw,noexec,nosuid,size=1024m/);
  assert.match(script, /\$4 < 786432/);
  assert.match(script, /\$4 < 4194304/);
  assert.match(script, /chmod 0444 '\$containerBackup'/);
  assert.match(script, /sha256sum -c -/);
  assert.match(script, /pg_restore --exit-on-error --clean/);
  assert.ok(script.indexOf('PostgreSQL tools, version or minimum free storage check failed') < script.indexOf('docker cp $BackupPath'));
  assert.ok(script.indexOf('Copied backup checksum or read-only permission check failed') < script.indexOf('pg_restore --exit-on-error'));
});

test('normalization rejects unsupported objects, skips dependent types and is atomic', () => {
  assert.match(normalize, /^BEGIN;/);
  assert.match(normalize, /COMMIT;\s*$/);
  assert.match(normalize, /pg_extension WHERE extname <> 'plpgsql'/);
  assert.match(normalize, /p\.prokind <> 'f'/);
  assert.match(normalize, /element\.typarray = t\.oid/);
  assert.match(normalize, /t\.typrelid = 0 OR c\.relkind = 'c'/);
  assert.match(normalize, /WHEN type_row\.typtype = 'd' THEN 'DOMAIN'/);
  assert.doesNotMatch(normalize, /EXCEPTION WHEN undefined_object/);
  assert.match(script, /node --version.*v24\.22\.2/);
  assert.match(script, /pg_config --version.*PostgreSQL 18\.6/);
  assert.match(script, /Node tools or Linux dependencies failed validation/);
  assert.match(runtime, /error\.code !== "42501"/);
  assert.match(runtime, /row\.membership_count !== 0/);
});
