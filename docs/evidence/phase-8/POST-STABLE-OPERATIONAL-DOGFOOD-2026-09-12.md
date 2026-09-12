# Post-Stable operational dogfood evidence — 2026-09-12

## Scope

- Host: macOS Apple Silicon (`darwin/arm64`), Node.js `24.19.0`.
- Public packages: `loomrail@0.1.0-beta.1` and `loomrail@0.1.0` from the npm registry.
- Candidate runtime: source after Stable `0.1.0`, Codex CLI `0.154.0-alpha.6.2`.
- Authentication: existing provider-owned local subscription login only.
- All install, data, repository and worktree roots were harness-owned temporary directories with spaces and Unicode.
  Exact absolute paths, bootstrap/session values, raw provider payloads and transcripts are intentionally omitted.

No direct OpenAI or Anthropic API request, API key, provider login, purchase, CLI install/update, repository push,
deployment or synthetic success was used.

## Public-registry lifecycle

The repeatable lifecycle gate installed both exact public versions with lifecycle scripts disabled and observed:

1. Beta started from missing state and created durable owner data.
2. Stable opened the same schema-neutral state after a stopped whole-directory backup and preserved the Project.
3. A separate restored backup opened with the matching Beta binary; no old binary opened state touched by Stable.
4. Stable package uninstall removed package files and left the owner data root in place.
5. Setup, Doctor, data-path, start/readiness/stop and leak-canary checks returned the expected bounded states.

Result: `PASSED`.

## Public newcomer behavior

The exact public Stable package completed canonical guided setup on a clean profile. Its admitted local provider was
Claude Code CLI `2.1.260`. The first model turn returned the provider's structured weekly allowance exhaustion.
Loomrail created a blocking Human Request and did not advance the workflow or invent a result. After a controlled
stop/start, the same Task and request were restored without automatic replay.

This is honest negative evidence, not a completed public-package workflow. The remaining locally installed Codex
version was not in Stable `0.1.0`'s exact admission matrix and therefore was not used as a fallback.

## Exact Codex qualification

The candidate admitted only `0.154.0-alpha.6.2 / darwin / arm64` after all of the following:

- a real read-only production-adapter session completed with measured usage;
- a deliberately invalid model produced a typed blocking outcome and zero fabricated usage;
- byte-exact real-CLI success and failure streams replayed through the current adapter;
- the production workflow used session-scoped Loomrail MCP workspace tools for bounded reads, writes and the
  owner-approved `npm run test` recipe;
- no allowance-reporting row was inferred from execution compatibility.

The full delivery moved through Discovery, Plan, IMPLEMENT, independent Review, QA and Acceptance. IMPLEMENT changed
only the task worktree and added focused tests. The required Project check passed on the same implementation tree.
Browser QA measured the local target at `1280 × 800 / en-US / light` and `320 × 720 / ru-RU / dark`, both without
horizontal overflow. The Acceptance package bound the implementation tree, independent Review, Browser QA and the
required Project check, and the owner resolved it as `ACCEPTED`; the WorkItem and PipelineRun ended `DONE` and
`SUCCEEDED`.

A controlled restart after QA had begun interrupted that AgentRun instead of replaying it. The UI exposed the
recovery report and required explicit Resume. The resumed provider first returned a schema-valid completion that did
not contain the required QA report; Loomrail rejected it as `QA_MEASUREMENT_REQUIRED`, opened a typed Human Request
and advanced only after a subsequent result bound the already recorded Browser QA measurement.

## Defect found and fixed

The first QA dispatch remained blocked with `EVIDENCE_INVALID` despite a passing required Project check. The active
Plan also contained an optional `SERVE` recipe. Reservation correctly excludes `SERVE` from a finite verification
Run, while Acceptance incorrectly compared the Run against every Plan recipe. A new domain regression test reproduced
the failure before the implementation changed. Acceptance now filters the same finite recipe set as reservation;
`SERVE` remains restricted to supervised launch measurement. The preserved Run then passed the gate without being
rewritten or rerun.

## Multiple Projects

The same local profile held three active Projects. The Project switcher listed all three; switching to the second and
third showed their own empty boards, while returning to the first restored its tasks and accepted history. The
keyboard-first global Attention E2E fixture now uses three Projects and opens the exact selected Project/Task pair.
Scheduler unit coverage retains global, per-Project and per-provider capacity plus workspace writer conflict cases.

## Verification

- public registry lifecycle: `PASSED`;
- exact Codex adapter replay: `PASSED`;
- verification finite/`SERVE` regression: `PASSED`;
- three-Project Attention E2E: `PASSED`;
- `pnpm verify`: `PASSED`;
- product Playwright E2E: `65/65 PASSED`;
- protected landing Playwright E2E: `7/7 PASSED`;
- crash/fault-injection gate: `PASSED`, including one interrupted Run, no replay and one durable recovery report;
- source-candidate release tarball: `PASSED` clean-install setup, diagnostics, receipt/file integrity and log lifecycle;
- repeated public registry lifecycle after the final harness change: `PASSED`.

Windows and Linux live-provider dispatch remain unsupported and fail closed. Claude's current account allowance also
remained exhausted during this run. Neither limitation is hidden by AUTO, Mock, API fallback or synthetic evidence.
The public-package full-workflow acceptance item therefore remains open until the patch Stable package is published
and installed from the registry; the equivalent production source candidate completed the full workflow above.
