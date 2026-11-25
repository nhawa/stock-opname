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

echo "Resetting isolated test data..."
psql "$DATABASE_URL_TEST" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE TABLE
  audit_logs,
  inventory_movements,
  stock_opname_items,
  stock_opname_sessions,
  inventory_balances,
  products,
  users,
  stores
CASCADE;
SQL

echo "Applying migrations and seed data..."
DATABASE_URL="$DATABASE_URL_TEST" npm run db:migrate
DATABASE_URL="$DATABASE_URL_TEST" npm run db:seed

echo "Running full backend verification..."
DATABASE_URL_TEST="$DATABASE_URL_TEST" npm run test:all
