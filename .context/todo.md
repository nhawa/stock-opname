# Task 05.1 — Backend Verification & Stabilization Plan

## Assessment

Docker Engine and Docker Compose are installed, but PostgreSQL is not currently listening on port 5432. The repository’s `docker-compose.yml` currently starts only the development database (`stock_opname`); `.env.example` already documents a separate disposable `stock_opname_test` URL, but Compose does not create it.

**No schema change is proposed before testing.** Migration `004_stock_opname_approval_invariants` is the existing Task 05 schema change and must first be applied/verified against a clean database. Any additional migration will be proposed only if an executed test reveals a database-level invariant gap.

## Approach

1. **Isolated test database configuration**
   - Add a Compose initialization script mounted only into the existing PostgreSQL container that creates `stock_opname_test` when the container’s data directory is first initialized. It uses the existing local Compose role; no URL or password is written to source control or echoed in reports.
   - Use a temporary shell export for `DATABASE_URL_TEST` when running migrate/seed/test commands. Do not commit a `.env` file.
   - Start Compose, wait for its health check, and apply all migrations plus seed data to the test database through the existing migration/seed scripts.

2. **Verification baseline**
   - Execute `npm run db:typecheck`, `npm run db:verify`, and `npm run test:all` with `DATABASE_URL_TEST` set only for the invoked commands.
   - Record actual pass/fail results. Investigate failures from the database constraint, migration, route, and service layers—not by weakening authorization or database invariants.

3. **Approval/reconciliation verification**
   - Review and execute the existing approval/rejection cases, then add only missing backend tests for: no movement, receiving/stock-out before and after cutoff, partial/uncounted/zero variance, rejection, duplicate/concurrent approval, approval-vs-receipt/stock-out, invalid cutoff, rollback, balance/ledger consistency, and cross-store access.
   - Exercise serializable retry (`40001`) and deadlock retry (`40P01`) through controlled test/database conditions where feasible. Confirm a commit-outcome-unknown response is recoverable by reading session status and the session/product adjustment records, rather than replaying an approval blindly.

4. **Precision and stabilization**
   - Keep approval reconciliation in PostgreSQL `numeric`/`bigint` expressions.
   - Audit `src/inventory/service.ts` for `Number` usage. Replace only calculations that can lose precision within supported `numeric(14,3)` or `bigint` ranges, using SQL calculations or exact representation consistent with existing architecture.
   - Rerun the complete suite after every narrow fix.

5. **Commit and report**
   - Review diff and test outputs, commit verified Task 05/05.1 changes with a focused message, and report configuration without credentials, exact executed tests/results, fixes, and limitations.

## Risks

- Compose initialization scripts run only for a fresh volume. Existing local volumes may require an explicit SQL `CREATE DATABASE` step; that remains isolated and does not alter production/development data.
- True `COMMIT_OUTCOME_UNKNOWN` is a network-boundary condition and may not be deterministically reproducible in the suite. Its recovery path can still be validated through status/ledger reads.
- Deadlock and serialization failures require deterministic orchestration; if the test environment cannot reliably induce them, this will be documented rather than claimed as passed.

## Files Expected to Change

- `docker-compose.yml` and a new local Compose init SQL script, if needed to initialize the isolated test database.
- Test files only where executed coverage exposes gaps.
- `src/inventory/service.ts` only if the precision audit finds an actual supported-range risk.
- No migration unless a proven constraint defect requires one.
