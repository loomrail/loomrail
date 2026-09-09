# ADR-0023: MCP lease drains in-flight workspace calls

**Status:** Accepted

**Date:** 2026-09-09

## Context

During private Recurkit dogfood, Codex started the owner-approved full E2E recipe through the direct workspace MCP
binding and then ended its native IMPLEMENT process before the call returned. The gateway closed the provider socket
but had launched `handleCall` fire-and-forget and did not track its promise. `lease.close()` therefore returned while
the supervised recipe and durable `WorkspaceToolCall(STARTED)` remained live, allowing the session loop to complete
IMPLEMENT and launch an independent Claude Review against the same workspace.

The executor itself still bounded and supervised the recipe, and no passing evidence was fabricated. The defect was
the higher-level lifetime boundary: transport closure was mistaken for capability settlement.

## Decision

Every active MCP binding owns a private set of accepted in-flight call promises and a `closing` admission flag. Once
lease close begins, the binding rejects further calls, invalidates its one-time token and closes its provider
socket/client. Close then awaits settlement of every call that was accepted before the flag changed.

Direct workspace calls are not detached from their ProviderSession. On normal provider exit they may finish only
within their existing executor deadline, and `runProviderSessions` remains inside its `finally` until the gateway
lease drains. On owner cancellation the AgentRun authority signal is aborted first; the executor stops the child
process tree, records a terminal result, and the same drain completes. Daemon-crash recovery continues to use durable
process proofs and `UNKNOWN_OUTCOME`; in-memory promises are never treated as recovery evidence.

The gateway does not persist arguments, results or raw provider payloads while tracking calls. Provider-specific
transport stays inside adapters and the proxy; workflow ownership and workspace release remain in Loomrail.

## Consequences

- A StageAttempt cannot become terminal while one of its accepted workspace operations is still running.
- Review/QA cannot overlap a predecessor's direct recipe through an early provider exit.
- Normal session teardown can now take up to the already owner-visible recipe deadline; this is intentional and
  cancellable.
- Socket closure may make the provider observe a lost response, but Loomrail waits for the actual local outcome and
  never retries the side effect automatically.
- External MCP calls are also tracked; closing their client causes them to settle before the lease is released.

## Required verification

- a deferred direct call keeps `lease.close()` pending until the call settles;
- close refuses a new call and does not execute it;
- session-loop integration cannot complete a stage while a workspace call is pending;
- cancellation and restart tests retain process-tree proof before release;
- private dogfood begins Review only after all prior workspace calls are terminal.
