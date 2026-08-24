# Phase 0 / M6 acceptance evidence

**Verified:** 2026-08-24  
**Baseline:** `32da5f0`  
**Scope:** typed Review/QA evidence, durable AcceptancePackage, owner-only completion gate, Workbench acceptance UI

## Automated gates

- `pnpm verify` — formatting, public-tree scan, build, lint, typecheck and all workspace tests;
- `pnpm test:e2e` — seven authenticated browser scenarios, including the full mock workflow through owner Accept;
- daemon regression coverage for an existing database that already contains immutable workflow template version 1;
- domain regression coverage preventing generic HumanRequest answers and generic cancel from bypassing acceptance;
- SQLite coverage for restart persistence, idempotent Accept, append-only evidence and migration v4 → v5 compatibility.

## Manual browser review

The production build was launched through the CLI at `http://127.0.0.1:4176/` against the maintainer's migrated local
database. The reviewed path was:

```text
New task → Ready → Discovery decision → budget hard pause → budget override
  → Implement → Review evidence → QA evidence → owner acceptance → Done
```

Verified surfaces:

- desktop and 390 × 844 mobile viewport;
- light and dark themes;
- English and Russian UI;
- acceptance evidence remains readable and all three owner actions remain reachable on mobile;
- command summary and Attention banner update after budget override and after final acceptance;
- no application console errors. The only warnings came from an unrelated browser extension content script.

## Review findings closed

1. The expanded M6 workflow originally reused immutable template version 1. A migrated real database correctly
   rejected the changed payload with `PERSISTENCE_FAILURE`. The template is now version 2 and a daemon regression test
   reproduces the legacy-database path.
2. A pending acceptance request could originally be targeted by the generic HumanRequest answer command even though
   the UI hid that action. The domain now rejects this bypass; acceptance can only be resolved through its explicit
   package command.
3. Generic pipeline cancellation is rejected while an AcceptancePackage is pending, so the owner gate cannot be
   closed through an unrelated lifecycle command.

## Result

M6 meets the locked contract in
[`05-phase-0-m6-implementation-plan.ru.md`](../../plans/05-phase-0-m6-implementation-plan.ru.md): providers cannot mark
work Done, Review and QA evidence is durable, and only an authenticated human Accept transition produces `DONE` and a
successful PipelineRun.
