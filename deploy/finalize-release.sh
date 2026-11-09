#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly STATE="$RELEASES/.deployment-state"
release_id=${1:-}
if [[ ! "$release_id" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid finalized release identifier." >&2
  exit 2
fi
[[ "$(id -un)" == lakshmi-deploy ]] || {
  echo "Finalization must be run through the restricted deployment account." >&2
  exit 1
}

exec 9>"$RELEASES/.deploy.lock"
if ! flock -w 300 9; then
  echo "Timed out waiting for deployment finalization lock." >&2
  exit 1
fi
[[ -L "$APP_ROOT/current" ]] || {
  echo "Current release pointer is not a symlink." >&2
  exit 1
}
active=$(readlink -f "$APP_ROOT/current")
expected="$RELEASES/$release_id"
[[ "$active" == "$expected" && -d "$expected/server" &&
   -s "$expected/server/src/server.js" &&
   -s "$expected/client/dist/index.html" ]] || {
  echo "Only the healthy active release may be finalized." >&2
  exit 1
}
if [[ -e "$STATE" || -L "$STATE" ]]; then
  [[ -f "$STATE" && ! -L "$STATE" ]] || {
    echo "Deployment state is not a regular file." >&2
    exit 1
  }
  IFS=$'\t' read -r state_release _ state_candidate phase < "$STATE"
  [[ "$state_release" == "$release_id" && "$state_candidate" == "$expected" &&
     "$phase" == activated ]] || {
    echo "Deployment state does not match the healthy release." >&2
    exit 1
  }
  rm -f -- "$STATE"
fi
rm -f -- "$APP_ROOT/incoming/$release_id.tar.gz" \
  "$APP_ROOT/incoming/$release_id.safe-release-archive.mjs" \
  "$APP_ROOT/incoming/$release_id.migration-auth.json"
printf 'Finalized healthy release %s\n' "$release_id"
