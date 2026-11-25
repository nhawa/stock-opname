# Plan: Implement Inventory Ledger — Store-Scoped Transactions, Idempotency, and Concurrency

## Context

Task 01 supplies `inventory_balances` per `(store_id, product_id)` and an immutable `inventory_movements` ledger with unique `(store_id, product_id, inventory_version)`. Task 02 supplies the trusted store identity in `request.auth`, but uses a general `Database.query()` abstraction that can be a `pg.Pool`; Task 03 must acquire a dedicated client for every transaction attempt. Stock Opname remains out of scope.

Task 03 adopts **lazy balance creation for active global products**. A global active product may independently receive/open/stock-out in a caller's own store. Unknown or inactive products fail before any balance row is created. This must be revisited by Task 04 when it defines snapshot scope for zero balances.

An opaque `idempotencyKey` is unique within a store and represents exactly one request. Its canonical semantic payload is `movementType`, `productId`, `quantity`, `referenceType`, and `referenceId`; actor is intentionally excluded so any manager in the store can replay an identical completed request. Exact replay returns the original movement, version, and historical post-movement balance. Any changed canonical field returns `409 IDEMPOTENCY_KEY_REUSED`.

| Requirement | Existing basis | Task 03 approach |
|---|---|---|
| Atomic ledger/balance | movement version uniqueness | insert then balance update on one locked client transaction |
| Pooled safety | production `pg.Pool` | fresh acquired `PoolClient` per full attempt |
| Duplicate request safety | old reference index | store/request unique index plus advisory transaction lock |
| Opening setup | `OPENING_BALANCE` type | service-only first movement after locking balance |
| Store security | `request.auth.storeId` | routes never accept target store ID |

---

## Phase 1: Add Compatible Request-Key Schema and Retriable Transactions

**Why:** The database must reject duplicate request keys, and all mutation statements must execute through one physical connection.

**Test first** → `test/database-schema.test.ts`
- Upgrade a populated revision-1 database and verify its seeded balances/ledger remain valid with `NULL` legacy idempotency keys.
- Downgrade a populated but representable Task 03 database successfully, preserving the nullable `idempotency_key` column and values while restoring the old receipt/stock-out index.
- Create data representable under the new request key but not the old reference index; down migration must stop with a precise preflight error and no DDL/data changes.
- Assert blank non-null idempotency keys are rejected by the API and direct SQL check; legacy `NULL` remains permitted only for pre-Task-03/imported rows.
- Assert same non-null key is rejected in one store and allowed in another.

**New file** → `db/migrations/002_inventory_request_idempotency.up.sql`
- Add nullable `idempotency_key text` with a check that every **non-null** key is nonblank and length-bounded. Keep it nullable so populated revision-1 rows upgrade without destructive synthetic backfill; Task 03 service routes always supply a key for `OPENING_BALANCE`, `RECEIPT`, and `STOCK_OUT`. `STOCK_OPNAME_ADJUSTMENT` has no key in this task.
- Replace the old `inventory_movements_external_reference_idempotency_idx` with a stable-named unique `(store_id, idempotency_key) WHERE idempotency_key IS NOT NULL` index.
- Do **not** add an opening-balance trigger: supported mutations are serialized by the service's balance lock; arbitrary privileged direct SQL is not a supported application interface and cannot be made fully safe by an opening-only trigger.

**New file** → `db/migrations/002_inventory_request_idempotency.down.sql`
- Run in one migration transaction and acquire `ACCESS EXCLUSIVE` lock on `inventory_movements` before preflight/DDL so concurrent writes cannot invalidate the result.
- Preflight **all** receipt/stock-out rows for duplicate `(movement_type, store_id, product_id, reference_id)` groups, regardless of which migration introduced them; raise before any DDL if any exist.
- Drop the Task 03 key check and new unique index, restore the original stable-named reference index, but intentionally retain the nullable `idempotency_key` column and its data for lossless, compatible rollback. Explain this forward-compatible residual column in the migration comment.

**Modify** → `src/types.ts` and `src/db.ts`
- Define pool/client transaction contracts and a `withTransaction` helper.
- Every attempt acquires a fresh client, executes `BEGIN`, reruns the entire side-effect-free database callback, commits/rolls back, then releases. The callback may only issue database work and return data; it has no external side effects.
- Retry only bounded/backed-off `40001` and `40P01` generally. Handle `23505` only when the named store-key idempotency index caused it: rollback/release then start a fresh bounded replay attempt that reloads and compares the winner. Other `23505` errors are never retried.
- Do **not** automatically rerun after a connection/error outcome during `COMMIT`, because PostgreSQL may already have committed. Return a retryable `COMMIT_OUTCOME_UNKNOWN` error; the client retries the same idempotency key, which deterministically returns the winner without duplicate stock movement.

