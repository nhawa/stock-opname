# Plan: Recover expired/stale count reservations (focused scope)

## Context

A stale browser reservation can still display **Reserved** after the server rejects Save draft with `STALE_DRAFT`. The user selected the focused recovery instead of the larger concurrency refactor: detect the backend error code, reload the active session’s detail, replace the affected Count screen item state, and prompt the user to reserve and count again. This intentionally does not introduce the broader timer/generation state machine.

---

## Phase 1: Preserve the server error code

**Why:** The UI must identify `STALE_DRAFT` using the stable API contract rather than matching human-readable text.

**Modify** → `frontend/src/lib/api.ts`
- Export a minimal runtime `ApiError` with `code` and `status`.
- Preserve backend error code/message in failed requests.

---

## Phase 2: Refresh stale Count rows

**Why:** A direct session refresh replaces the stale token so the existing row can present Reserve again.

**Modify** → `frontend/src/app/page.tsx`
- On `STALE_DRAFT` from Save draft, request `api.session(session.id)`.
- If the detail response remains `COUNTING` and includes items, replace Count component local items from that response and tell the user to reserve/count again.
- If refresh fails, retain the normal error message; do not claim recovery succeeded.

---

## Phase 3: Verification

**Why:** This focused patch modifies error handling and the Count screen integration.

**Verification**
1. Run `npm run db:typecheck`.
2. Run `npm --prefix frontend run build`.
3. Manually allow a reservation to go stale, click Save draft, and verify the UI refreshes from server state so the product can be reserved again.

## Scope Decision

This is the user-selected focused implementation after the five-review limit. It does not include the reviewer’s larger state-machine refactor, new component-test infrastructure, or client expiry timer.
