# ADR-0016: Stable release gates follow the local subscription CLI boundary

**Status:** Accepted

**Date:** 2026-09-07

## Context

PD-019 and ADR-0015 removed direct OpenAI Responses and Anthropic Messages transports from production and accepted
honest `POST_SESSION` token accounting for local subscription-backed CLIs. The strict stable-release manifest still
used schema version 2, required a `liveProviderHardTokenBudgetEnforcement` gate and described macOS/Windows evidence
as API captures. That stale interface could either block the approved product forever or invite an unsafe API
fallback merely to satisfy a retired gate.

The manifest is a fail-closed release interface. Historical `PASSED` evidence must remain exact, while changed
product authority must not be represented by editing the meaning of an existing key in place.

## Decision

`STABLE-RELEASE-GATES.json` moves to schema version 3 and retains exactly eleven gates. It replaces only
`liveProviderHardTokenBudgetEnforcement` with `q20LocalSubscriptionWorkspaceExecution`.

The replacement gate proves the combined approved capability:

- production starts only compatible, locally authenticated Codex CLI or Claude Code CLI processes;
- IMPLEMENT and QA reach the provider-neutral bounded workspace executor through the session-scoped proxy;
- mutation, read-only QA, audit, idempotency, restart recovery and secret exclusion are verified;
- subscription runtimes are labelled `POST_SESSION`, with no claim of an exact in-flight token ceiling.

The macOS and Windows compatibility gates continue to be provider-specific, but their evidence now refers only to
local CLI versions, invocation controls and subscription authentication. The managed public rehearsal must be rerun
through the Q20 executor; evidence from retired CLI adapters or direct APIs cannot satisfy it.

The gate count remains eleven so the staging workflow and reviewer mental model do not grow a second compatibility
matrix. Schema v3 rejects schema v2, the retired hard-token key and any unknown replacement. A `PASSED` row still
requires a bounded repository evidence file, exact SHA-256, an evidence commit and ancestry to the release source.
Uncommitted implementation or live observations remain `PENDING` even when local verification is green.

## Consequences

- The release contract can no longer pressure Loomrail to restore API keys or mislabel `POST_SESSION` as hard token
  enforcement.
- Q20 macOS evidence may later support the Q20, Codex-macOS and Claude-macOS rows, but each row is promoted only from
  committed reviewed bytes.
- Private dogfood, current bounded-executor public rehearsal, protected landing, both Windows rows and publisher
  provenance remain independent gates.
- The historical Q18 report stays readable as evidence for why the hard-token promise was superseded; it is not a
  stable-release gate under schema v3.
