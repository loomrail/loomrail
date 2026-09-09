# ADR-0022: Kind-aware Project Verification deadlines

**Status:** Accepted

**Date:** 2026-09-09

## Context

Private Recurkit dogfood completed its full API and browser E2E command successfully in 489 seconds. The Q17 scanner
assigned the same 300-second default to every discovered package script, so an otherwise valid owner-approved E2E
recipe would time out before producing evidence. An initial owner-approved 600-second revision was then exercised
through the isolated workspace executor under concurrent host load and reached its deadline without finishing.
Running the suite outside Loomrail would not satisfy Acceptance, while removing the deadline would weaken process
supervision.

The recipe contract already permits an exact owner-visible timeout from 1 to 900 seconds. The missing boundary was
how an inert scanner chooses a safe proposal without interpreting or executing the untrusted script body.

## Decision

The scanner derives its default only from the allowlisted script identity already mapped to a closed recipe kind. It
proposes 900 seconds for `test:e2e` / `E2E` and keeps 300 seconds for lint, build, unit and integration recipes. It
does not estimate source size, parse shell text, execute probes or accept a repository-provided timeout override.

The exact value remains part of the proposal hash, owner preview, adopted Project Verification Plan revision and
execution policy snapshot. The existing contract ceiling of 900 seconds is unchanged. The runner continues to stop
the process tree at the deadline and records a typed non-passing outcome.

## Consequences

- Realistic local E2E suites can produce measured evidence without bypassing Loomrail.
- Shorter checks retain the existing fail-fast default.
- A repository cannot smuggle an unbounded duration through package metadata or script content.
- Projects needing a different policy still require a future explicit owner-editable Plan contract; this decision
  does not create a hidden config override.
- The longer default increases the maximum occupied verifier lease for E2E by ten minutes, but remains bounded,
  cancellable, restart-recoverable and visible before adoption.

## Required verification

- scanner integration coverage asserts 300 seconds for a unit recipe and 900 seconds for an E2E recipe;
- proposal hashing remains deterministic and adoption publishes the exact previewed value;
- timeout, cancellation, output and process-tree recovery tests continue to pass on supported platforms;
- private Recurkit dogfood uses the adopted plan rather than a direct or synthetic verification result.
