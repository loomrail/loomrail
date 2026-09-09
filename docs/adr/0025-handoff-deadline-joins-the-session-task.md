# ADR-0025: Handoff deadline joins the session task

**Status:** Accepted

**Date:** 2026-09-09

## Context

ADR-0023 made MCP lease close drain accepted workspace calls, and the normal provider-exit path awaited that close.
The context-window handoff deadline still raced `startSession()` against a timer without retaining the session
promise. When the timer won, the loop awaited `adapter.abortSession()` but then ended the durable ProviderSession and
opened its successor. The losing `startSession()` continued in the background, blocked in its correct MCP drain.

Private Recurkit dogfood reproduced the gap: the first Codex session was durably `CONTEXT_EXHAUSTED`, a second Codex
session started lint/build/unit, and the first session's E2E call remained `STARTED`. Owner cancellation stopped both
process trees and no later stage or evidence was created, but the same-workspace premise was violated.

## Decision

The loop creates one named session task and races that exact promise with the handoff deadline. If the deadline wins,
it first awaits the adapter's process-tree abort and then awaits the named session task through its `finally`, which
closes and drains the MCP lease. Only after the join may the loop persist `END_PROVIDER_SESSION` and consider another
ProviderSession.

The drained task's late provider outcome is not applied: the deadline remains the authoritative reason for ending
that session. Handoff does not revoke the already accepted workspace operation, so it may finish only within its
existing executor deadline. Owner cancellation still revokes AgentRun authority and stops the operation. Neither
path replays a call or fabricates evidence.

## Consequences

- a context-window cut can wait as long as the remaining bounded workspace operation;
- the next provider session never overlaps the predecessor's accepted workspace call;
- normal completion, handoff deadline and owner cancellation converge on one session-task/lease lifetime;
- provider transport may still lose the call result after a forced cut; recovery uses durable audit/checkpoint and a
  new explicit call, never an automatic replay.

## Required verification

- a forced handoff abort settles the adapter but leaves the first ProviderSession `RUNNING` while MCP close is
  blocked;
- no second session starts before the close is released;
- after release, the first session ends `CONTEXT_EXHAUSTED` and normal continuation may start;
- owner cancellation stops all calls and leaves no `STARTED` rows or running provider session;
- new private dogfood has no predecessor-session call active when a successor session or stage starts.
