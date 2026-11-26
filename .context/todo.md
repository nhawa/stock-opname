# Plan: Add Store-Safe, Auditable Movement History

## Context

The committed display update (`60c4656`) is followed by a backend/data enhancement: movement history will expose stable actor identity, actor display name, resulting balance, and a valid stock-opname session ID. The work also closes the existing database gap where `inventory_movements` can reference a user or session from a different store.

The migration runner applies full filename stems lexically, but rollback currently relies on `applied_at, name`, which is ambiguous when migrations share a transaction timestamp. This plan makes lifecycle order explicit by changing rollback to reverse lexical migration name order, adds `005` for composite store FKs, and adds `006` to validate them. `005` is structural and adds composite FKs as `NOT VALID`; `006` validates them in a later maintenance step. Until `006` applies, new/updated rows are still enforced by `NOT VALID` FKs, but old rows require validation/preflight before the integrity claim is complete.

The resulting balance is a complete-ledger invariant: every movement must have a contiguous per-store/product `inventory_version` starting at 1, and every inventory balance mutation must write its ledger movement atomically. The API computes `SUM(quantity_delta)` through each version in a CTE over the complete requested-store ledger before cursor filtering. The latest calculated result must equal `inventory_balances.quantity`. Independent cursor requests are not one snapshot: with descending `(created_at, id)` pagination, newer inserts stay before an already-issued cursor, and a backdated/older insert can occur in later pages. The client deduplicates appended movement IDs, but accepted boundary omissions are documented rather than hidden.

---

## Phase 1: Make migration lifecycle and store ownership deterministic (TDD)

**Why:** Store-safe references and predictable upgrade/rollback behavior must be enforced before history depends on them.

**Test first** → `test/database-schema.test.ts`
- Exercise fresh install, upgrade from every current valid state (including each existing `004_*` pair), and rollback in reverse lexical name order.
- Seed valid current data and verify it survives `005` then `006`.
- Seed pre-existing cross-store actor/session rows in a pre-005 schema and assert `005` preflight fails without a `schema_migrations` record.
- After `006`, assert same-store inserts/updates succeed; cross-store actor/session inserts, updates, and a store-id update fail; nullable actor/non-opname session values remain valid.
- Create valid data under `006`, execute `006` down then `005` down then up/up, and assert data and constraints remain correct.

**Modify** → `scripts/migrate.ts`
- Select the rollback candidate by `name DESC`, matching the lexical up ordering rather than timestamp-dependent `applied_at` ordering.

**New migration** → `db/migrations/005_inventory_movement_store_integrity.up.sql`
- In the runner transaction, preflight actor/session store mismatches with clear errors.
- Add named parent unique constraints `users_store_id_id_key` and `stock_opname_sessions_store_id_id_key`; document operational lock/index-build impact and run this migration during a controlled maintenance window.
- Drop `inventory_movements_actor_id_fkey` and `inventory_movements_stock_opname_session_id_fkey`.
- Add `inventory_movements_store_actor_fkey` and `inventory_movements_store_session_fkey` as `(store_id, actor_id)` / `(store_id, stock_opname_session_id)` composite `ON DELETE RESTRICT NOT VALID` FKs.

**New migration** → `db/migrations/006_validate_inventory_movement_store_integrity.up.sql`
- Validate both named composite FKs during a separately scheduled maintenance step.

**New rollbacks** → matching `005` and `006` down SQL
- `006` down records a reversible validation-step no-op while retaining the structural constraints.
- `005` down preflights store mismatches (which must be absent after `006`), recreates the original named single-column `ON DELETE RESTRICT` FKs, drops composite FKs, then drops parent unique constraints in dependency-safe order.

---

## Phase 2: Return an exact, contract-tested history result (TDD)

**Why:** Managers need attributable movements and balance-after-version values that are correct by ledger invariants, not current-state approximation.

**Test first** → `test/inventory.integration.test.ts`
- Keep manager-only and store-bound history coverage.
- Assert response schema and decimal-string serialization for `actorId`, `actorName`, `balanceQuantity`, and `stockOpnameSessionId`, including null actor/session values.
- Create interleaved multi-product opening-balance, receipt, stock-out, and positive/negative adjustment histories. Assert per-row result, contiguous versions, and equality of each product’s final row balance to `inventory_balances.quantity`.
- Assert only `STOCK_OPNAME_ADJUSTMENT` exposes the session ID; forged `referenceId` cannot create it.
- Establish a cursor from page one, then insert: (a) a newer-than-cursor row, expected outside the next page; and (b) a deliberately older-than-cursor row, expected eligible on the next page. Assert exact expected IDs, no duplicate IDs across client-appended pages, and document accepted concurrent-boundary omission semantics.
- Verify session action authorization remains in `GET /stock-opname/sessions/:id`, including protected cross-store retrieval.

