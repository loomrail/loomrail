# ADR-0028 — Domain-owned release evidence snapshots

**Status:** Accepted

**Date:** 2026-09-10

## Context

L1 and L2 now produce durable repository-readiness and local launch-measurement evidence. The production launch track
needs a portable answer to “what was measured for this candidate?” before any deploy authority is considered. Treating
a generated document, provider summary or current UI projection as that answer would allow evidence to drift, cross
Project boundaries or turn missing checks into optimistic prose.

## Decision

L3 is one deterministic domain-owned snapshot boundary. An authenticated owner maintains a bounded
`LaunchEnvironment` declaration and explicitly creates an immutable `Release` from exact durable evidence identities
and the repository's current Git tree. The domain alone maps the closed L1/L2/Q17/R1/Q1–Q3 sources into 24 gate
snapshots and computes freshness. SQLite persists Environment/Release/Event/command receipt transactionally; the web
and daemon do not recompute verdicts.

The exported Launch Evidence Package is a pure bounded renderer over the immutable Release. It contains no repository
path, raw provider or command output, response body/header values, credential value or environment value. It states
counts and limitations and never emits a `production ready` verdict.

L3 creates no executable recipe, network request, deploy approval, waiver, secret lookup, rollback target or retry.
Providers receive no L3 mutation tool and do not author gate results.

## Consequences

- historical Release bytes remain explainable after Project settings or evidence change;
- currentness is a separate read projection and cannot rewrite history;
- owner-selected workflow scope is explicit and bounded rather than inferred from provider prose;
- a Release may honestly contain failed/action-required gates; creation is not approval;
- L4 must introduce its irreversible authority in another PD/ADR/threat delta and cannot reuse L3 creation as deploy
  consent.

## Rejected alternatives

- **Render from current queries on download:** produces different evidence under one Release identity.
- **Let the provider assemble a launch report:** crosses the deterministic authority boundary and trusts prose.
- **Persist raw outputs for later analysis:** expands sensitive data retention without improving gate authority.
- **Treat all-green gates as deploy approval:** silently introduces L4 authority and violates one-shot owner consent.
