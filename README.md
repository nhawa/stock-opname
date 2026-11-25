# Stock Opname Management System

A stock-opname assessment project with PostgreSQL migrations and an Express/TypeScript authentication foundation.

## Implemented Task 02 API

- `POST /api/auth/login` — accepts a lower-case email and password, then returns a short-lived Bearer access token.
- `GET /api/auth/me` — returns the authenticated active user’s safe profile.
- `POST /api/auth/logout` — returns `204`; it is client-side token disposal only and cannot revoke an already-issued stateless JWT.

The API reloads the authenticated user and store from PostgreSQL on protected requests. Authorization therefore uses the current database role/store rather than any client-supplied `store_id`.

## Local setup

1. Start PostgreSQL:

   ```sh
   docker compose up -d
   ```

2. Copy `.env.example` to your local environment and set a unique `JWT_SECRET` of at least 32 characters.
3. Apply migrations and seed development data:

   ```sh
   npm run db:migrate
   npm run db:seed
   ```

4. Start the API:

   ```sh
   npm run api:dev
   ```

The seeded development users use password `password`.

## Verification

```sh
npm run db:typecheck
```

Schema checks and API integration tests require a separate disposable `DATABASE_URL_TEST` database that has been migrated and seeded:

```sh
DATABASE_URL=postgres://stock_opname:stock_opname@127.0.0.1:5432/stock_opname_test npm run db:migrate
DATABASE_URL=postgres://stock_opname:stock_opname@127.0.0.1:5432/stock_opname_test npm run db:seed
DATABASE_URL_TEST=postgres://stock_opname:stock_opname@127.0.0.1:5432/stock_opname_test npm run test:all
```

## Current limitations

- Logout does not revoke a token before its expiry; clients should discard it and use HTTPS for Bearer transport.
- Login rate limiting is not implemented yet.
- The Task 02 store-isolation test verifies reusable middleware with a test-only route. Future inventory/session routes must apply and test the same middleware using their production resource loaders.
- Inventory and stock-opname business logic are intentionally deferred to later tasks.