**New file** → `src/inventory/types.ts`
- Define command/read/result contracts. Quantities are decimal strings: positive base-10, <=11 integral digits, <=3 fractional digits.

---

## Phase 2: Implement Correct Locked Ledger Mutations

**Why:** The service must serialize all supported stock changes on the balance row and separately serialize all identical request keys, including keys aimed at different products.

**Test first** → `test/inventory.integration.test.ts`
- Opening balance commits one version-one movement; receiving and stock-out create exactly one movement and correct historical result.
- Unknown/inactive products, invalid/blank keys, invalid decimal precision/overflow, insufficient stock, and second opening leave no movement or balance row/change.
- Sequential retry returns original version/historical quantity even after later movements; each changed canonical field under a used key returns `409`.
- Concurrent first-time balance creation for the same store/product yields one balance and correct contiguous movements.
- Concurrent opening versus receipt/stock-out on a new balance serializes on the balance lock: exactly one eligible opening may commit and no supported mutation can make opening eligible later.

**New file** → `src/inventory/repository.ts`
- Provide active product validation before balance creation, store-scoped inventory/product reads, request-key lookup, and a historical quantity-at-version query scoped to the original movement's `store_id` and `product_id`, filtered `inventory_version <= original_version`, with exact numeric aggregation and `COALESCE(..., 0)`.
- Provide `INSERT ... ON CONFLICT DO NOTHING` balance creation, `SELECT ... FOR UPDATE`, movement insertion, and balance update.

**New file** → `src/inventory/service.ts`
- Start an attempt with `pg_advisory_xact_lock(hashtextextended(storeId || ':' || idempotencyKey, 0))`, then lookup/compare an existing request-key movement. The lock serializes same key operations across different products/types; collisions only add safe serialization.
- Validate the global product is active **before** `INSERT ... ON CONFLICT DO NOTHING` creates a zero balance. Then establish and lock the balance row.
- Recheck the request key after the balance lock. Require opening only when locked `version = 0` and no movement exists; every supported receipt, stock-out, and opening follows this same balance-lock path before insertion.
- Reject stock-out causing negative quantity and any result outside `numeric(14,3)`. Allocate `nextVersion`; insert exactly one movement and update balance once, then commit.
- Original replay results are reconstructed from the persisted movement plus the exact store/product-scoped `SUM(quantity_delta)` through that movement version, never the current balance; unrelated products/stores and later versions cannot affect it.
- If a named idempotency index `23505` nevertheless occurs, no statement runs in the aborted transaction; helper rollback/release starts the explicitly bounded fresh replay attempt and checks its committed winner. A commit-outcome-unknown error is never auto-retried; client retry with the same key resolves it safely.

**Reference** → `src/errors.ts`
- Reuse `AppError` and centralized response formatting.

---

## Phase 3: Add Production-Equivalent Store-Authorized API

**Why:** Authentication and roles belong at the HTTP boundary; routes must use the same composition in production and tests.

**Test first** → `test/inventory.integration.test.ts`
- STAFF/MANAGER can read only their own store balances; STAFF is forbidden for all mutations. Disabled users and users of disabled stores receive the existing authentication failure from Task 02 middleware before inventory access.
- Any body/query `storeId` is an invalid unknown field and cannot select a foreign store; direct foreign balance/product identifiers on every applicable read/mutation endpoint remain scoped to the token's store.
- An active product with a Bandung balance can intentionally be received by the Jakarta manager, creating only Jakarta's independent balance; Jakarta reads do not disclose Bandung quantity.
- Unknown/inactive products create no balance.

**New file** → `src/inventory/routes.ts`
- Authenticated `GET /api/products` and `GET /api/inventory` for STAFF/MANAGER.
- MANAGER-only `POST /api/inventory/opening-balance`, `/receipts`, `/stock-outs`; strict body is `productId`, `quantity`, `referenceType`, `referenceId`, `idempotencyKey`.
- Enforce endpoint-owned `referenceType` allowlists (`OPENING_BALANCE`, `GOODS_RECEIPT`, and `STOCK_OUT` respectively), and nonblank length limits for `referenceId` and `idempotencyKey`; do not allow arbitrary reference classifications.
- Pass only trusted authenticated store/actor identity into service.

