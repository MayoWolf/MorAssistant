#!/bin/sh
set -eu

database_directory=$(dirname "${SESSION_DB_PATH:?SESSION_DB_PATH is required}")
codex_users_root=${CODEX_USERS_ROOT:?CODEX_USERS_ROOT is required}

mkdir -p "$database_directory" "$codex_users_root"
chown node:node "$database_directory" "$codex_users_root"
chmod 700 "$database_directory" "$codex_users_root"

exec gosu node "$@"
