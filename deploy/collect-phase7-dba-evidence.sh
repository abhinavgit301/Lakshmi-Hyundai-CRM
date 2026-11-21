#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  collect-phase7-dba-evidence.sh --database DATABASE --output DIRECTORY

Read-only PostgreSQL evidence collection.

The script:
- Uses local peer or existing psql authentication only.
- Never accepts a password or database URL.
- Executes only phase7-dba-evidence.sql inside BEGIN READ ONLY.
- Creates output files with user-only permissions.

This script does not execute by default. It prints the exact command unless
--execute-read-only is supplied explicitly.
EOF
}

database=""
output=""
execute=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database)
      [[ $# -ge 2 ]] || { echo "Missing --database value." >&2; exit 2; }
      database=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "Missing --output value." >&2; exit 2; }
      output=$2
      shift 2
      ;;
    --execute-read-only)
      execute=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$database" && -n "$output" ]] || {
  usage >&2
  exit 2
}
[[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]] || {
  echo "Invalid database name." >&2
  exit 2
}

script_dir=$(/usr/bin/dirname -- "$0")
sql_file="$script_dir/phase7-dba-evidence.sql"
[[ -f "$sql_file" ]] || {
  echo "Evidence SQL file is missing." >&2
  exit 1
}

if [[ "$execute" != true ]]; then
  printf 'Print-only mode. No database command was executed.\n'
  printf 'Planned executable: /usr/bin/psql -X -v ON_ERROR_STOP=1 --dbname %q --file %q\n' \
    "$database" "$sql_file"
  exit 0
fi

[[ -x /usr/bin/psql ]] || {
  echo "/usr/bin/psql is unavailable." >&2
  exit 1
}

if [[ -e "$output" || -L "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || {
    echo "Output path must be a real directory." >&2
    exit 1
  }
else
  mkdir -m 0700 -- "$output"
fi

if [[ $(/usr/bin/stat -c %u -- "$output") != $(/usr/bin/id -u) ]]; then
  echo "Output directory must be owned by the executing user." >&2
  exit 1
fi

mode=$(/usr/bin/stat -c %a -- "$output")
if (( (8#$mode & 0077) != 0 )); then
  echo "Output directory permissions must not grant group or other access." >&2
  exit 1
fi

umask 077
evidence_file="$output/phase7-dba-evidence.txt"
metadata_file="$output/phase7-dba-system-metadata.txt"

/usr/bin/psql \
  --no-password \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --dbname="$database" \
  --file="$sql_file" \
  >"$evidence_file"

{
  echo 'Execution environment metadata'
  /usr/bin/stat -c '%n uid=%u gid=%g mode=%a type=%F' \
    /opt/lakshmi-hyundai/shared/backend.env \
    /opt/lakshmi-hyundai/shared/migration.env \
    /etc/lakshmi-hyundai/database-identity.json 2>/dev/null || true

  echo 'Migration unit identity'
  /usr/bin/systemctl show lakshmi-hyundai-migrate-status@0000000000000000000000000000000000000000.service \
    -p User -p Group -p EnvironmentFiles --no-pager 2>/dev/null || true
  /usr/bin/systemctl show lakshmi-hyundai-migrate-preflight@0000000000000000000000000000000000000000.service \
    -p User -p Group -p EnvironmentFiles --no-pager 2>/dev/null || true
  /usr/bin/systemctl show lakshmi-hyundai-migrate@0000000000000000000000000000000000000000.service \
    -p User -p Group -p EnvironmentFiles --no-pager 2>/dev/null || true

  echo 'Backend environment variable names only'
  if [[ -r /opt/lakshmi-hyundai/shared/backend.env ]]; then
    /usr/bin/awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' \
      /opt/lakshmi-hyundai/shared/backend.env
  fi

  echo 'Migration environment variable names only'
  if [[ -r /opt/lakshmi-hyundai/shared/migration.env ]]; then
    /usr/bin/awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' \
      /opt/lakshmi-hyundai/shared/migration.env
  fi
} >"$metadata_file"

/usr/bin/chmod 0600 "$evidence_file" "$metadata_file"

printf 'Read-only evidence written to %s\n' "$evidence_file"
printf 'Read-only metadata written to %s\n' "$metadata_file"
