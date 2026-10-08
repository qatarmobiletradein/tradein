#!/usr/bin/env bash
# with-local-postgres.sh — run a command against a THROWAWAY local PostgreSQL.
#
# Creates a fresh cluster in a temporary directory, applies the Supabase
# compatibility shim (tests only) and every migration, runs the command with
# DATABASE_URL pointing at it, then stops and deletes the cluster.
#
# It never connects to anything but 127.0.0.1. It refuses to run if
# DATABASE_URL is already set, so it cannot be pointed at a real database.
#
#   bash tests/scripts/with-local-postgres.sh npx vitest run
set -euo pipefail

if [[ -n "${DATABASE_URL:-}" && "${QM_ALLOW_EXISTING_DATABASE_URL:-}" != "1" ]]; then
  echo "Refusing: DATABASE_URL is already set. These tests create and drop data." >&2
  exit 2
fi

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PG_BIN/initdb" ]] || { echo "PostgreSQL server binaries not found (set PG_BIN)." >&2; exit 3; }

PORT="${QM_TEST_PG_PORT:-54329}"
WORK="$(mktemp -d /tmp/qm-pg-XXXXXX)"
chmod 755 "$WORK"
RUNAS=()
if [[ "$(id -u)" == "0" ]]; then
  # initdb refuses to run as root.
  chown postgres "$WORK"
  RUNAS=(runuser -u postgres --)
fi

cleanup() {
  "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUNAS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" \
  -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off -c timezone=UTC" \
  -w start >/dev/null

export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/postgres"
export QM_TEST_DATABASE=1
"$@"
