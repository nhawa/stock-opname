# Coding Agent Collaboration Rules

This repository is for a recruitment assessment. The original PDF forbids AI-generated work; a later recruiter follow-up conditionally allows AI guidance when the candidate directs implementation step by step. **Do not generate the whole assessment in one shot.** Candidate must understand and own the implementation and write their own `NOTES.md` in their own words.

## Operating mode
1. Read `PROJECT_BRIEF.md` and `IMPLEMENTATION_PLAN.md` first.
2. Work on **one numbered task only** after the candidate asks for it. First return a small plan, assumptions, files expected to change, and tests. Ask the candidate to approve the design before applying changes.
3. Explain any architecture trade-offs; do not silently decide an unspecified business rule.
4. Keep diffs narrow and reviewable. After implementing one task, report file changes, commands run, test results and remaining limitations; stop for review.
5. Do not write `NOTES.md` or any candidate's first-person reasoning. Candidate authors it; agent may critique a draft for consistency if explicitly asked.
6. Do not fabricate tests, production behavior, benchmark results or documentation claims.
7. No secrets in source control. Never remove database constraints or authorization checks to make a test pass.
8. Preserve core consistency rules: one user/role/store, one active session/store, immutable snapshot, per-item cutoff, atomic ledger+balance, unique adjustments, cross-store authorization.
9. Do not replace candidate-approved movement reconciliation with version-conflict rejection. Highlight any new unresolvable physical cutoff ambiguity rather than silently treating a Save timestamp as exact physical count time.
10. Favor working MVP with simple components over new infrastructure, generalized frameworks, queues or complex abstractions.

## Typical review cycle
- Candidate: "Task 01: propose schema and explain assumptions; do not edit files yet."
- Agent: plan + migration outline + risks.
- Candidate: approves/changes choices and asks for a focused implementation.
- Agent: focused patch + tests + review summary; then stops.

## Proposed local stack
- Node.js + TypeScript + Express.js API
- Next.js + TypeScript frontend
- PostgreSQL
- SQL migrations through a candidate-selected tool (do not assume Prisma/Drizzle until selected)
- Docker Compose if useful for a reproducible local environment

## Definition of done for any unit of work
- Requirements and assumption stated.
- Auth and input validation considered where applicable.
- Transaction/locking behavior reviewed where applicable.
- Tests added or manual verification steps documented.
- No unrelated functionality added.
- Candidate can explain the change without AI-generated narrative.
