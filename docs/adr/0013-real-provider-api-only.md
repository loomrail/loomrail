# ADR-0013: Real-provider-only API execution

**Status:** Superseded by ADR-0015

**Date:** 2026-09-06

## Context

The Phase 0 synthetic provider was useful for the vertical slice, but it became the default onboarding path and
could complete a workflow that looked like agent work. The owner explicitly removed that product direction. The
existing Codex and Claude Code CLI adapters also cannot enforce Loomrail's immutable token ceiling before usage is
incurred (ADR-0012).

OpenAI Responses accepts `max_output_tokens`; Anthropic Messages requires `max_tokens`. Both values are part of the
request before provider work starts. They provide the enforceable request boundary missing from the CLI route, while
usage returned by the provider remains an independently validated accounting input.

## Decision

- Production provider selection contains exactly OpenAI Responses (`CODEX`) and Anthropic Messages
  (`CLAUDE_CODE`). The internal IDs remain stable for persisted compatibility; product labels name the APIs.
- API keys come from process environment only. They are request headers and are never included in provider content,
  persistence, logs, exports or diagnostics.
- Every request reserves a conservative input amount from the immutable AgentRun remainder and supplies the
  remaining bounded output value through the provider-native field. If no safe output remainder exists, dispatch is
  refused before transport.
- Provider responses, structured stage output and usage are runtime validated. Missing/malformed usage, malformed
  output, provider error status and over-budget reports fail closed.
- Production uses the HTTPS transport. Tests may inject a transport double to assert exact request and response
  behavior without spending quota.
- Active Project preference and UI contain no Mock option. Unknown or missing configuration never produces a
  successful synthetic result.
- Historical `MOCK` IDs, command discriminants and migrations remain readable. New active starts use
  `START_PIPELINE`; the old discriminant exists only for replay/migration compatibility.
- Until a separate secure local tool executor is accepted, both APIs serve only DISCOVERY, PLAN, REVIEW and
  ACCEPTANCE. IMPLEMENT and QA are refused before provider dispatch rather than being represented by prose.

## Consequences

The product no longer has a zero-quota end-to-end demonstration. Onboarding requires one real provider credential and
warns that quota will be used. Transport-level adapter tests are deterministic, but stable/live claims remain pending
until credentialed runs are captured on required platforms. Full code-writing capability requires a new security
decision; returning to synthetic production work is not an allowed workaround.
