# Plan: Implement Stock Opname Initiation and Counting — Serializable Snapshots and Reserved Cutoffs

## Context

The user approved the combined initiation-and-counting scope in this conversation. It deliberately combines checklist Tasks 04 and 05: initiation, immutable snapshots, list/detail, physical count drafts, and final submission. Manager approval/rejection and inventory adjustments are excluded.

The existing Express/TypeScript/PostgreSQL app already has versioned balances/movements, store-bound authentication, session/item tables, and the active-session partial unique index. This work adds the stock-opname module, database state-machine guards, serializable initiation, and a reservation-aware movement guard.

A saved timestamp alone cannot prove when physical counting happened. Staff therefore reserve a SKU before they count it. Reservation holds the balance row, records a token/current version, then commits. New ledger movements lock that exact balance and, without locking a session row, read an indexed reservation predicate; they block only for an unexpired reservation in a `COUNTING` session. Count save locks the balance and requires exact token/actor/version/expiry equality before recording that version as cutoff. Operations must also stop manual/unledgered movement while reserved; the application guarantees ledger exclusion, not visibility into unledgered movement.

| Policy | Decision |
|---|---|
| Scope | Active products at the serializable scope read, including zero balances; later deactivation does not hide existing items. |
| Partial submission | Allowed; NULL remains uncounted and zero is a count. |
| Roles | Both roles list/detail own-store sessions; manager initiates; staff reserves/saves/submits. |
| Recount | Any same-store staff may make a new reservation and replace a prior count. |
| Reservation | One SKU, 10-minute PostgreSQL-clock TTL, no release endpoint, replacement only after expiry, maximum 25 draft entries. Submission rejects live reservations. |
| Decimal | Input regex `^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$`; output `numeric(14,3)` strings. No JavaScript-number arithmetic. |
| Audit | Transactional initiation/submission audit events; no draft/reservation audit in this task. |
| Commit uncertainty | No automatic replay after uncertain COMMIT. Client receives 503 and GETs own-store state before retrying; active index and conditional state update prevent duplicate effects. |

---

## Phase 1: Transaction API and Database Guards (TDD)

**Why:** Serializable scope, retry behavior, and immutable item transitions must be precise and enforced before API code is built.

**Test first** → `test/database-schema.test.ts`
- Transaction option reports `serializable` isolation; default calls remain read committed.
- Direct SQL cannot change `id`, `session_id`, `product_id`, snapshot fields, `created_at`, or counted fields after submission.
- Reservation fields are all-null/all-present; reservation and counted actors belong to the session store.
- A reservation's version must equal the matching balance version while the trigger locks that balance; a direct-SQL reservation racing a movement serializes and never accepts stale version.
- `draft_version` only advances one during valid reservation-consuming count save.
- Migration sequence up → down → up succeeds on a disposable database/schema.

**Modify** → `src/db.ts`
- Define `TransactionOptions { maxAttempts?: number; isolationLevel?: 'read committed' | 'serializable' }`.
- Keep backward compatibility through overloads: third argument accepts either existing numeric `maxAttempts` or `TransactionOptions`; normalize internally. Existing callers need no change.
- Issue `BEGIN` or `BEGIN ISOLATION LEVEL SERIALIZABLE` before callback queries.
- Retry only pre-COMMIT `40001`/`40P01`; after the configured final attempt throw `AppError(503, 'TRANSACTION_RETRY_EXHAUSTED', ...)`. A COMMIT transport uncertainty remains `COMMIT_OUTCOME_UNKNOWN`, is never retried, and is not remapped.

**New file** → `db/migrations/003_stock_opname_count_invariants.up.sql`
- Add `draft_version` and nullable all-or-none reservation token/user/version/expiry fields plus lookup indexes.
- Drop the foundation `stock_opname_items_set_updated_at` trigger and replace it with one consolidated, explicitly named `stock_opname_items_state_guard` `BEFORE UPDATE` trigger. The guard itself sets `NEW.updated_at = transaction_timestamp()`; no same-timing generic item trigger remains, so timestamp/state ordering is deterministic.
- The item guard rejects all changes to item ID/reference/snapshot/created fields. It permits reservation acquire/expired replacement only in parent `COUNTING`, with unchanged counted data/revision; it locks matching `(session.store_id, product_id)` balance `FOR UPDATE`, requires exact current version, and verifies reserver belongs to session store. It permits count save only in `COUNTING`, with old unexpired reservation, new `counted_by`/cutoff equal old reservation user/version, server-assigned `counted_at = transaction_timestamp()`, cleared reservation fields, and revision exactly +1. No item transition is allowed after terminal status.
- Add `stock_opname_sessions_state_guard` `BEFORE INSERT OR UPDATE`: initiated user must be same-store MANAGER; initiation fields are immutable; only `COUNTING → SUBMITTED` is legal in this task; submitter must be same-store STAFF; submitted fields are atomically set and immutable. Direct APPROVED/REJECTED or cross-store/role mutation is rejected.
- Add `inventory_movements_reservation_guard` `BEFORE INSERT`: it locks the matching balance and blocks an insert when an unexpired reservation joined to a `COUNTING` session exists for the same store/product. This guards direct SQL/future ledger writers; the service guard remains a friendly equivalent. Re-locking a service-held balance is safe.

