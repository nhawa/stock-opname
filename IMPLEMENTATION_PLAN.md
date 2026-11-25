# Iterative Implementation Plan

> This is a planning checklist, not evidence of completion. The candidate should tick boxes only after personally reviewing changes and verifying behavior.

## Gate 0 — Confirm foundation choices
- [ ] Candidate reviews `PROJECT_BRIEF.md` and verifies employer PDF requirements.
- [ ] Choose DB access and migration tooling; decide database locking/isolation contract.
- [ ] Decide physical count cutoff protocol and document its operational limitation.
- [ ] Decide receiving permissions, negative-stock policy and initial balance representation.

## Task 01 — Schema proposal and migrations
- [ ] Create/review migrations for eight agreed tables, FKs, CHECKs, unique indexes.
- [ ] Enforce `users.store_id NOT NULL`, exactly one role (`STAFF`/`MANAGER`).
- [ ] Enforce one active `COUNTING`/`SUBMITTED` session per store.
- [ ] Enforce one stock-opname adjustment per session/product at DB level.
- [ ] Initialize balance with `(quantity=0, version=0)`; any opening quantity is versioned as ledger movement.
- [ ] Seed two stores, one staff and one manager per store, and illustrative products and opening balances.
- [ ] Verify migrations up/down and query test constraints.

## Task 02 — API foundation and authorization
- [ ] Express app, typed configuration, input validation, consistent error response.
- [ ] Login and authenticated current-user endpoint.
- [ ] Role and store-bound authorization tested across stores.

## Task 03 — Inventory ledger
- [ ] Atomic receiving and stock-out endpoints.
- [ ] Lock balance row, allocate next per-store/product version, insert movement, update quantity/version in same transaction.
- [ ] Prevent duplicates with business transaction reference/idempotency policy.
- [ ] Verify correct quantity and ledger after concurrent updates.

## Task 04 — Session initiation
- [ ] Manager-only own-store initiation.
- [ ] Snapshot all in-scope inventory balances consistently, with quantity and version.
- [ ] Reject active-session duplication, including simultaneous requests.
- [ ] Return session detail/list with status.

## Task 05 — Count drafts and final submission
- [ ] Staff-only own-store count input.
- [ ] Batch input validates duplicate/unknown/out-of-scope SKU and nonnegative values; zero remains distinct from uncounted.
- [ ] Save draft with a valid coordinated physical cutoff/version per item.
- [ ] Reject silent cutoff refresh without a new physical observation.
- [ ] Final submit freezes items and leaves inventory balances unchanged.

## Task 06 — Approval/rejection
- [ ] Manager-only own-store review.
- [ ] Lock session and affected balances in stable order.
- [ ] Reconcile ledger movements between snapshot and cutoff per item.
- [ ] Write one unique adjustment movement per counted item, update balances, audit and session status atomically.
- [ ] No adjustment for uncounted items.
- [ ] Reject records reason, no balance change; recount creates new session.
- [ ] Add concurrency + rollback tests.

## Task 07 — Frontend vertical slice
- [ ] Login and role-specific access.
- [ ] Staff: list, count, save draft, final submit, progress.
- [ ] Manager: initiate, review differences/uncounted, approve/reject.
- [ ] Display API errors including stock/count conflicts and invalid states.

## Task 08 — Candidate validation and submission
- [ ] Run a full staff -> manager approval workflow.
- [ ] Test receiving before and after cutoff, race scenarios, double approval, cross-store authorization.
- [ ] Candidate writes `README.md` instructions accurately based on actual working commands.
- [ ] Candidate writes `NOTES.md` entirely in own words, addressing all assessment questions.
- [ ] Remove secrets, verify fresh setup, publish repo, submit link before deadline.

## Stop conditions
Do not proceed to optional CSV, barcode, ERP sync or background workers until core functionality is verifiably working. If time becomes tight, freeze features and favor correctness, a working demonstration and candidate-authored documentation.
