# Stable 0.1.2 release candidate evidence

**Date:** 2026-09-12

**Status:** Candidate; publication pending

**Release Support Target:** `MACOS_ARM64` (`darwin/arm64`)

**Implementation source:** `e4812d63a7ca426fe241ac43ea8a1994b75cf5af`

## Owner scope and implementation

The owner authorized one additional bounded local Codex dogfood, then merge, npm publication and GitHub Release
after successful checks. Version `0.1.2` is the patch candidate. No release is claimed until the public registry and
GitHub records exist. Later changes to the implementation source are release metadata, sanitized evidence and E2E synchronization only.

The change removes duplicate MCP result serialization, excludes optional activity from stage context, carries
structured Discovery/Plan handoffs, bounds initial context and retains required owner decisions with typed refusals.
Usage display includes cached/uncached attribution and honest unknowns. All six stages, independent Review,
Project verification, measured Browser QA, owner Acceptance, permissions, audit and recovery remain mandatory.

## Additional live dogfood

The production registry used installed authenticated Codex CLI `0.154.0-alpha.6.2` with built-in model tiers. One
additional pipeline started with 900,000 pipeline tokens, 300,000 per AgentRun and a 20-minute harness bound. No
budget revision, hidden fallback, direct API or synthetic production result was used.

All six provider stages completed. A real Discovery wording question was answered durably without changing the
application contract. Seven usage reports include both Discovery sessions: 599,892 input, 5,609 output, 492,416
cached input, 605,501 raw and 113,085 uncached input plus output.

Independent Review passed. All four required Project verification checks passed with CURRENT freshness. Measured
Browser QA passed six executions, eight steps and fourteen assertions across the two configured themes/viewports.
The result tree adds only the requested 21-line `docs/local-health-check.md`. A controlled restart preserved
attempts, usage and the pending Acceptance Package without replay. Final human Acceptance is pending explicit owner
review of that result.

The [actual ledger](TOKEN-EFFICIENCY-RELEASE-DOGFOOD.json) and
[complete token-efficiency investigation](TOKEN-EFFICIENCY-EVIDENCE.md) retain both dogfoods and their limitations.
The new fixture differs from the public Recurkit baseline; no controlled >=50% uncached or >=40% raw saving is
claimed. The deterministic same-fixture benchmark measures byte reductions, not provider-token savings.

## Candidate gates

- Recorded Stable index: 9/9 required macOS/product gates, with both Windows live-provider rows still pending.
- Activation and release-index tests passed for `0.1.2`; production dependency audit found no known vulnerabilities.
- Full candidate `pnpm verify` passed. Final product E2E passed 65/65; focused post-fix alignment repetitions
  passed 12/12. The full fault-injection gate passed, including 283 daemon tests and the crash drill
  (one interrupted run, no replay, one durable report). Clean-package verification is pending.
- Exact main source, six-job macOS/Windows CI, protected stage-only workflow, npm owner approval, registry integrity,
  signature/install verification and GitHub Release remain pending.

Historical compatibility evidence is unchanged. Windows/Linux live-provider support is not inferred from package CI.
No raw provider payloads, transcripts, environment values, local databases, personal paths or credentials appear here.

## E2E timing failure and correction

The first candidate E2E run passed 64 scenarios and failed the existing optical-alignment test by 1.015 CSS pixels
against its unchanged 0.5-pixel tolerance. Its trace showed separate bounding-box reads during the 180ms dialog
entrance transform. Twelve unmodified focused repetitions passed, confirming intermittent scheduling sensitivity.

A temporary diagnostic restarted the real entrance animation and separated two geometry reads by 50ms. It failed
3/3 before the correction and passed 3/3 after the test awaited the element's actual `animation.finished` promises.
The diagnostic restart/delay was then removed. The committed correction changes only test synchronization; it does
not change CSS, disable product animation, increase tolerance or replace an assertion with a synthetic success.
Geometry tests should wait for the relevant lifecycle rather than treating untransformed CSS height as proof that
rendered layout is stationary. Repeated focused and full E2E results are recorded with the final candidate gates.
