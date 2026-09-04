# Q15 guided activation evidence

**Date:** 2026-09-04

**Scope:** Q15 non-landing candidate; local macOS arm64 verification; Windows execution and protected landing pending

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

The protected `apps/landing/**` tree was not changed or excluded. Windows-safe paths and CI execution are present,
but this document does not claim a Windows run before CI records one. Q15 always uses Mock; it is not evidence for a
live Codex or Claude Code compatibility row.

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
- `pnpm test:public-readiness`: the 680-file public-tree check, pinned toolchain check and guided-activation verifier
  passed.
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

macOS/Windows CI evidence is recorded only after the candidate reaches a fixed commit. Stable publication remains
blocked by the protected landing, private dogfood, Windows live-provider compatibility and trusted-publisher
provenance gates.
