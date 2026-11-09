#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly CURRENT="$APP_ROOT/current"
readonly PREVIOUS="$RELEASES/previous"
readonly STATE="$RELEASES/.deployment-state"
readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health
readonly FRONTEND_HOST=lakshmi-hyundai-crm.tech

[[ "$(id -un)" == lakshmi-deploy ]] || {
  echo "Rollback must be run through the restricted deployment account." >&2
  exit 1
}

exec 9>"$RELEASES/.deploy.lock"
if ! flock -n 9; then
  echo "Another deployment or rollback is already running on the VPS." >&2
  exit 1
fi
if [[ -e "$STATE" || -L "$STATE" ]]; then
  echo "An unfinished deployment transaction exists; recover it before manual rollback." >&2
  exit 1
fi
if [[ ! -L "$CURRENT" || ! -L "$PREVIOUS" ]]; then
  echo "Current or previous release pointer is missing; refusing rollback." >&2
  exit 1
fi

current_target=$(readlink -f "$CURRENT")
previous_target=$(readlink -f "$PREVIOUS")
releases_real=$(readlink -f "$RELEASES")
for target in "$current_target" "$previous_target"; do
  [[ "$(dirname "$target")" == "$releases_real" ]] || {
    echo "A release pointer does not resolve to a direct child of the releases directory." >&2
    exit 1
  }
done
if [[ "$current_target" == "$previous_target" ||
      ! -d "$previous_target/server" ||
      ! -s "$previous_target/server/src/server.js" ||
      ! -s "$previous_target/client/dist/index.html" ]]; then
  echo "Previous release is invalid or already active; refusing rollback." >&2
  exit 1
fi

switch_release_pointer() {
  local target=$1 link=$2 temporary="${2}.next.$$"
  ln -s "$target" "$temporary" || return 1
  mv -Tf "$temporary" "$link" || return 1
}

echo "WARNING: this changes the application release only; it does not reverse database migrations." >&2
sudo -n /usr/local/sbin/lakshmi-hyundai-deploy-control activate-release "${previous_target##*/}"
switch_release_pointer "$current_target" "$PREVIOUS"
restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! sudo -n /usr/local/sbin/lakshmi-hyundai-deploy-control restart-backend; then
  echo "Previous release was selected but the backend restart failed; inspect the VPS." >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/lakshmi-hyundai-deploy-control reload-nginx ||
   ! sudo -n /usr/local/sbin/lakshmi-hyundai-deploy-control backend-active ||
   ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
     --max-time 10 "$HEALTH_URL" --output /dev/null ||
   ! curl --silent --show-error --fail --resolve "$FRONTEND_HOST:443:127.0.0.1" \
     --max-time 10 "https://$FRONTEND_HOST/" --output /dev/null; then
  echo "Rollback health check failed; inspect the backend service on the VPS." >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/lakshmi-hyundai-deploy-control startup-check "$restart_started_at"; then
  echo "Rollback backend logs contain a startup failure; inspect the VPS." >&2
  exit 1
fi

printf 'Rollback complete. Active release: %s\n' "$previous_target"