**New file** → `db/migrations/003_stock_opname_count_invariants.down.sql`
- Reverse dependent triggers/functions/indexes/columns and restore the original `stock_opname_items_set_updated_at` trigger after removing the consolidated guard. Document destructive development-only rollback and real chain: `001_database_foundation`, `002_inventory_request_idempotency`, `003`. Deployment rollback must first run code compatible without reservations, then roll back 003; full teardown runs 003.down, 002.down, then 001.down.

**Modify** → `package.json`
- Add the stock-opname integration suite to existing explicit sequential `test:api` convention.

---

## Phase 2: Serializable Initiation and Own-Store Read APIs (TDD)

**Why:** Initiation must establish exactly one complete, linearisable product/balance snapshot without partial state.

**Test first** → `test/stock-opname.integration.test.ts`
- Manager initiation snapshots each active product visible to its serializable transaction, including zero balances, creates initiation audit, and rejects inactive store.
- Two initiation requests produce one creation and one `409 ACTIVE_SESSION_EXISTS`; both explicit active-row detection and the named index violation map to that code.
- Movement concurrent with initiation yields balance-row-consistent snapshot; later movement never mutates it.
- Controlled product insertion, activation/deactivation, and balance-creation races either serialize/retry to a valid serializable product-scope point or fail `503 TRANSACTION_RETRY_EXHAUSTED` with no session/items. Visible products are `FOR SHARE` locked; PostgreSQL SSI protects absent/predicate scope and may abort rather than block.
- Same-store staff/manager list/detail; foreign IDs, malformed UUIDs, and role-prohibited writes receive correct 404/400/403 responses. Deactivation after initiation preserves historical detail/count membership.

**New file** → `src/stock-opname/types.ts`
- Typed status/commands/results and canonical string numeric/bigint fields.

**New file** → `src/stock-opname/repository.ts`
- Active-store/product scope query, locking visible products `FOR SHARE`; store-filtered list/detail (detail does not filter products by current active state); audit helpers.
- Deterministic balance creation `INSERT ... SELECT ... ORDER BY product_id ON CONFLICT DO NOTHING`, final requery, then balance locks by ascending product UUID.
- Store-filtered session/item/balance lock primitives and exact-row-count conditional updates.

**New file** → `src/stock-opname/service.ts`
- `initiateSession` uses `withTransaction(database, callback, { isolationLevel: 'serializable', maxAttempts: 3 })`.
- Its order: acquire namespaced store advisory lock; lock visible product rows; read scope/check active row; create/requery/lock balances ordered; insert session/items/audit. Use two-int locks: `pg_advisory_xact_lock(hashtext('stock-opname:store'), hashtext(storeId))`; this is namespaced and distinct from existing one-bigint inventory idempotency lock. Initiation locks products before balances; movement takes its idempotency lock then creates/locks one balance and never takes product/store locks. Both create balance rows before balance locking; serializable retry resolves first-balance conflicts. A deadlock regression covers initiation racing first-time balance creation/movement. No flow holds both advisory-lock families.
- Map an observed active session and only `23505` constraint `stock_opname_one_active_session_per_store_idx` to `409 ACTIVE_SESSION_EXISTS`.
- All store ownership checks are SQL filters inside transactions, never route prechecks only.

**New file** → `src/stock-opname/routes.ts`
- Manager `POST /stock-opname/sessions`; STAFF/MANAGER `GET /stock-opname/sessions` and `GET /stock-opname/sessions/:sessionId`; strict Zod UUID/JSON validation.

**Modify** → `src/app.ts`
- Mount router at `/api`.

---

## Phase 3: Reservation, Draft, and Submission APIs (TDD)

