# Q15 guided activation evidence

**Date:** 2026-09-04

**Scope:** fixed Q15 non-landing candidate with local and macOS/Windows CI evidence; protected landing and Windows
live-provider verification pending

## Implemented boundary

One runtime-validated `GuidedActivationContract` owns the canonical install commands, the exact bundled Q10 Task and
its Mock policy. The repository verifier compares that source with CLI help, the marked README and EN/RU guide blocks,
the bundled fixture recipe and the named macOS/Windows CI step. Unknown fields, unsafe command mutations and recipe
drift fail closed.

`loomrail try` reuses the read-only Mock readiness probe. A blocked preflight starts no daemon and writes no state; a
ready preflight states the local state/log side effects, then opens an authenticated `/try` route on loopback. The web
route creates no parallel progress store: it projects Project, WorkItem, PipelineRun, Human Request, budget pause,
Review, measured Browser QA and AcceptancePackage state through existing commands. Acceptance remains a separate
owner action.

The protected `apps/landing/**` tree was not changed or excluded. Q15 always uses Mock; its passing Windows fixture
evidence is not a live Codex or Claude Code compatibility row.

## Local verification

- `pnpm test:activation`: 4/4 contract and malicious-mutation checks passed, including the independent repository
  verifier.
- `pnpm typecheck`: all workspace and E2E TypeScript projects passed.
- `pnpm test`: all 22 workspace projects passed; web 77/77 and CLI 38/38.
- `pnpm test:e2e`: 54/54 passed. The guided case covers keyboard entry, exact task creation, reload, daemon restart on
  the same SQLite state, Human Request, explicit budget change, Review/QA evidence, manual Acceptance, RU/EN,
  light/dark and a 390 × 844 viewport.
- `pnpm pack:release && pnpm test:release`: clean tarball install, receipt, audit, setup, guided `try`, daemon,
  Workbench, Doctor, data-path and log lifecycle checks passed; nothing was published.
- `pnpm test:public-readiness`: the public-tree, pinned toolchain and guided-activation checks passed.
- Focused ESLint over every changed non-landing TypeScript/JavaScript file passed. A separate repository-wide lint
  invocation still has only the three existing protected landing findings at `apps/landing/src/main.ts` lines 630,
  631 and 634.
- `pnpm verify` stops at its first formatting stage on two unrelated untracked research files,
  `docs/research/cripthub-gray-settlement-model-primary-sources.ru.md` and
  `docs/research/skin-case-legal-primary-sources.ru.md`. This slice does not edit, format, exclude or stage them.

## Independent review

The first Standards/Spec pass found four material gaps: standalone destructive/network commands could pass the
contract, CLI help did not consume the canonical source, Review/QA were collapsed into one guided phase, and final
continuations did not open repository/provider setup. Standards also found that resolved `RETURNED | REJECTED`
packages were rendered as pending and that the Q15 threat delta was absent.

The corrected candidate accepts only the exact five reviewed commands in exact order, renders those commands directly
in CLI help, projects Human Request/Review/QA/Acceptance separately, treats every owner disposition as terminal, opens
Settings for repository/provider connection, exposes a bounded Guided Launch explanation and records T49 controls.
Fresh independent Standards and Spec re-reviews found no remaining P0/P1/P2 issue.

## Fixed-commit cross-platform evidence

Commit `cebfc5190bc0e090291143898d133c3c0f9b87b7` was pushed as
[`feat: add canonical guided activation route`](https://github.com/loomrail/loomrail/commit/cebfc5190bc0e090291143898d133c3c0f9b87b7).
In [CI run 33910486837, attempt 2](https://github.com/loomrail/loomrail/actions/runs/33910486837/attempts/2):

- the named guided activation contract passed before repository-wide lint on macOS and Windows;
- Browser smoke passed all 54 cases on macOS and Windows, including the full `/try` journey;
- clean tarball install and packaged `loomrail try` passed on macOS and Windows;
- macOS fault/recovery passed; the first Windows attempt timed out one pre-existing restart test after 208 passes,
  and the isolated Windows Verify retry passed the complete fault/recovery gate;
- both Verify jobs then built every workspace package and stopped only at the same three protected
  `apps/landing/src/main.ts` lint findings on lines 630, 631 and 634.

This closes Q15's non-landing cross-platform source/browser/package evidence without weakening a gate. Q15's
protected public consumer, stable publication, private dogfood, Windows live-provider compatibility and
trusted-publisher provenance remain separate open gates.
