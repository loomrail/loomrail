# ADR-0005 — Daemon-owned MCP gateway between providers and local servers

**Status:** Accepted for C1

**Date:** 2026-08-31

## Context

Codex and Claude Code can both receive MCP server configuration. Passing a consented server command directly is the
smallest implementation, but it transfers process ownership and every tool call to the provider CLI. Loomrail could
record that a profile was enabled, but could not enforce a tool allowlist, revoke access during a session, bound wire
traffic, distinguish a lost mutation outcome or produce its own call audit. Those are domain responsibilities, not
provider transcript conventions.

Running an MCP client directly in daemon would preserve policy but would not make the tools available to the provider
agent. A seam is needed between provider-native MCP configuration and the real local server.

## Decision

Loomrail implements a daemon-owned MCP gateway.

- Provider adapters configure only a Loomrail stdio proxy connector scoped to one ProviderSession and profile.
- The proxy authenticates once to a loopback gateway with a random scoped token and forwards JSON-RPC; it cannot load
  a profile or choose a server.
- Daemon resolves an immutable consented Profile Revision and launches the real stdio server behind a Loomrail
  supervisor. The supervisor validates and bounds stdout before the SDK sees it, owns a detached process group on
  POSIX (or a Windows process tree), and watches the daemon pid as well as stdin.
- Gateway validates protocol messages, applies the MCP Grant, records bounded redacted call audit and owns recovery.
- Provider-specific config remains an adapter detail. Codex uses closed `mcp_servers.*` overrides while ignoring user
  config; Claude uses strict generated MCP config. Neither sees the real server launch recipe.
- The gateway is a deep module with one provider-neutral interface. SDK/transport/process/proxy details remain inside
  its implementation.
- Normal close sends stdin EOF, then TERM/grace/KILL to the full process tree. If daemon disappears first, the
  supervisor performs the same cleanup without waiting for a restart.
- Before exposing a server, the supervisor atomically writes a mode-`0600` process record beside durable local
  state. Startup reconciliation validates that record and the OS process start time before force-closing a tree that
  survived both daemon and supervisor; a mismatched or unreadable identity is never signalled.

## Alternatives rejected

### Direct provider injection

Rejected because permission enforcement, revocation, process ownership and call audit would depend on provider-native
behaviour that differs across CLIs and is not part of Loomrail's deterministic model.

### Daemon invokes tools outside the provider

Rejected because the agent would not receive normal MCP discovery/tool semantics and context assembly would need a
second bespoke tool protocol.

### User-wide provider MCP config

Rejected because it is ambient, not project/session versioned, and silently bypasses Loomrail consent and audit.

## Consequences

### Positive

- one policy/audit/recovery implementation serves every provider adapter;
- revoke and closed tool allowlists are enforceable, not UI claims;
- real server process and unknown outcomes stay visible to daemon;
- C3 Context7 and later Plugin SDK reuse the same seam.

### Costs and risks

- C1 includes a small proxy executable and authenticated loopback connector;
- process-tree cleanup has platform-specific POSIX group and Windows `taskkill /T` implementations;
- proxy tokens need strict scope, short lifetime and log redaction;
- provider compatibility is tested at argv/config seams and may need adapters updated as CLIs evolve;
- in-flight tool approval cannot consume the existing one-provider-question budget, so C1 allows only owner-granted
  read-only tools; side-effect tool approvals require a later dedicated workflow contract.

## Required tests

- provider config contains proxy only and cannot inherit ambient MCP servers;
- ungranted tool call never reaches fake server;
- revoke blocks the next call in an active session;
- server flood/invalid JSON/process exit are bounded typed failures;
- disconnect after forward becomes `UNKNOWN_OUTCOME` and is not retried;
- session end, supervisor parent-death recovery and durable startup reconciliation terminate the server and a
  signal-resistant descendant, while a reused-pid fixture is left alone;
- tokens, raw arguments and output are absent from logs/events.