**Why:** Reservations turn the operational count window into a ledger-enforced cutoff, while conditional revisions eliminate silent overwrites.

**Test first** → `test/stock-opname.integration.test.ts`
- Reservation response is issued only after token/version/expiry persisted under the balance lock; malformed UUID request rejected.
- Competing reservation gets one success/one conflict. Exactly-at-expiry replacement uses database `now()` policy (`expires_at <= now()` is expired).
- Reservation-vs-new-movement races in either order produce a linear result: when movement already holds the balance lock before reservation commit, reservation waits then records the movement's newer version; when reservation wins, movement's DB and service guards return `409 COUNT_IN_PROGRESS`. Completed idempotency replay remains successful during later reservation. Include a direct-SQL movement insert test proving the database trigger blocks it, plus historical terminal sessions/items to prove only a live `COUNTING` reservation blocks.
- Draft requires exact unexpired token, actor, balance version, and revision. Invalid/unknown/out-of-session/duplicate/empty/too-large inputs and a forced late batch conflict roll back every item.
- Reverse multi-SKU batches use product UUID order; concurrent writers yield visible stale-draft conflict.
- Draft-versus-submit serializes. Submission with a live reservation returns `409 COUNT_RESERVATIONS_ACTIVE` listing/reservation expiry; after count/expiry it may submit. Include a submit-versus-movement race/deadlock regression. Immediate new movement after terminal submit is allowed because both guards match `COUNTING` only.
- Partial/zero submit leaves inventory quantity/version/movement rows unchanged and blocks later reservation/draft.

**Modify** → `src/stock-opname/repository.ts`
- Existing session operation lock order: namespaced session advisory lock `pg_advisory_xact_lock(hashtext('stock-opname:session'), hashtext(sessionId))` → store-filtered session `FOR UPDATE` → balances ascending UUID → items same ascending UUID. Keep locks to commit.
- Reservation is written while balance lock is held; no manual release. Replacement only after expiry. Submission checks for live reservations under session lock and rejects rather than making active count work silently inert.
- Draft requires exact one-row conditional update for every item or throws stale-draft conflict/rolls back all.

**Modify** → `src/stock-opname/service.ts`
- `reserveCount`, `saveDraftCounts`, `submitSession` enforce own-store STAFF and `COUNTING` state. Save never accepts client `countedAt`; the consolidated database trigger assigns transaction timestamp. The session trigger independently validates submitter store/STAFF role, legal `COUNTING → SUBMITTED` transition, and paired submission metadata.

**Modify** → `src/stock-opname/routes.ts`
- STAFF-only strict endpoints:
  - `POST /stock-opname/sessions/:sessionId/counts/reservations`
  - `POST /stock-opname/sessions/:sessionId/counts/draft`
  - `POST /stock-opname/sessions/:sessionId/submit`

**Modify** → `src/inventory/service.ts`
- Existing completed idempotency replay remains before balance locking.
- For a new movement, after existing balance `FOR UPDATE` and before version/ledger update, run a read-only indexed guard joining items/session for same store/product, `status = 'COUNTING'`, `reservation_expires_at > now()`. It uses no `FOR UPDATE` on session/items and acquires no advisory lock, so it cannot form a reverse session→balance cycle. It returns `409 COUNT_IN_PROGRESS` if found.

---

## Phase 4: Integration Test + Fixture Hygiene

**Why:** Races must run against PostgreSQL, while test data cannot compromise existing schema/inventory tests.

**Modify** → `test/stock-opname.integration.test.ts`
- Use a dedicated fixed-UUID test store/users/products created by suite `before`, not shared Jakarta rice fixtures. `before` first deletes any residual dedicated test graph in FK order, recreates it with opening ledger/balance rows; each test deletes only sessions/items/audits/reservations and restores product active state.
- `after` uses failure-safe `try/finally` cleanup in reverse FK order. Node test hooks run after assertion failures; if process termination prevents cleanup, documented fresh migrate/seed is required before `db:verify` (which intentionally expects four seeded balances).
- Run `npm run test:all` on a freshly migrated/seeded DB to prove ordered script isolation; test runner remains `--test-concurrency=1`.

**Reference** → `src/db.ts`, `src/auth/middleware.ts`, `src/inventory/repository.ts`, `db/migrations/001_database_foundation.up.sql`
- Reuse transaction, trusted identity, balance locks, and existing core constraints.

---

## Critical Files

