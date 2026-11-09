#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly INCOMING="$APP_ROOT/incoming"
readonly CURRENT="$APP_ROOT/current"
readonly PREVIOUS="$RELEASES/previous"
readonly STATE="$RELEASES/.deployment-state"
readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health
readonly FRONTEND_HOST=lakshmi-hyundai-crm.tech
readonly CONTROL=/usr/local/sbin/lakshmi-hyundai-deploy-control
readonly RELEASE_PATTERN='^[0-9a-f]{40}$'

release_id=${1:-}
commit_sha=${2:-}
apply_migrations=${3:-false}
if [[ ! "$release_id" =~ $RELEASE_PATTERN ||
      ! "$commit_sha" =~ ^[0-9a-f]{40}$ ||
      "$release_id" != "$commit_sha" ||
      ( "$apply_migrations" != true && "$apply_migrations" != false ) ]]; then
  echo "Release directory must be the exact requested 40-character commit SHA." >&2
  exit 2
fi

artifact="$INCOMING/$release_id.tar.gz"
extractor="$INCOMING/$release_id.safe-release-archive.mjs"
stage="$RELEASES/.staging-$release_id"
release="$RELEASES/$release_id"
lock_file="$RELEASES/.deploy.lock"
previous_target=
migration_state=not-started
deployment_succeeded=false
lock_acquired=false
stage_created=false
state_written=false

write_state() {
  local phase=$1 temporary
  temporary=$(mktemp "$RELEASES/.deployment-state.tmp.XXXXXX")
  printf '%s\t%s\t%s\t%s\n' "$release_id" "$previous_target" "$release" "$phase" > "$temporary"
  chmod 0600 "$temporary"
  state_written=true
  mv -fT "$temporary" "$STATE"
}

switch_release_pointer() {
  local target=$1 link=$2 temporary="${2}.next.${BASHPID}.${RANDOM}"
  ln -s "$target" "$temporary" || return 1
  mv -Tf "$temporary" "$link" || return 1
}

safe_release_target() {
  local target=$1 resolved releases_real
  resolved=$(readlink -f "$target") || return 1
  releases_real=$(readlink -f "$RELEASES") || return 1
  [[ "$(dirname "$resolved")" == "$releases_real" && -d "$resolved" ]] || return 1
  printf '%s' "$resolved"
}

validate_frontend_assets() {
  /usr/bin/node --input-type=module - "$1/client/dist" <<'NODE'
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.argv[2]);
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const references = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((match) => match[1]);
for (const reference of references) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) continue;
  const parsed = new URL(reference, pathToFileURL(path.join(dist, 'index.html')));
  const asset = path.resolve(dist, `.${decodeURIComponent(parsed.pathname)}`);
  if (asset !== dist && !asset.startsWith(`${dist}${path.sep}`)) {
    throw new Error(`Frontend asset path escapes dist/: ${reference}`);
  }
  if (!statSync(asset).isFile()) throw new Error(`Frontend asset is missing: ${reference}`);
}
NODE
}

validate_release() {
  local root=$1 expected_commit=$2 marker
  [[ -s "$root/RELEASE_COMMIT" &&
     -s "$root/server/src/server.js" &&
     -s "$root/server/package.json" &&
     -s "$root/server/package-lock.json" &&
     -s "$root/server/prisma.config.ts" &&
     -s "$root/server/prisma/schema.prisma" &&
     -d "$root/server/prisma/migrations" &&
     -s "$root/server/deploy/check-prisma-migrations.mjs" &&
     -s "$root/server/deploy/database-identity.mjs" &&
     -s "$root/server/node_modules/prisma/build/index.js" &&
     -s "$root/server/node_modules/@prisma/client/package.json" &&
     -s "$root/server/node_modules/@prisma/adapter-pg/package.json" &&
     -s "$root/client/package.json" &&
     -s "$root/client/package-lock.json" &&
     -s "$root/client/dist/index.html" ]] || {
    echo "Release is missing required server, Prisma, PostgreSQL adapter, or client files." >&2
    return 1
  }
  marker=$(<"$root/RELEASE_COMMIT")
  [[ "$marker" == "$expected_commit" ]] || {
    echo "Release marker does not match the requested commit." >&2
    return 1
  }
  (
    cd "$root/server"
    /usr/bin/node --input-type=module -e \
      'const { PrismaClient } = await import("@prisma/client"); if (typeof PrismaClient !== "function") throw new Error("Prisma Client export is unavailable"); const { PrismaPg } = await import("@prisma/adapter-pg"); if (typeof PrismaPg !== "function") throw new Error("PostgreSQL Prisma adapter export is unavailable");'
  )
  validate_frontend_assets "$root"
}

