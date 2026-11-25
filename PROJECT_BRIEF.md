# Stock Opname Management System — Project Brief

> Planning reference, not a completed assessment submission. Candidate owns design, code, verification, and any `NOTES.md` answers. The original assessment prohibits AI-generated submissions; a later recruiter clarification permits guided assistance when the candidate actively directs the work. Confirm any remaining ambiguity with the recruiter.

## Objective
Build a responsive stock-opname web app and REST API for multiple stores, covering manager initiation, staff physical counts, manager review, and inventory adjustments after approval.

## Source-of-truth and scope
The original **Take-Home Technical Assessment: Stock Opname App V5** defines required capabilities and deliverables. The candidate's subsequent design document expands them into an inventory ledger and concurrency model. Where they differ, the original assessment defines minimum scope; below are candidate-selected design choices, not employer-mandated requirements.

### Required capabilities
- Products with unique SKU and system stock quantities; multiple stores.
- Login, secure session/token handling, `STAFF` and `MANAGER` access control.
- Manager can initiate a store's stock-opname session, review a submitted count, approve or reject it.
- Staff can enter quantities for products in their own store, including batched submissions.
- Responsive frontend for login, staff counting and manager review.
- Public GitHub repository with backend, frontend, README setup instructions and **candidate-authored** `NOTES.md`.

### Agreed MVP decisions
- **Stack:** Express.js + TypeScript API; Next.js + TypeScript frontend; PostgreSQL; modular monolith; REST; Docker Compose for local database/setup if useful.
- **Identity:** one user = one role (`STAFF` or `MANAGER`) = one store. No `user_store_roles` join table. This is an explicit MVP assumption, not a literal restriction on managers in the employer brief.
- **Inventory:** balances scoped to `(store_id, product_id)`; inventory movements run independently of stock-opname sessions and form a ledger.
- **Session:** manager explicitly initiates; snapshot quantity/version captured consistently and kept immutable. At most one `COUNTING` or `SUBMITTED` session per store (database partial unique index plus friendly API validation).
- **Counting:** per-SKU physical counts; `NULL` means uncounted; `0` is a valid physically counted zero. Partial draft saves and one final submission. Repeated SKU in one batch rejected. Final submit locks counts; uncounted SKUs have no adjustment.
- **Recount:** rejected session remains historical; create a new session (optional `recount_of_session_id`), not reopen old one.
- **Movement reconciliation:** at approval, compute expected stock at each SKU's **count cutoff**, derive variance, then apply delta to locked current balance rather than overwriting it with the counted quantity.
- **Cutoff:** ledger position/version tracked per `(store, product)`; inventory movement and cutoff capture coordinate with a database row lock. Physical stock movement must be operationally coordinated during counting; database locks alone cannot guarantee a physical count matches the digital cutoff.
- **Approval:** atomic transaction, session row lock, deterministic ordering of affected inventory row locks, immutable movements, unique adjustment reference per session/product, status validation, rollback on failures; a second approval must never create additional movements.

## Core workflows

### 1 — Manager initiation
Authorize manager against their own store; reject if active session already exists; take a consistent immutable snapshot of in-scope products and balance versions; transition new session into `COUNTING`. Scope of absent/zero-inventory product rows must be decided and tested before implementation.

### 2 — Staff counting
Authorize staff to their own store and a `COUNTING` session. Staff enters batched nonnegative quantities, saves draft and a coordinated per-SKU cutoff/version. A re-count or edited quantity needs a new valid cutoff corresponding to the new physical observation, not merely a later Save timestamp. Submit once to transition to `SUBMITTED`; inventory is unchanged.

### 3 — Manager approval
Authorize manager; lock session and verify `SUBMITTED`; lock affected inventory balances in a stable order; calculate movements **after snapshot and up to cutoff**; derive expected stock and variance for counted items only; insert unique adjustment movements, update balances/version, record audit, mark `APPROVED`; commit or roll back entirely. Rejection records reason and leaves inventory unchanged.

### Reconciliation formulas
For a counted product at one store:

```
expected_at_count = snapshot_qty + SUM(movement.quantity_delta
  WHERE snapshot_version < inventory_version <= count_cutoff_version)
variance = counted_qty - expected_at_count
final_stock = locked_current_stock + variance
```

