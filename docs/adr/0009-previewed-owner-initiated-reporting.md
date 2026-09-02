# ADR-0009 — Previewed owner-initiated reporting for public alpha

**Status:** Accepted

**Date:** 2026-09-03

## Context

Phase 8 requires opt-in telemetry/crash reporting. PD-003 and SD-003 simultaneously require local-first operation,
telemetry disabled by default, a public payload schema and a crash payload visible before it leaves the machine.
Loomrail does not own a deployed telemetry collector, account system or remote-control plane in this phase. Adding an
unverified endpoint, a persistent installation identifier or a dormant background sender would create a new trust
boundary without an operational owner and would make a later deployment capable of reusing old consent silently.

The durable workflow state already records the one product crash condition Q5 can prove deterministically:
`RecoveryReport(reason = DAEMON_RESTART)`. It contains sensitive identifiers and timestamps, so it cannot itself be
an external report. Local quality and reliability metrics similarly originate in rows that contain project names,
paths, work-item text, provider output and artifact metadata.

## Decision

- Local Insights are computed on demand from SQLite aggregate counts. They are visible without consent and never
  leave the authenticated loopback session.
- A single deterministic reporting module accepts numeric/enumerated facts and returns strict public report shapes.
  Raw rows, identifiers, free text, timestamps, paths and artifact references never cross that seam.
- Public alpha has no background collector, network sender, stable installation identifier, cookies or reporting
  schedule. Reporting opt-in is the owner's explicit click to download one payload already shown in full.
- The browser serializes and downloads the exact in-memory object used by the preview. It does not refetch or rebuild
  the payload after consent, so the preview cannot race with changing local state.
- Aggregate reports contain product/runtime categories and aggregate counts only. Crash reports are available only
  when durable recovery state proves a daemon restart and contain the closed reason/status vocabulary plus a count.
- Adding automatic or direct network delivery requires a new ADR naming the owned endpoint, retention policy,
  deletion route, abuse controls and consent lifetime. Existing one-shot export is not reusable consent for it.

## Consequences

### Positive

- no data is collected or transmitted until a human sees and exports the exact payload;
- the public schema is executable and fail-closed rather than prose around a broad diagnostics object;
- local metrics remain useful to people who never share a report;
- crash reporting reuses deterministic recovery truth without exporting workflow identities or logs;
- a future transport cannot claim that a past download authorized unattended uploads.

### Costs and risks

- public-alpha reports are shared manually, so maintainers cannot calculate population-wide rates automatically;
- reports contain no stack, log excerpt, exact time or repository context and may need a private follow-up;
- a daemon crash with no active workflow produces no `RecoveryReport` and therefore no crash payload in this phase;
- every new metric needs review at the reporting seam before it can enter a public payload.

## Rejected alternatives

- **Persistent telemetry toggle with no collector:** records ambiguous consent that a later build could silently reuse.
- **Invent a Loomrail endpoint:** creates deployment, retention and incident-response obligations outside the owned
  repository and release gate.
- **Attach redacted logs:** redaction is defense in depth, not proof that prompts, provider responses or paths are
  absent; arbitrary strings are excluded structurally instead.
- **Prefill a public GitHub issue:** crash context can still be sensitive and public issue text is the wrong privacy
  boundary.

## Required tests

- an empty installation produces valid zero-valued local metrics and aggregate preview;
- report schemas reject unknown fields, identifiers, timestamps and free text;
- the reporting module derives rates and runtime categories deterministically;
- crash preview is absent without recovery evidence and bounded with it;
- authenticated loopback is required for the Insights source;
- the downloaded bytes are produced from the same object rendered in the preview;
- no product path introduces a non-loopback telemetry request.