**Modify** → `src/inventory/types.ts`
- Add `actorId: string | null`, `actorName: string | null`, `balanceQuantity: string`, and `stockOpnameSessionId: string | null`.

**Modify** → `src/inventory/repository.ts`
- Build a store-scoped complete-ledger CTE with `SUM(quantity_delta) OVER (PARTITION BY store_id, product_id ORDER BY inventory_version ROWS UNBOUNDED PRECEDING) AS balance_quantity`.
- Apply cursor predicate and `LIMIT` only to the CTE output; retain exactly one row per movement.
- Left join users/sessions by ID and same store as defense in depth; return a session ID only for a qualified `STOCK_OPNAME_ADJUSTMENT` row.

**Performance gate** → representative PostgreSQL dataset
- Seed 50,000 movements across 100 products for one store; run the production history query with `limit=50` for first and later cursor pages.
- Capture `EXPLAIN (ANALYZE, BUFFERS)`. Accept only an execution plan under 750 ms locally with no repeated per-row subquery scans; otherwise stop and revise the CTE/index design before release.

---

## Phase 3: Make client data and navigation testable

**Why:** The new contract should be visible and navigable without stale state or untested page-level behavior.

**New test setup** → `frontend/vitest.config.ts`, `frontend/src/test/setup.ts`
- Add Vitest, jsdom, React Testing Library, and `@testing-library/user-event`; add `npm --prefix frontend run test`.

**New components/tests** → `frontend/src/components/movement-history.tsx` and `.test.tsx`
- Extract the rendered history table and export typed props/helpers.
- Assert actor/result/unit display, null-actor fallback, 5/6-character reference formatting, conditional source action, keyboard activation, row-only loading state, error presentation, append-ID deduplication, and narrow-screen responsive container behavior.

**New controller hook/tests** → `frontend/src/hooks/use-movement-session-navigation.ts` and `.test.ts`
- Own explicit return-origin, per-row request/loading ID, and request-generation guards.
- Test success navigation, stale response discard, error preserving history/selection, and Back returning to Movement History.

**Modify** → `frontend/package.json`, `frontend/src/lib/api.ts`, `frontend/src/app/page.tsx`
- Add focused test tooling and history fields.
- Replace nested table implementation with the extracted component/hook while retaining posting, filters, retry, compact display, and cursor behavior.

---

## Phase 4: Validate and document operational behavior

**Why:** The delivered implementation spans migrations, ledger correctness, concurrency boundaries, performance, authorization, and UI interaction.

**Verification**
1. Migration lifecycle tests prove fresh setup, every valid legacy upgrade state, valid-data survival, bad-data preflight failure, and up/down/up after new data.
2. `npm run db:verify` and `npm run test:api` pass.
3. `npm --prefix frontend run test`, `npm --prefix frontend run lint`, and `npm --prefix frontend run build` pass.
4. The 50k/100-product EXPLAIN gate meets its stated threshold or blocks release for query/index revision.
5. `git diff --check` passes; migration lock/maintenance-window notes are added to execution log.

---

## Critical Files

| File | Action |
|---|---|
| `scripts/migrate.ts` | Modify: deterministic rollback order |
| `db/migrations/005_inventory_movement_store_integrity.{up,down}.sql` | New: composite store relationship structure |
| `db/migrations/006_validate_inventory_movement_store_integrity.{up,down}.sql` | New: validation lifecycle |
| `test/database-schema.test.ts` | Modify: migration lifecycle and constraints |
| `src/inventory/types.ts` | Modify: response DTO |
| `src/inventory/repository.ts` | Modify: complete-ledger result query |
| `test/inventory.integration.test.ts` | Modify: contract, cursor, ledger tests |
| `test/stock-opname.integration.test.ts` | Modify: protected session access |
| `frontend/package.json` | Modify: test tooling |
| `frontend/src/components/movement-history.tsx` | New: table boundary |
| `frontend/src/hooks/use-movement-session-navigation.ts` | New: navigation state boundary |
| `frontend/src/app/page.tsx` | Modify: integrate extracted table/navigation |

## Reusable Components (no changes needed)

- **`api.session`** — remains the only authority for source-session access.
- **`ReviewPage` / `SessionDetails`** — reused through the explicit return origin.
- **Cursor encoding** — unchanged; its non-snapshot concurrency limitation is explicit.
