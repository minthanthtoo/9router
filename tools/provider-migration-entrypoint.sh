#!/usr/bin/env bash
set -euo pipefail

data_dir="${DATA_DIR:-/app/data}"
bundle="${PROVIDER_MIGRATION_BUNDLE:-}"
passphrase_file="${PROVIDER_MIGRATION_PASSPHRASE_FILE:-}"
temporary_passphrase=""

cleanup() {
  if [[ -n "$temporary_passphrase" && -f "$temporary_passphrase" ]]; then
    rm -f -- "$temporary_passphrase"
  fi
}
trap cleanup EXIT

if [[ -n "$bundle" ]]; then
  if [[ ! -f "$bundle" ]]; then
    echo "provider-migration: configured bundle does not exist: $bundle" >&2
    exit 1
  fi

  if [[ -z "$passphrase_file" ]]; then
    if [[ -z "${PROVIDER_MIGRATION_PASSPHRASE:-}" ]]; then
      echo "provider-migration: set PROVIDER_MIGRATION_PASSPHRASE_FILE or PROVIDER_MIGRATION_PASSPHRASE" >&2
      exit 1
    fi
    temporary_passphrase="$(mktemp /tmp/9router-provider-passphrase.XXXXXX)"
    chmod 600 "$temporary_passphrase"
    printf '%s' "$PROVIDER_MIGRATION_PASSPHRASE" > "$temporary_passphrase"
    passphrase_file="$temporary_passphrase"
  fi
  unset PROVIDER_MIGRATION_PASSPHRASE PROVIDER_MIGRATION_PASSPHRASE_FILE

  mkdir -p "$data_dir/db/backups" "$data_dir/migrations/state"
  chmod 700 "$data_dir/db/backups" "$data_dir/migrations/state"

  if ! node /app/tools/provider-migration.mjs ready --db "$data_dir/db/data.sqlite" >/dev/null 2>&1; then
    echo "provider-migration: creating the pinned v0.5.59 provider schema"
    node /app/tools/provider-migration.mjs bootstrap \
      --db "$data_dir/db/data.sqlite" \
      --app-version "${PROVIDER_MIGRATION_APP_VERSION:-0.5.59}" \
      --schema-version "${PROVIDER_MIGRATION_SCHEMA_VERSION:-1}"
  fi

  node /app/tools/provider-migration.mjs import \
    --db "$data_dir/db/data.sqlite" \
    --bundle "$bundle" \
    --passphrase-file "$passphrase_file" \
    --conflict "${PROVIDER_MIGRATION_CONFLICT:-merge}" \
    --backup-dir "$data_dir/db/backups" \
    --state-dir "$data_dir/migrations/state" \
    --offline-confirmed

  # Import runs as root after the outer entrypoint's initial ownership pass.
  # Hand newly created database files to the app before dropping privileges.
  chown -R node:node "$data_dir"
  # EXIT traps do not run when exec replaces the shell.
  cleanup
fi

unset PROVIDER_MIGRATION_PASSPHRASE PROVIDER_MIGRATION_PASSPHRASE_FILE
if [[ $# -eq 0 ]]; then
  set -- node custom-server.js
fi
exec su-exec node "$@"
