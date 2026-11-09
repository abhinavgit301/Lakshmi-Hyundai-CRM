#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT=/opt/lakshmi-hyundai
readonly RELEASES="$APP_ROOT/releases"
readonly CURRENT="$APP_ROOT/current"
readonly PREVIOUS="$RELEASES/previous"
readonly STATE="$RELEASES/.deployment-state"
readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health
readonly CONTROL=/usr/local/sbin/lakshmi-hyundai-deploy-control
readonly RELEASE_PATTERN='^[0-9a-f]{40}$'
readonly FRONTEND_HOST=lakshmi-hyundai-crm.tech
release_id=${1:-}
if [[ ! "$release_id" =~ $RELEASE_PATTERN ]]; then
  echo "Invalid recovery release identifier." >&2
  exit 2
fi
[[ "$(id -un)" == lakshmi-deploy ]] || {
  echo "Recovery must be run through the restricted deployment account." >&2
  exit 1
}

exec 9>"$RELEASES/.deploy.lock"
if ! flock -w 3300 9; then
  echo "Timed out waiting for the active deployment/recovery lock." >&2
  exit 1
fi

candidate="$RELEASES/$release_id"
candidate_real=$(readlink -f "$candidate" 2>/dev/null || true)
if [[ -n "$candidate_real" && "$candidate_real" != "$candidate" ]]; then
  echo "Recovery release must be a real direct child of releases." >&2
  exit 1
fi
releases_real=$(readlink -f "$RELEASES") || {
  echo "Release directory cannot be resolved." >&2
  exit 1
}
[[ -L "$CURRENT" ]] || {
  echo "Current release pointer is not a symlink." >&2
  exit 1
}

old_target=
phase=
migration_state=unknown
if [[ -e "$STATE" || -L "$STATE" ]]; then
  [[ -f "$STATE" && ! -L "$STATE" ]] || {
    echo "Deployment state is not a regular file." >&2
    exit 1
  }
  IFS=$'\t' read -r state_release old_target state_candidate phase < "$STATE"
  [[ "$state_release" == "$release_id" && "$state_candidate" == "$candidate" ]] || {
    echo "Recovery release does not match the recorded deployment transaction." >&2
    exit 1
  }
  case "$phase" in
    started|prepared|migration-started|migration-applied|activating|activated) ;;
    *)
      echo "Deployment state phase is invalid." >&2
      exit 1
      ;;
  esac
  case "$phase" in
    migration-started) migration_state=uncertain ;;
    migration-applied) migration_state=applied ;;
    *) migration_state=not-applied ;;
  esac
  old_real=$(readlink -f "$old_target" 2>/dev/null || true)
  [[ -n "$old_real" && "$old_real" == "$old_target" &&
     "$(dirname "$old_real")" == "$releases_real" ]] || {
    echo "Recorded previous release does not resolve inside releases." >&2
    exit 1
  }
else
  current_real=$(readlink -f "$CURRENT" 2>/dev/null || true)
  if [[ "$current_real" != "$candidate" ]]; then
    echo "No active transaction for this release; nothing to recover."
    exit 0
  fi
  old_target=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
  [[ -n "$old_target" && "$(dirname "$old_target")" == "$releases_real" ]] || {
    echo "Current points to the attempted release but previous is not a safe rollback target." >&2
    exit 1
  }
fi

current_target=$(readlink -f "$CURRENT" 2>/dev/null || true)
[[ -n "$current_target" && "$(dirname "$current_target")" == "$releases_real" ]] || {
  echo "Current release pointer is missing or unsafe." >&2
  exit 1
}
case "$current_target" in
  "$candidate"|"$old_target") ;;
  *)
    echo "Current release does not match the attempted or recorded previous release." >&2
    exit 1
    ;;
esac
if [[ ! -d "$old_target/server" || ! -s "$old_target/server/src/server.js" ||
      ! -s "$old_target/client/dist/index.html" ]]; then
  echo "Recorded previous release is incomplete; refusing recovery." >&2
  exit 1
fi

switch_link() {
  local target=$1 link=$2 temporary="${2}.next.${BASHPID}.${RANDOM}"
  ln -s "$target" "$temporary" || return 1
  mv -Tf "$temporary" "$link" || return 1
}

needs_restart=false
if [[ "$current_target" == "$candidate" ]]; then
  sudo -n "$CONTROL" activate-release "${old_target##*/}"
  switch_link "$candidate" "$PREVIOUS"
  needs_restart=true
elif [[ "$phase" == activating || "$phase" == activated ]]; then
  switch_link "$candidate" "$PREVIOUS"
  needs_restart=true
fi

if [[ "$needs_restart" == true ]]; then
  restart_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if ! sudo -n "$CONTROL" restart-backend ||
     ! sudo -n "$CONTROL" reload-nginx ||
     ! sudo -n "$CONTROL" backend-active ||
     ! curl --silent --show-error --fail --retry 10 --retry-delay 3 --retry-connrefused \
       --max-time 10 "$HEALTH_URL" --output /dev/null ||
     ! curl --silent --show-error --fail --resolve "$FRONTEND_HOST:443:127.0.0.1" \
       --max-time 10 "https://$FRONTEND_HOST/" --output /dev/null ||
     ! sudo -n "$CONTROL" startup-check "$restart_started_at"; then
    echo "Recovery restored the previous pointer but restart or health verification failed." >&2
    exit 1
  fi
fi

if [[ "$migration_state" == applied || "$migration_state" == uncertain || "$migration_state" == unknown ]]; then
  echo "WARNING: database migrations may have succeeded. Recovery never rolls back the database schema; verify the restored application is compatible." >&2
fi
stage="$RELEASES/.staging-$release_id"
if [[ -e "$stage" || -L "$stage" ]]; then
  stage_real=$(readlink -f "$stage" 2>/dev/null || true)
  [[ -n "$stage_real" && -d "$stage" && ! -L "$stage" &&
     "$(dirname "$stage_real")" == "$releases_real" ]] || {
    echo "Incomplete staging path is unsafe; preserve it for manual inspection." >&2
    exit 1
  }
  rm -rf -- "$stage"
fi
rm -f -- "$STATE"
rm -f -- "$APP_ROOT/incoming/$release_id.tar.gz" \
  "$APP_ROOT/incoming/$release_id.safe-release-archive.mjs" \
  "$APP_ROOT/incoming/$release_id.migration-auth.json"
printf 'Recovery complete; current release is %s\n' "$old_target"