A later receipt or sale remains reflected in `locked_current_stock`. A count is valid only if its physical scope corresponds to the recorded cutoff. Counts for products with `counted_qty IS NULL` are excluded.

### Example for tests (not assessment prose)
- At snapshot: quantity 100, version 1.
- Sale -5 (version 2), staff counts 93 with cutoff version 2.
- Receipt +20 (version 3), current balance 115.
- Approval expected at count 95; variance -2; adjusted balance 113 (version 4).

## Proposed logical data model (review before migrations)
1. `stores`: id, code unique, name, is_active.
2. `users`: id, store_id not null FK, email unique, name, password_hash, role checked (`STAFF`, `MANAGER`), is_active, timestamps.
3. `products`: id, sku unique, name, unit, is_active.
4. `inventory_balances`: `(store_id,product_id)` composite PK/FK, quantity numeric(14,3), version bigint >=0, updated_at.
5. `inventory_movements`: id, `(store_id,product_id)` FK to balance, inventory_version, movement_type, quantity_delta, reference_type/id, actor_id, created_at, unique `(store_id,product_id,inventory_version)`.
6. `stock_opname_sessions`: id, store_id, status, actor IDs and timestamps for initiation/submission/approval/rejection, rejection_reason, optional recount_of_session_id, timestamps; one-active-per-store partial unique index.
7. `stock_opname_items`: id, session_id, product_id, immutable snapshot_qty/version, nullable counted_qty/cutoff_version/count time/actor, unique `(session_id,product_id)`; count/cutoff NULL consistency and nonnegative quantities.
8. `audit_logs`: id, session_id (nullable where appropriate), actor_id, action, metadata JSONB, created_at.

Important database invariants: unique adjustment source `(session, product)` for stock-opname adjustments; adjustment references must be present; no double approval; no balance write without its ledger entry; proper foreign keys/checks/indexes. Define policy for negative adjusted stock and duplicate external receipt requests before coding.

## State machine
```
COUNTING --final submit--> SUBMITTED --approve--> APPROVED
                                     \\--reject--> REJECTED
COUNTING --cancel--> CANCELLED
```
`APPROVED`, `REJECTED`, `CANCELLED` are terminal in the MVP. Recount = new session, optionally linked to rejected session.

## Security
- Authenticate on backend; password hashes, expiry and safe token/session handling.
- Do not trust client-provided `store_id`; verify resource ownership on every read/write.
- Staff: view/count/submit for their assigned store only.
- Manager: initiate/review/approve/reject for their assigned store only.
- Avoid including passwords, secret keys, database URLs in the public repository.

## Required frontend (minimal)
- Login.
- Session list with state and progress.
- Staff counting screen with batch draft save, explicit zero vs uncounted, final submit.
- Manager review with expected/counted/variance and approve/reject.
- Inventory movement history/receiving UI is optional beyond what is needed to demonstrate movement reconciliation.

## Critical tests to design and execute yourself
1. Login, role and cross-store access rejection.
2. Two concurrent initiations for the same store -> only one active session.
3. Snapshot consistency while receiving runs.
4. Count missing vs zero; duplicate SKU; negative quantity; unknown/out-of-scope SKU.
5. Draft update and final-submit immutability.
6. Sale before cutoff and receipt after cutoff -> correct delta adjustment.
7. Concurrent movement and cutoff on same inventory row.
8. Two concurrent approvals -> one adjustment per counted SKU.
9. Failure after inserting one movement -> entire approval rolls back.
10. Reject and new recount session preserve history.

## Open decisions candidate must validate
- Inventory scope when a product has no balance row, and whether zero-quantity items are included in snapshots.
- Who may post receiving/stock-out adjustments and how duplicate requests are deduplicated.
- Count entry protocol ensuring the recorded cutoff matches *physical* stock; define a recount response if that cannot be guaranteed.
- Unit-of-measure/decimal policy and whether inventory may go negative.
- Snapshot isolation and lock strategy (and deadlock handling) across many SKUs.
- API error codes, pagination and audit metadata.

## Deadline
Thursday, 26 November 2026 at **13:00 WIB / 14:00 WITA**. Prioritize an end-to-end working core and tests over optional extras. Submit a public repository link by replying to the invitation email.
