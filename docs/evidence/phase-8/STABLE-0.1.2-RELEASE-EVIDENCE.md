# Stable 0.1.2 release candidate evidence

**Date:** 2026-09-12

**Status:** Verified and staged; separate npm WebAuthn approval pending

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
attempts, usage and the pending Acceptance Package without replay. The owner then explicitly accepted the reviewed
runbook. The production Acceptance command recorded WorkItem DONE, PipelineRun SUCCEEDED and AcceptancePackage
ACCEPTED. A second controlled restart preserved that terminal state, attempts and usage without a new provider session.

The [actual ledger](TOKEN-EFFICIENCY-RELEASE-DOGFOOD.json) and
[complete token-efficiency investigation](TOKEN-EFFICIENCY-EVIDENCE.md) retain both dogfoods and their limitations.
The new fixture differs from the public Recurkit baseline; no controlled >=50% uncached or >=40% raw saving is
claimed. The deterministic same-fixture benchmark measures byte reductions, not provider-token savings.

## Candidate gates

- Recorded Stable index: 9/9 required macOS/product gates, with both Windows live-provider rows still pending.
- Activation and release-index tests passed for `0.1.2`; production dependency audit found no known vulnerabilities.
- Full candidate `pnpm verify` passed. Final product E2E passed 65/65; focused post-fix alignment repetitions
  passed 12/12. The full fault-injection gate passed, including 283 daemon tests and the crash drill
  (one interrupted run, no replay, one durable report). Clean-package verification and 7/7 protected landing E2E
  passed from the clean candidate source `d9d64563b142d17cb24927ac539d2053996342cb`.
- The exact candidate passed all six macOS/Windows jobs in
  [branch CI run 34715810354](https://github.com/loomrail/loomrail/actions/runs/34715810354). It was fast-forwarded
  to main unchanged. Required push-triggered
  [main CI run 34717562403](https://github.com/loomrail/loomrail/actions/runs/34717562403) passed all six jobs.
- The protected environment review was recorded under the owner account, acting on the explicit release
  authorization in this task after green exact-source CI and owner Acceptance. The existing owner reviewer and
  main-only environment rules were preserved.
- [Protected stage run 34719201850](https://github.com/loomrail/loomrail/actions/runs/34719201850) passed source
  verification, crash/fault recovery, all 65 E2E scenarios, exact-package build and clean-package verification.
- npm WebAuthn approval, public-registry integrity/signature/install verification and GitHub Release remain pending.

Historical compatibility evidence is unchanged. Windows/Linux live-provider support is not inferred from package CI.
No raw provider payloads, transcripts, environment values, local databases, personal paths or credentials appear here.

## Verified staged package

The protected trusted-publishing workflow created stage `139548b4-19a0-46e9-bd8c-cc26eca6aa54` for
`loomrail@0.1.2`, tag `latest`, public access. npm identifies its actor as GitHub Actions / trusted automation.
The workflow tarball, separately downloaded npm stage tarball and locally verified macOS tarball are byte-identical.
Their matching clean receipts enumerate the same 104 files, with no personal paths or runtime state.

- Exact source: `d9d64563b142d17cb24927ac539d2053996342cb`.
- SHA-1: `e45ee10d39c37cbde93dcea1174c6af2a0c5c170`.
- SHA-256: `5b197c8c0a60df61f4d395348963cbac33570101c2b8ed9684b4d904c0e42460`.
- Integrity: `sha512-FQnWgJsmtkAxMy1UnnJ+Ga+4C0MbRDIDEXEDJcmfXzzoQOL+DTPVBvI8nV1EnqmQ5MoKwMZDY0MwQcgJyv+CQw==`.
- Signed source/build provenance: [Sigstore log index 2811473549](https://search.sigstore.dev/?logIndex=2811473549).
- [Sanitized candidate receipt summary](STABLE-0.1.2-CANDIDATE.json).

The separate owner approval command reached npm's Security Key / WebAuthn step. No authentication challenge or
credential is recorded here. Until the owner completes that physical step and the public registry is verified,
`latest` remains `0.1.1`, `next` remains `0.1.0-beta.1`, and this document does not claim publication.

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

## Observed stage totals, not a controlled savings claim

The baseline is the public Recurkit workflow. The completed after-run uses an independent small documentation
fixture with different project contents and attempt counts. These actual numbers describe two runs; they do not
isolate the effect of context assembly.

| Stage      | Before raw | After raw | Before cached | After cached | Before uncached + output | After uncached + output |
| ---------- | ---------: | --------: | ------------: | -----------: | -----------------------: | ----------------------: |
| Discovery  |    414,210 |   154,521 |       348,160 |      118,528 |                   66,050 |                  35,993 |
| Plan       |    359,186 |    13,899 |       318,720 |            0 |                   40,466 |                  13,899 |
| Implement  |  1,642,472 |   182,594 |     1,339,904 |      165,888 |                  302,568 |                  16,706 |
| Review     |    988,436 |   152,227 |       854,272 |      140,672 |                  134,164 |                  11,555 |
| QA         |    320,028 |    87,753 |       266,240 |       67,328 |                   53,788 |                  20,425 |
| Acceptance |     14,413 |    14,507 |             0 |            0 |                   14,413 |                  14,507 |
| Total      |  3,738,745 |   605,501 |     3,127,296 |      492,416 |                  611,449 |                 113,085 |

Controlled raw, cached and uncached token savings remain unknown. Both required provider-token reduction targets
remain unproven. The initial incomplete run is retained separately and is not used to claim savings. Together, the
two authorized dogfoods consumed 1,028,556 raw tokens: 1,019,393 input, 9,163 output, 797,952 cached input and
230,604 uncached input plus output. These totals include the budget-paused attempt and are actual work expenditure,
not an efficiency estimate.
