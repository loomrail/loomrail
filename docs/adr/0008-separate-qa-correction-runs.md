# ADR-0008 — Separate QA correction runs from review rounds

**Status:** Accepted

**Date:** 2026-09-02

## Context

Q1 gives Browser QA measured authority, but a failed QARun deliberately stops on a HumanRequest. Phase 7 requires the
next step: return the WorkItem to fix, independently review the changed tree and execute a scoped retest plus a
regression subset.

The existing `StageAttempt.attempt` cannot be the bound for this loop. It is an operational attempt ordinal and can
advance on a budget or recovery retry before a ReviewReport exists. Review separately caps two automatic rounds plus
one owner-authorized round. Reusing either number for QA corrections can exhaust one loop because another retried,
or silently extend its bound. Re-running the same waiting QA StageAttempt is also insufficient: it has no durable
identity for the fix tree, defect set, locked retest scope or independent review between failure and retest.

Q2 additionally makes the old one-`REVIEW_REPORT`/one-`QA_REPORT` per PipelineRun storage assumption invalid. A
correction changes the implementation tree, so Acceptance must use later evidence without deleting the earlier
append-only history.

## Decision

- A measured `FAILED` QARun creates a durable `CorrectionRun` with its own ordinal inside the PipelineRun. The ordinal
  is independent from every StageAttempt attempt and from R1 review rounds.
- Each CorrectionRun owns one immutable source QA failure, a snapshot of the OPEN QADefects it must address and one
  immutable `QARetestPlan`.
- StageAttempts created for that correction carry its identity. Their `attempt` is a unique operational ordinal
  inside the stage/correction cycle; budget or recovery retries may advance it independently.
- ReviewReport `round` is derived from earlier append-only reports in the same PipelineRun/correction cycle. A
  correction's first report is round 1 even when its REVIEW StageAttempt has a higher operational ordinal; the
  existing optional final owner-authorized Review round remains 3.
- Two CorrectionRuns may start automatically. A failed retest in the second opens a domain-owned HumanRequest; the
  owner may authorize exactly one final CorrectionRun or cancel the PipelineRun.
- A QARun `ERROR` is an environment/driver retry on the same QA StageAttempt and never creates or consumes a
  CorrectionRun.
- The daemon derives the retest cells from the locked baseline plan, measured failures, blocking observations and
  OPEN defects. Provider output cannot select, remove or reorder the scope.
- A passing scoped retest resolves the CorrectionRun's OPEN defects with SYSTEM attribution. `WAIVED` remains an
  owner disposition with a reason, but never manufactures a passing QARun or skips retest.
- Review reports and compact EvidenceArtifacts become append-only per StageAttempt/correction rather than unique per
  PipelineRun kind. Acceptance selects current-tree review evidence and validates the full-QA → correction → passing
  retest lineage.
- Current state, defect dispositions, events and the next dispatch or HumanRequest are persisted in one SQLite
  transaction. WebSocket/SSE remains invalidation delivery only.

## Consequences

### Positive

- R1 and Q2 have independent, explicit bounds and can be reasoned about or tested separately;
- every automatic fix has a durable reason, locked evaluator and exact source failure;
- a provider cannot hide a failing cell by editing the QA manifest during correction;
- Acceptance can explain the complete append-only evidence chain for the current tree;
- restart and duplicate commands cannot reset either loop counter or enqueue parallel corrections.

### Costs and risks

- StageAttempt, ReviewReport, QARun and EvidenceArtifact gain correction lineage;
- the current SQLite uniqueness constraints for review/evidence artifacts require an additive migration that rebuilds
  those tables while preserving old rows as the initial, non-correction cycle;
- scoped current-tree evidence is meaningful only together with its locked baseline and correction lineage, so every
  reader must validate the chain rather than looking for an arbitrary latest `PASSED` row;
- nested bounds are visible: one CorrectionRun may itself stop at the existing R1 owner gate before it reaches retest.
- operational retries cannot prematurely exhaust Review or collide with an earlier IMPLEMENT attempt number.

## Rejected alternatives

- **Reuse `StageAttempt.attempt`:** conflates two independent policies and breaks when initial review used its limit.
- **Resume the failed QA StageAttempt after prose says “fixed”:** has no implementation/review tree boundary and lets
  provider text control workflow truth.
- **Always rerun the full matrix:** safe but contradicts the Phase 7 scoped-retest outcome and scales poorly; a locked,
  bounded regression subset preserves targeted coverage.
- **Start a new PipelineRun per defect:** loses one delivery's audit/evidence chain and resets unrelated budgets and
  owner gates.

## Required tests

- initial review round 3 can still create CorrectionRun 1 whose review begins at round 1;
- technical StageAttempt attempt 4 can still persist ReviewReport round 1 and queue a unique next IMPLEMENT attempt;
- two automatic corrections and one owner-authorized correction are the absolute total bound;
- QARun ERROR/retry does not change the correction ordinal;
- duplicate failure completion cannot create a second CorrectionRun or dispatch;
- restart preserves correction status, retest scope and current StageAttempt;
- Acceptance rejects stale, unrelated, incomplete or provider-selected evidence lineage.
