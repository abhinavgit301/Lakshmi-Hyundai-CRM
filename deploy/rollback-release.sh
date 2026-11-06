#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly CURRENT="$RELEASES/current"
readonly PREVIOUS="$RELEASES/previous"
readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health

exec 9>"$RELEASES/.deploy.lock"
if ! flock -n 9; then
  echo "Another deployment or rollback is already running on the VPS." >&2
  exit 1
fi
if [[ ! -L "$CURRENT" || ! -L "$PREVIOUS" ]]; then
  echo "Current or previous release pointer is missing; refusing rollback." >&2
  exit 1
fi

current_target=$(readlink -f "$CURRENT")
previous_target=$(readlink -f "$PREVIOUS")
for target in "$current_target" "$previous_target"; do
  case "$target/" in
    "$RELEASES"/*/) ;;
    *)
      echo "A release pointer resolves outside the releases directory." >&2
      exit 1
      ;;
  esac
done
if [[ "$current_target" == "$previous_target" ||
      ! -d "$previous_target/backend" ||
      ! -s "$previous_target/frontend/dist/index.html" ]]; then
  echo "Previous release is invalid or already active; refusing rollback." >&2
  exit 1
fi

switch_link() {
  local target=$1 link=$2 temporary="${2}.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

switch_link "$current_target" "$PREVIOUS"
switch_link "$previous_target" "$CURRENT"
restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control restart-backend; then
  echo "Previous release was selected but the backend restart failed; inspect the VPS." >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control backend-active ||
   ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
     --max-time 10 "$HEALTH_URL" --output /dev/null; then
  echo "Rollback health check failed; inspect the backend service on the VPS." >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/lhcrm-deploy-control startup-check "$restart_started_at"; then
  echo "Rollback backend logs contain a startup failure; inspect the VPS." >&2
  exit 1
fi

printf 'Rollback complete. Active release: %s\n' "$previous_target"
