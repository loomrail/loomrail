# ADR-0004 — One provider owner gate until an explicit StageAttempt retry

**Status:** Accepted

**Date:** 2026-08-29

## Context

A real D2 Codex route opened a valid HumanRequest in Discovery, received a durable Decision, and then repeatedly
returned another `NEEDS_HUMAN` from the resumed session. Prompt wording, authoritative Decision context and putting
the normal result first in the output union reduced ambiguity but did not define a deterministic product boundary:
the branch remained structurally available, so the provider could keep selecting it forever.

The first correction closed the branch only for the resumed Discovery attempt. The next real run proved that boundary
too narrow: Discovery completed, then the automatically created PLAN attempt opened a process-confirmation request
whose own context said no owner information was missing. A per-attempt allowance therefore still let every normal
stage manufacture one gate and stop the route repeatedly.

`WorkflowDispatch.mode === "RESUME"` cannot define the boundary by itself. The same mode is used after a soft pause
or interrupted run, where the StageAttempt may never have asked the owner anything.

## Decision

- The normal first-attempt path of one PipelineRun may open at most one provider-authored blocking owner gate. Once it
  is used, automatic progression to later stages does not replenish it.
- An explicit retry (`StageAttempt.attempt > 1`) receives one fresh gate. Once that retry opens a HumanRequest, its
  own resumed sessions cannot open another.
- The daemon derives whether the gate was used from durable HumanRequests attached to StageAttempts in the current
  PipelineRun, not from prompt text, provider state, session ordinal or dispatch mode.
- `ProviderInvocation.humanRequests` carries the resulting `ALLOWED | DISALLOWED` policy explicitly.
- Both live adapters use the policy twice: the CLI JSON Schema omits `NEEDS_HUMAN` when it is disallowed, and the
  shared decoder rejects that result if a CLI nevertheless emits it.
- An answered HumanRequest remains visible as an authoritative Decision in the resumed context. The provider must
  complete the current stage using that answer.
- A genuinely new business blocker is not represented as another question on the automatic stage path. It requires
  an explicit retry/new StageAttempt; no provider output silently creates that retry in Phase 0.
- The AcceptancePackage remains a separate domain-owned owner gate. `READY_FOR_ACCEPTANCE` is still valid when
  provider HumanRequests are disallowed, and only the owner can accept, return or reject it.

Operational fail-closed questions remain possible when a CLI cannot start, reports a failure or ignores the output
contract. They diagnose infrastructure/provider failure and never advance the stage; they are not a second
provider-authored business decision.

## Consequences

### Positive

- a provider cannot keep a StageAttempt in an unbounded question/answer loop or manufacture one process-confirmation
  gate on every automatically following stage;
- the rule survives daemon restarts and provider swaps because it is derived from durable workflow state;
- soft-pause and interruption recovery keep the owner gate available when the current run has opened none;
- an explicit retry receives a fresh, bounded gate without resetting the whole PipelineRun;
- schema generation and decoding share one provider-neutral policy.

### Costs and risks

- after the normal run path uses its gate, providers must finish later first-attempt stages from recorded state or
  fail closed; they cannot introduce a newly discovered business choice until an explicit retry;
- Phase 0 has no automatic generic retry for this case, so recovery requires an explicit workflow control that
  creates a new StageAttempt;
- system recovery questions and provider business questions must remain visibly distinguishable in later cockpit
  work.

## Required tests

- the policy-disabled schema contains the normal result and no `NEEDS_HUMAN` branch;
- the shared decoder rejects `NEEDS_HUMAN` under the disabled policy;
- Codex and Claude Code pass the policy into both schema generation and decoding;
- a live-shaped daemon route sends `ALLOWED` before the first question and `DISALLOWED` after its Decision, including
  automatically following stages;
- `READY_FOR_ACCEPTANCE` remains valid under the disabled policy and still opens the separate owner acceptance gate.
