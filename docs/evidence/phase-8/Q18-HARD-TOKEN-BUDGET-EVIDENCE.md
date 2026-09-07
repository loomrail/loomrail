# Q18 hard token-budget evidence

**Date:** 2026-09-06

**Status:** superseded by PD-019, ADR-0015 and ADR-0016

This report remains historical evidence of why terminal CLI usage cannot be called an in-flight hard token cap.
Schema-v3 stable release gates no longer require this impossible API-era contract; they require bounded local
subscription CLI workspace execution with explicit `POST_SESSION` accounting instead.

## Measured result

A macOS private-dogfood session crossed both its immutable AgentRun ceiling and the remaining pipeline allowance
before its first valid cumulative usage report arrived. The report made the ledger accurate only after the spend;
it could not stop the active provider process at the approved token boundary.

The inspected Codex `0.153.4` and Claude Code `2.1.260` command surfaces do not provide an exact enforceable token
ceiling compatible with Loomrail's owner-authored estimated-token budget. A currency cap, turn count, context-window
setting or terminal usage event is not equivalent to that contract.

## Implemented fail-closed boundary

- provider capabilities declare `HARD` or `POST_SESSION` explicitly;
- Codex and Claude Code declare `POST_SESSION`; Mock declares `HARD` because it performs no billable provider work;
- AUTO excludes `POST_SESSION`, and explicit selection remains visible only for diagnosis;
- the daemon refuses `POST_SESSION` before workspace preparation, ProviderSession creation, MCP opening or process
  spawn;
- a `HARD` invocation receives the immutable maximum, recorded usage and exact positive remainder;
- Settings and CLI startup state plainly that no live session will start without the guarantee.

Focused contract, domain, adapter, selection, daemon and CLI tests cover this boundary. Repository-wide verification
passes 1,660 checks, and the full Mock browser matrix passes 60/60 with separate future-`HARD` and current
`POST_SESSION` selection paths. Passing fail-closed tests are not positive evidence that either live provider can
enforce the limit.

## Evidence required to pass the stable gate

The stable gate remains `PENDING` until both supported live providers have exact version/platform evidence for a
runtime primitive that prevents spend beyond the immutable Loomrail token remainder, and integration tests prove the
process cannot continue past that boundary. Compatibility, private dogfood and owner Acceptance remain separate
gates.
