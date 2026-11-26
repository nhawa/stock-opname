# Stock Opname Management System

A multi-store stock-opname application with an Express/TypeScript REST API, PostgreSQL inventory ledger, and Next.js frontend. Managers initiate, review, approve, or reject sessions; staff reserve products and submit physical counts. Approval creates an atomic inventory adjustment while preserving movements posted after the count cutoff.

## Prerequisites

- Node.js and npm
- Docker Compose (PostgreSQL)

Install dependencies in both projects:

```sh
npm install
(cd frontend && npm install)
```

## Local development setup

1. Copy `.env.example` to `.env` and replace `JWT_SECRET` with a unique value of at least 32 characters. Do not commit `.env`.
2. Start the development database:

   ```sh
   docker compose up -d
   ```

3. Apply migrations and development fixtures:

   ```sh
   npm run db:migrate
   npm run db:seed
   ```

4. Start the API (the default configured port is `3000`):

   ```sh
   npm run api:dev
   ```

5. In another terminal, start the frontend on a different port and point its server-side API rewrite to the API:

   ```sh
   cd frontend
   API_BACKEND_URL=http://localhost:3000 npm run dev
   ```

   Open `http://localhost:3001`. The frontend stores its access token in session storage and proxies `/api/*` to `API_BACKEND_URL`.

Development seed users all use password `password`:

- `manager.jakarta@example.test` / `staff.jakarta@example.test`
- `manager.bandung@example.test` / `staff.bandung@example.test`

## Test database and verification

The test database is separate from the development database. Keep `POSTGRES_TEST_PASSWORD` and `DATABASE_URL_TEST` in the ignored `.env.test` file. Its URL must point to the test Compose port (`5433`).

```sh
set -a
. ./.env.test
set +a

docker compose --env-file .env.test -f docker-compose.test.yml up -d
DATABASE_URL="$DATABASE_URL_TEST" npm run db:migrate
DATABASE_URL="$DATABASE_URL_TEST" npm run db:seed
DATABASE_URL_TEST="$DATABASE_URL_TEST" npm run test:all
```

To reset the isolated test data, migrate, seed, and run the complete backend suite in one command:

```sh
./scripts/test-reset-and-verify.sh
```

This script truncates only the database identified by `DATABASE_URL_TEST`; never point that variable at development or production data.

Additional checks:

```sh
npm run db:typecheck
npm run test:transactions
(cd frontend && npm run lint)
(cd frontend && npx tsc --noEmit)
(cd frontend && npm run build)
```

`npm run build` requires a working compatible Next.js SWC native module. It must be run and verified in the target environment; do not treat static checks as proof of a successful production build.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply pending SQL migrations using `DATABASE_URL` |
| `npm run db:rollback` | Roll back the most recently applied migration |
| `npm run db:seed` | Load deterministic development/test fixtures |
| `npm run test:all` | Run schema, transaction, and API integration tests using `DATABASE_URL_TEST` |
| `npm run api:dev` | Start the Express API |

## Security and operational notes

- The API derives the authenticated user and store from the token and database; it does not accept a client-provided store ID for authorization.
- Logout discards the browser token but does not revoke an already-issued stateless JWT. Tokens expire according to `JWT_EXPIRES_IN_SECONDS`.
- Count reservations expire after `COUNT_RESERVATION_ACTIVE_SECONDS` (default: `600`, or ten minutes). Inventory movement is blocked while an item has a live reservation.
- A physical count cutoff still requires an operational process: database locking cannot prove when a physical observation occurred.
- `.env` and `.env.test` are intentionally ignored. Only `.env.example` is tracked.
