# ADR-0024: Local provider deadline covers one maximum verification call

**Status:** Accepted

**Date:** 2026-09-09

## Context

Project Verification permits an owner-approved E2E recipe to run for at most 900 seconds. Both local provider
adapters independently imposed a 600-second wall-clock session deadline. During private Recurkit dogfood, Codex
started the full E2E recipe, reached its own session deadline while the supervised recipe was still running and lost
the eventual non-passing result. ADR-0023 correctly kept the StageAttempt open until the call settled, so no false
success or overlapping Review occurred, but the provider could not inspect and correct the failure in that session.

Removing either deadline would weaken process supervision. Teaching each adapter about verification plans would also
leak a domain-owned policy into provider-specific code.

## Decision

The verification contract exports its maximum recipe timeout as
`MAX_VERIFICATION_RECIPE_TIMEOUT_SECONDS = 900`. Provider core derives one local-runtime policy from it:
`LOCAL_PROVIDER_SESSION_DEADLINE_MS = 1_200_000`, the maximum single recipe duration plus a fixed 300-second
control-plane reserve. Codex and Claude Code both pass that shared value to the supervised process runner and do not
declare adapter-local session deadlines.

The reserve covers provider reasoning before a long call, MCP transport and a terminal structured result. It does
not promise that an arbitrary sequence of recipes fits in one session. The overall deadline remains cancellable and
fail-closed. On expiry the provider process tree is stopped with a typed timeout; any call already accepted by the
gateway still follows ADR-0023 drain and is never replayed or converted to evidence automatically.

## Consequences

- either local provider can receive the result of one maximum-duration recipe when it begins within the reserve;
- the schema ceiling, exact owner-approved recipe deadline, output cap and process-tree supervision are unchanged;
- adapters cannot silently drift to different session lifetimes;
- a provider that spends the reserve before starting the recipe can still time out honestly and require explicit
  recovery from its durable checkpoint;
- longer sessions occupy local resources for up to twenty minutes, but remain bounded and owner-cancellable.

## Required verification

- the recipe schema accepts the shared maximum and rejects one second above it;
- provider-core proves the session deadline equals the recipe ceiling plus the fixed reserve;
- Codex and Claude adapters use the shared policy rather than local numeric constants;
- timeout/cancellation/process-tree tests remain green;
- private Recurkit dogfood delivers a terminal full-E2E result back to the resumed IMPLEMENT session.