| File | Action |
|---|---|
| `src/db.ts` | Modify — explicit options/isolation/retry contract |
| `db/migrations/003_stock_opname_count_invariants.up.sql` | New — revisions, reservation and state triggers |
| `db/migrations/003_stock_opname_count_invariants.down.sql` | New — documented rollback |
| `src/stock-opname/types.ts` | New — contracts |
| `src/stock-opname/repository.ts` | New — scoped persistence/locking |
| `src/stock-opname/service.ts` | New — transactional workflows |
| `src/stock-opname/routes.ts` | New — validated REST endpoints |
| `src/inventory/service.ts` | Modify — reservation-aware new-movement guard |
| `src/app.ts` | Modify — router mount |
| `test/stock-opname.integration.test.ts` | New — behavior/concurrency/fixture coverage |
| `test/database-schema.test.ts` | Modify — isolation/trigger/migration checks |
| `package.json` | Modify — test suite registration |

## Reusable Components (no changes needed)

- **`lockBalance` (`src/inventory/repository.ts`)** — balance version/lock source.
- **Auth middleware (`src/auth/middleware.ts`)** — active trusted store/role identity.
- **`AppError` handler** — consistent public error shape.

## Verification

1. Freshly migrate/seed test DB; test migration up/down/up and `npm run db:verify`.
2. Run `npm run test:api` and `npm run test:all` in fresh setup.
3. Prove named active-session conflict, serializable product insertion/activation/balance scope, immutable direct SQL/session-state failures, and final-attempt retry/unknown-commit behavior.
4. Prove reservation/movement races both orders (including direct-SQL movement and historical terminal sessions), exact-expiry replacement, first-balance initiation race, draft revision/batch atomicity, live-reservation submit rejection, submit-versus-movement deadlock regression, and unchanged inventory after submission.

---

## Review 8 Amendments

These clarifications supersede any less-specific statements above.

- **Forward-compatible session state machine:** `stock_opname_sessions_state_guard` intentionally permits only `COUNTING → SUBMITTED` in this task. Before Task 06 adds approval/rejection, its migration must replace that trigger function with the reviewed expanded transition set; Task 06 cannot run against the Task-04-only function. The current plan includes direct-SQL tests for forbidden `SUBMITTED → APPROVED/REJECTED` mutations.
- **FK-safe fixture cleanup:** each stock-opname test removes data in exact order: `audit_logs` rows for the dedicated sessions, then `stock_opname_items`, then `stock_opname_sessions`. Reservations are columns on items and require no separate delete. Dedicated balance/movement/product/user/store cleanup in the suite `after` follows their actual foreign-key order.
- **Uncertain draft response recovery:** session detail returns every item’s `draftVersion`, `countedQty`, `countedAt`, `countedBy`, and `countCutoffVersion`; draft save returns the refreshed affected items. After `COMMIT_OUTCOME_UNKNOWN`, a client must GET own-store session detail and regard its save as committed only if each requested item has the expected next revision and exact intended count/actor/cutoff. Otherwise it may retry only while its reservation is still present/unexpired; a stale retry produces a visible conflict, never duplicate mutation.
- **Reservation whitelist tests:** schema tests directly attempt and reject unexpired reservation clear, token/version/actor/expiry alteration, unexpired replacement, and arbitrary `draft_version` changes. They separately prove only the trigger-permitted expired replacement and reservation-consuming count transition succeed.
- **Ledger/balance failure tests:** a direct SQL `inventory_movements` insert blocked by a live reservation must leave both the movement table and matching balance quantity/version unchanged. The same assertion applies to a normal movement-service request blocked by the trigger; since the service inserts ledger before balance update inside one transaction, trigger failure rolls back the whole write and proves no balance-only mutation.

---

## Execution Log

- Implemented schema migration `003_stock_opname_count_invariants` with session/item guards, draft revisions, reservations, and reservation-aware movement protection.
- Added stock-opname initiation, own-store session list/detail, reservation, draft batch save, and final submission endpoints; inventory balances remain untouched by drafts/submission.
- Added required stock-opname integration scenarios for initiation, duplicate/concurrent sessions, snapshot immutability, role/store authorization, partial/zero counts, duplicate SKU validation, concurrent drafts, final submission, post-submit edit rejection, and unchanged inventory.
- Validation on a freshly rolled back/migrated/seeded disposable PostgreSQL database: `npm run db:typecheck` passed; `DATABASE_URL_TEST=postgres://stock_opname:stock_opname@127.0.0.1:5432/stock_opname_test npm run test:all` passed 16/16 tests.
