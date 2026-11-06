#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly INCOMING="$APP_ROOT/incoming"
readonly CURRENT="$RELEASES/current"
readonly PREVIOUS="$RELEASES/previous"
readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health

release_id=${1:-}
commit_sha=${2:-}
apply_migrations=${3:-false}
if [[ ! "$release_id" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ||
      ! "$commit_sha" =~ ^[0-9a-f]{40}$ ||
      ( "$apply_migrations" != true && "$apply_migrations" != false ) ]]; then
  echo "Invalid release identifier or commit SHA." >&2
  exit 2
fi

artifact="$INCOMING/$release_id.tar.gz"
stage="$RELEASES/.staging-$release_id"
release="$RELEASES/$release_id"
lock_file="$RELEASES/.deploy.lock"

if [[ ! -f "$artifact" ]]; then
  echo "Release artifact not found at its expected incoming path." >&2
  exit 1
fi
if [[ ! -L "$CURRENT" || -e "$release" || -L "$release" || -e "$stage" ]]; then
  echo "Current release must be a symlink; release or staging path already exists." >&2
  exit 1
fi
if [[ ! -d "$RELEASES" || ! -d "$INCOMING" || ! -f "$APP_ROOT/shared/backend.env" ]]; then
  echo "Required VPS release directories or shared backend environment are missing." >&2
  exit 1
fi

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Another deployment or rollback is already running on the VPS." >&2
  exit 1
fi

previous_target=$(readlink -f "$CURRENT") || {
  echo "The current release symlink is broken." >&2
  exit 1
}
case "$previous_target/" in
  "$RELEASES"/*/) ;;
  *)
    echo "Current release resolves outside the releases directory." >&2
    exit 1
    ;;
esac
if [[ ! -d "$previous_target/backend" || ! -s "$previous_target/frontend/dist/index.html" ]]; then
  echo "The active release is not a valid rollback target." >&2
  exit 1
fi
if [[ ! -x /usr/local/sbin/lhcrm-deploy-control ]]; then
  echo "The restricted VPS deployment control helper is not installed." >&2
  exit 1
fi

printf 'Preparing commit %s as release %s\n' "$commit_sha" "$release_id"
mkdir -m 0750 "$stage"
tar -xzf "$artifact" -C "$stage"
if [[ ! -s "$stage/RELEASE_COMMIT" || "$(cat "$stage/RELEASE_COMMIT")" != "$commit_sha" ||
      ! -s "$stage/backend/package-lock.json" ||
      ! -s "$stage/backend/prisma/schema.prisma" ||
      ! -s "$stage/frontend/dist/index.html" ]]; then
  echo "Release package contents or embedded commit identity are invalid." >&2
  exit 1
fi

(
  cd "$stage/backend"
  npm ci --include=dev --no-audit --no-fund
  DATABASE_URL=postgresql://generate:generate@127.0.0.1:5432/generate npm exec -- prisma generate
)

mv "$stage" "$release"
chmod -R u+rwX,go+rX,go-w "$release"

if [[ "$apply_migrations" == true ]]; then
  echo "Explicit migration approval enabled; applying committed Prisma migrations from $commit_sha."
  sudo -n /usr/local/sbin/lhcrm-deploy-control migrate-deploy "$release_id"
else
  echo "Checking migration status without applying pending migrations."
  sudo -n /usr/local/sbin/lhcrm-deploy-control migrate-status "$release_id"
fi
(
  cd "$release/backend"
  npm prune --omit=dev --ignore-scripts --no-audit --no-fund
)

switch_link() {
  local target=$1 link=$2 temporary="${2}.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

restore_previous() {
  local failed_release=$1
  echo "Deployment health check failed; restoring the previous application release." >&2
  switch_link "$previous_target" "$CURRENT"
  switch_link "$failed_release" "$PREVIOUS"
  if ! sudo -n /usr/local/sbin/lhcrm-deploy-control restart-backend; then
    echo "Rollback restart failed; inspect the backend service on the VPS." >&2
    return 1
  fi
  return 0
}

switch_link "$previous_target" "$PREVIOUS"
switch_link "$release" "$CURRENT"

restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control restart-backend; then
  restore_previous "$release" || true
  exit 1
fi
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control backend-active; then
  restore_previous "$release" || true
  exit 1
fi
if ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
    --max-time 10 "$HEALTH_URL" --output /dev/null; then
  restore_previous "$release" || true
  exit 1
fi
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control startup-check "$restart_started_at"; then
  restore_previous "$release" || true
  exit 1
fi

printf 'Release %s (%s) is active; prior release remains at %s\n' \
  "$release_id" "$commit_sha" "$previous_target"
rm -f -- "$artifact"