**Modify** → `src/app.ts` and `src/server.ts`
- Mount the inventory router in ordinary `createApp` composition with transaction-capable dependencies; tests instantiate that same composition.

---

## Phase 4: Prove PostgreSQL Concurrency, Rollback, and Consistency

**Why:** Ledger correctness requires real multi-connection database tests, fault rollback, migration safety, and retry proof.

**Test first** → `test/inventory.integration.test.ts`
- Use multi-connection `pg.Pool`, reset fixtures to zero/version-zero before each test, and run concurrent requests through independent connections.
- Parallel receipts yield versions `1..n` and summed quantity; parallel stock-outs serialize, only fitting movements commit, and balance is never negative.
- Parallel same-key requests across different products/types yield one successful canonical request/replay and `409` for a semantic mismatch.
- Force the named-idempotency `23505` fallback (by controlled test seam or transaction ordering) and assert fresh-attempt replay behavior. Simulate a commit-outcome-unknown path and assert that no automatic second mutation is attempted; retrying the endpoint with the same key returns the original result.
- Exercise actual `40001` retry and bounded exhaustion. Exercise a genuine `40P01` in the transaction-helper test using two clients that lock two fixture balance rows in opposite order; assert bounded callback reruns, no external side effects, and exhaustion leaves no duplicate work.
- Test same key across stores, replay after later movements (including unrelated products/stores), and disabled user/store denial.
- Inject errors before movement insert, after movement insert/before balance update, and after balance update/before commit. Every case rolls back both tables and leaves the released connection usable.
- Assert, for zero-reset fixtures, movement versions are exactly `1..balance.version` and their delta sum equals balance quantity.

**Modify** → `test/database-schema.test.ts`
- Cover migration upgrade from populated revision 1, compatible downgrade, guarded incompatible downgrade, request-key, and direct check constraints.

**Modify** → `package.json`
- Include Task 02 and inventory tests in `test:api`.

---

## Critical Files

| File | Action |
|---|---|
| `db/migrations/002_inventory_request_idempotency.up.sql` | New — request-key constraint/index |
| `db/migrations/002_inventory_request_idempotency.down.sql` | New — compatible guarded rollback |
| `src/types.ts`, `src/db.ts` | Modify — dedicated retriable transactions |
| `src/inventory/types.ts` | New — request/decimal contracts |
| `src/inventory/repository.ts` | New — active-product, lock, and ledger operations |
| `src/inventory/service.ts` | New — atomic movements/idempotent replay |
| `src/inventory/routes.ts` | New — strict role/store APIs |
| `src/app.ts`, `src/server.ts` | Modify — production router composition |
| `test/inventory.integration.test.ts` | New — integration/race/fault tests |
| `test/database-schema.test.ts` | Modify — migration and constraints |
| `package.json` | Modify — API test command |

## Reusable Components (no changes needed)

- **`authenticate` / `requireRoles` in `src/auth/middleware.ts`** — trusted identity and MANAGER authorization.
- **`AppError` / `errorHandler` in `src/errors.ts`** — API error convention.
- **Task 02 authentication fixtures** — tokens and baseline identities.

## Verification

1. Test clean and populated revision-1 migration upgrade, representable populated downgrade, and explicitly blocked incompatible downgrade.
2. Run `npm run db:verify`, `npm run test:api`, and `npm run db:typecheck` successfully.
3. Verify concurrent real-Pool operations have no lost updates, negative balances, duplicate movements, or non-contiguous versions.
4. Verify original retry responses retain their historical balance/version after later movements.
5. Verify authenticated store scope governs all reads/writes and active global products yield independent store balances.

## Execution Log

- **Schema:** Added migration `002_inventory_request_idempotency` with a store-scoped idempotency index and a compatible guarded rollback that retains the nullable key column.
- **Architecture:** Added dedicated-client `withTransaction` handling. Commit-outcome ambiguity returns a retryable error rather than replaying automatically.
- **Inventory implementation:** Added product/inventory reads and manager-only opening, receipt, and stock-out routes. Every supported mutation acquires an idempotency advisory lock and a balance row lock, then writes one movement and one balance update in the same transaction.
- **Testing:** Added API integration coverage for opening/receiving/stock-out, retry handling, insufficient stock, staff mutation denial, concurrent receipts, concurrent stock-outs, product listing, and ledger balance/version assertions.
- **Validation executed:** `npm run test:api`, `npm run db:verify`, `npm run db:typecheck`, and `git diff --check` against the local PostgreSQL test database all passed.
