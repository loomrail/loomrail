# ADR-0012: Enforceable provider token budgets

**Status:** Accepted

**Date:** 2026-09-06

## Context

Private dogfood measured a Codex PLAN session at 493,700 tokens against an immutable 200,000-token AgentRun
ceiling. The adapter reported correct cumulative usage, but only on terminal `turn.completed`. Loomrail then
hard-paused the workflow; it could not undo or prevent the spend already incurred.

`codex exec` exposes no token, turn, cost, request or timeout budget. Claude Code exposes a USD ceiling, but the
owner-authored Loomrail boundary is currently estimated tokens, so it cannot guarantee that token boundary either.
Calling either behavior a hard token budget violates BD-001.

## Decision

Every provider adapter declares `tokenBudgetEnforcement` as `HARD` or `POST_SESSION`.

- `HARD` means the adapter accepts the immutable AgentRun remainder in `ProviderInvocation` and prevents provider
  work from crossing it.
- `POST_SESSION` means usage is useful for accounting and for stopping later work, but cannot bound the active
  session.
- A managed run with Loomrail's token hard budget may start only on `HARD`. `POST_SESSION` is refused before a
  ProviderSession is created or a provider process is spawned.
- AUTO excludes `POST_SESSION` live providers. Explicit selection keeps diagnostics visible but does not bypass the
  daemon gate.
- Raising a budget cannot waive this capability requirement.

Mock declares `HARD` because it performs no billable provider work. Current Codex and Claude Code adapters declare
`POST_SESSION`.

## Consequences

Live managed runs are blocked until a provider/runtime offers an enforceable token limit or Loomrail adds a separate
owner-approved budget unit that the provider can natively enforce. Mock onboarding and deterministic verification
remain available. Historical terminal usage and Q13 atomic pause semantics remain valid accounting controls, but are
no longer described as preventive enforcement.

Windows code follows the same contract; live Windows verification remains deferred by owner decision.