recover_locked() {
  local current_target previous_name restart_started_at
  current_target=$(safe_release_target "$CURRENT") || {
    echo "Recovery cannot resolve current release safely." >&2
    return 1
  }
  if [[ "$current_target" == "$release" ]]; then
    [[ -d "$previous_target/server" && -s "$previous_target/client/dist/index.html" ]] || {
      echo "Recovery target is incomplete; current release was not switched." >&2
      return 1
    }
    previous_name=${previous_target##*/}
    sudo -n "$CONTROL" activate-release "$previous_name" || return 1
    switch_release_pointer "$release" "$PREVIOUS" || return 1
    restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if ! sudo -n "$CONTROL" restart-backend ||
       ! sudo -n "$CONTROL" reload-nginx ||
       ! sudo -n "$CONTROL" backend-active ||
       ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
         --max-time 10 "$HEALTH_URL" --output /dev/null ||
       ! curl --silent --show-error --fail --resolve "$FRONTEND_HOST:443:127.0.0.1" \
         --max-time 10 "https://$FRONTEND_HOST/" --output /dev/null; then
      echo "Recovery selected the previous release but restart, reload, or health verification failed." >&2
      return 1
    fi
    if ! sudo -n "$CONTROL" startup-check "$restart_started_at"; then
      echo "Recovered release startup logs reported a failure." >&2
      return 1
    fi
    echo "Recovery restored and health-checked release $previous_target." >&2
  fi
  if [[ "$migration_state" == applied || "$migration_state" == uncertain ]]; then
    echo "WARNING: database migrations may have succeeded; application recovery does not restore the previous database schema. Verify application/schema compatibility." >&2
  fi
  rm -f -- "$STATE"
}

on_exit() {
  local result=$?
  trap - EXIT INT TERM HUP
  if [[ "$lock_acquired" == true && "$state_written" == true &&
        "$deployment_succeeded" != true && -n "$previous_target" ]]; then
    set +e
    if ! recover_locked; then
      echo "Automatic deployment recovery failed; preserve state at $STATE and run the recovery procedure." >&2
      result=1
    fi
  fi
  if [[ "$stage_created" == true && -d "$stage" && ! -L "$stage" ]]; then
    rm -rf -- "$stage" || {
      echo "Unable to remove this attempt's incomplete staging directory: $stage" >&2
      result=1
    }
  fi
  exit "$result"
}

if [[ ! -d "$RELEASES" || ! -d "$INCOMING" || ! -f "$APP_ROOT/shared/backend.env" ]]; then
  echo "Required VPS release directories or shared backend environment are missing." >&2
  exit 1
fi
if [[ ! -x /usr/bin/node || "$(/usr/bin/node --version)" != v24.22.2 ]]; then
  echo "The expected production Node.js runtime /usr/bin/node v24.22.2 is unavailable." >&2
  exit 1
fi
export PATH="/usr/bin:$PATH"
if [[ ! -x "$CONTROL" ]]; then
  echo "The restricted VPS deployment control helper is not installed." >&2
  exit 1
fi

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Another deployment or recovery is already running on the VPS." >&2
  exit 1
fi
lock_acquired=true
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [[ ! -L "$CURRENT" ]]; then
  echo "The top-level current symlink must be provisioned before deployment." >&2
  exit 1
fi
previous_target=$(safe_release_target "$CURRENT") || {
  echo "Current release is broken or resolves outside the releases directory." >&2
  exit 1
}
if [[ ! -d "$previous_target/server" || ! -s "$previous_target/client/dist/index.html" ]]; then
  echo "The active release is not a valid server/client rollback target." >&2
  exit 1
fi
if [[ -e "$STATE" || -L "$STATE" ]]; then
  echo "An unfinished deployment state already exists; recover it before deploying." >&2
  exit 1
fi

if [[ "$previous_target" == "$release" ]]; then
  validate_release "$release" "$commit_sha"
  sudo -n "$CONTROL" validate-config
  sudo -n "$CONTROL" backend-active
  curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
    --max-time 10 "$HEALTH_URL" --output /dev/null
  curl --silent --show-error --fail --resolve "$FRONTEND_HOST:443:127.0.0.1" \
    --max-time 10 "https://$FRONTEND_HOST/" --output /dev/null
  printf 'Commit %s is already active and healthy; no dependencies were reinstalled.\n' "$commit_sha"
  deployment_succeeded=true
  exit 0
fi

if [[ -e "$stage" || -L "$stage" ]]; then
  echo "An incomplete staging path already exists; preserve and inspect it before retrying." >&2
  exit 1
fi
write_state started
if [[ ! -f "$artifact" || -L "$artifact" ||
      ! -f "$extractor" || -L "$extractor" ]]; then
  echo "Release archive or safe extractor is missing or not a regular file." >&2
  exit 1
fi
printf 'Preparing approved commit %s as release %s\n' "$commit_sha" "$release_id"

if [[ -e "$release" || -L "$release" ]]; then
  [[ -d "$release" && ! -L "$release" ]] || {
    echo "Existing release path is not a real directory; refusing to overwrite it." >&2
    exit 1
  }
  validate_release "$release" "$commit_sha" || {
    echo "Existing release is incomplete; it will be preserved for inspection, not overwritten." >&2
    exit 1
  }
else
  mkdir -m 0750 "$stage"
  stage_created=true
  /usr/bin/node "$extractor" extract "$artifact" "$stage"
  [[ -s "$stage/RELEASE_COMMIT" && "$(<"$stage/RELEASE_COMMIT")" == "$commit_sha" &&
     -s "$stage/server/src/server.js" &&
     -s "$stage/server/package.json" &&
     -s "$stage/server/package-lock.json" &&
     -s "$stage/server/deploy/check-prisma-migrations.mjs" &&
     -s "$stage/server/prisma.config.ts" &&
     -s "$stage/server/prisma/schema.prisma" &&
     -d "$stage/server/prisma/migrations" &&
     -s "$stage/client/index.html" &&
     -s "$stage/client/package.json" &&
     -s "$stage/client/package-lock.json" &&
     -s "$stage/client/vite.config.js" ]] || {
    echo "Release package contents or embedded commit identity are invalid." >&2
    exit 1
  }

  (
    cd "$stage/server"
    npm ci --omit=dev --no-audit --no-fund
    DATABASE_URL=postgresql://lhcrm_preflight:unused@127.0.0.1:5432/lhcrm_preflight \
      /usr/bin/node node_modules/prisma/build/index.js generate
  )
  (
    cd "$stage/client"
    npm ci --no-audit --no-fund
    VITE_API_BASE_URL=/api/v1 npm run build
  )
  validate_release "$stage" "$commit_sha"
  [[ "$(/usr/bin/node --version)" == v24.22.2 ]]
  chmod -R u+rwX,go+rX,go-w "$stage"
  mv "$stage" "$release"
  stage_created=false
fi

write_state prepared
release_uid=$(/usr/bin/stat -c %u -- "$release")
if [[ "$release_uid" != 0 ]]; then
  sudo -n "$CONTROL" seal-release "$release_id"
fi
sudo -n "$CONTROL" validate-config

if ! sudo -n "$CONTROL" migrate-status "$release_id"; then
  if [[ "$apply_migrations" != true ]]; then
    echo "Pending migrations or migration validation failure; migration application was not authorized." >&2
    exit 1
  fi
  sudo -n "$CONTROL" migrate-preflight "$release_id"
fi

if [[ "$apply_migrations" == true ]]; then
  migration_state=uncertain
  write_state migration-started
  sudo -n "$CONTROL" migrate-deploy "$release_id"
  migration_state=applied
  write_state migration-applied
fi

write_state activating
sudo -n "$CONTROL" activate-release "$release_id"
switch_release_pointer "$previous_target" "$PREVIOUS"
write_state activated

restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! sudo -n "$CONTROL" restart-backend ||
   ! sudo -n "$CONTROL" reload-nginx ||
   ! sudo -n "$CONTROL" backend-active ||
   ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
     --max-time 10 "$HEALTH_URL" --output /dev/null ||
   ! curl --silent --show-error --fail --resolve "$FRONTEND_HOST:443:127.0.0.1" \
     --max-time 10 "https://$FRONTEND_HOST/" --output /dev/null; then
  echo "New release failed backend restart, Nginx reload, or local health checks." >&2
  exit 1
fi
if ! sudo -n "$CONTROL" startup-check "$restart_started_at"; then
  echo "New release startup logs contain a failure." >&2
  exit 1
fi

printf 'Release %s (%s) is active; prior release remains at %s\n' \
  "$release_id" "$commit_sha" "$previous_target"
deployment_succeeded=true
