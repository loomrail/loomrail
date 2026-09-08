# Q15 guided activation evidence

**Date:** 2026-09-08

**Scope:** fixed Q15 local-subscription activation candidate; private dogfood and real Windows local-CLI execution
remain separate gates

## Implemented boundary

One runtime-validated `GuidedActivationContract` owns the canonical install commands, exact bundled Task and bounded
run policy. The repository verifier compares that source with CLI help, the marked README and EN/RU guide blocks, the
bundled fixture recipe and the protected landing consumer. Unknown fields, unsafe command mutations, policy expansion
and consumer drift fail closed.

`loomrail try` reuses the read-only live-provider readiness probe. A blocked preflight starts no daemon and writes no
state; a ready preflight requires at least one compatible, authenticated local Codex CLI or Claude Code CLI, states
the local state/log side effects, then opens an authenticated `/try` route on loopback. No provider API key, separate
API billing path, production Mock or synthetic success exists.

The web route creates no parallel progress store: it projects Project, WorkItem, PipelineRun, Human Request,
independent Review, measured project verification, Browser QA and AcceptancePackage state through existing commands.
AUTO routing remains domain-owned. A stale preference for an unavailable CLI is recovered only by an explicit owner
action that restores `AUTO`; the UI does not hardcode the alternate provider. Acceptance remains a separate owner
action.

## Local verification

On the fixed candidate:

- `pnpm test:activation` passed 6/6 contract and malicious-mutation checks, including the independent repository
  verifier and protected landing consumer;
- the focused guided browser suite passed 2/2, including the full durable route and the new restart recovery from an
  unavailable Codex preference to an available Claude Code CLI through `AUTO`;
- focused web typecheck and ESLint passed;
- full `pnpm verify` passed: formatting, public-tree/toolchain checks, production audit path, builds, lint, root and
  package typechecks, and all repository unit/integration suites completed without exclusions.

The browser test uses only an injected provider double in test code. No live provider request or paid API request was
made for this evidence refresh.

## Fixed-commit cross-platform evidence

Commit `dd4f5ac3593c45541d8236fe89209d4ac29937e9` was pushed to `main` after the local checks. In
[CI run 34201045784](https://github.com/loomrail/loomrail/actions/runs/34201045784):

- the named guided activation contract passed on macOS and Windows before repository-wide verification;
- Browser smoke passed on macOS and Windows, including the local-provider recovery test;
- clean tarball install and packaged `loomrail try` passed on macOS and Windows;
- both Verify jobs passed the security, process, fault/recovery, portability and complete repository verification
  sequence for the same SHA.

This evidence promotes only Q15 non-landing activation. Protected landing deployment has its own fixed-surface
evidence; real Codex/Claude execution on Windows, private dogfood and npm publication remain pending.
