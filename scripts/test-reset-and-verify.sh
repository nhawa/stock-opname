#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root_dir"

env_file=.env.test
compose=(docker compose --env-file "$env_file" -f docker-compose.test.yml)

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Create it locally with POSTGRES_TEST_PASSWORD and DATABASE_URL_TEST." >&2
  exit 1
fi

set -a
. "./$env_file"
set +a

: "${POSTGRES_TEST_PASSWORD:?POSTGRES_TEST_PASSWORD must be set in .env.test}"
: "${DATABASE_URL_TEST:?DATABASE_URL_TEST must be set in .env.test}"

# This script is the sole destructive test reset entry point. Refuse anything
# other than the local disposable Compose database before connecting with psql.
node --input-type=module <<'NODE'
const url = new URL(process.env.DATABASE_URL_TEST);
const expected = {
  hostname: new Set(['127.0.0.1', 'localhost']),
  port: '5433',
  username: 'stock_opname_test',
};
const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
const isDisposableTestDatabase = /^stock_opname_test(?:_[a-z0-9]+)?$/i.test(database);
if (
  !expected.hostname.has(url.hostname) ||
  url.port !== expected.port ||
  decodeURIComponent(url.username) !== expected.username ||
  !isDisposableTestDatabase
) {
  console.error('DATABASE_URL_TEST must target a local disposable stock_opname_test database on port 5433.');
  process.exit(1);
}
NODE

echo "Starting isolated test database..."
"${compose[@]}" up -d

for attempt in {1..30}; do
  if "${compose[@]}" exec -T postgres-test pg_isready -U stock_opname_test -d stock_opname_test >/dev/null 2>&1; then
    break
  fi

  if [[ "$attempt" == 30 ]]; then
    echo "Test database did not become ready within 30 seconds." >&2
    exit 1
  fi

  sleep 1
done

echo "Recreating the disposable test schema..."
psql "$DATABASE_URL_TEST" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO stock_opname_test;
SQL

echo "Applying migrations and seed data from a clean state..."
DATABASE_URL="$DATABASE_URL_TEST" npm run db:migrate
DATABASE_URL="$DATABASE_URL_TEST" npm run db:seed

echo "Running full backend verification..."
DATABASE_URL_TEST="$DATABASE_URL_TEST" npm run test:all:inner
