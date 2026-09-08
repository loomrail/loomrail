# Q20 private Recurkit dogfood — 2026-09-08

## Scope and authority

- The owner explicitly approved live use of the already-authenticated local Codex and Claude Code CLIs.
- The target was the existing Recurkit working tree in explicit shared-current-directory mode.
- No direct OpenAI/Anthropic API transport, API key, login change, CLI update, purchase, publish, commit or push was
  used. Test-only doubles were not used for the live observations below.
- Runtime state, raw provider streams, credentials, capability values, command output and absolute owner paths are not
  retained in this evidence.

## Observations

1. A Codex STANDARD Discovery session returned a schema-valid but meaningless owner request whose title and context
   were each one character. The run was not counted as useful dogfood and was cancelled. The provider-output contract
   now rejects title shorter than 3 characters or context shorter than 10 characters; historical durable requests
   remain readable.
2. Two Claude FAST Discovery sessions exited with code 1 after bounded work without a terminal structured result or a
   usable provider diagnostic. Loomrail opened a typed blocking request and did not synthesize progress. The run was
   cancelled after the repeated outcome; the evidence does not infer an unreported provider-side cause.
3. A Claude STANDARD Discovery session returned a valid result. Its authoritative terminal usage was 692005 input
   plus 11346 output tokens, 703351 total. The configured run ceiling was 700000 and the per-agent ceiling was 175000,
   both explicitly marked `POST_SESSION`; Loomrail preserved the completed Discovery result and hard-paused PLAN
   before another provider session. The run was cancelled instead of widening subscription spend.
4. A separate minimal Claude containment smoke in a new temporary directory accepted the exact production restricted,
   empty-settings, empty-built-ins and strict-MCP profile and returned structured output. Investigation also showed
   that engine version selection can depend on cwd. ADR-0018 therefore makes readiness probe the parser in a fresh
   production-shaped temporary directory; the local production-shaped engine remained the admitted `2.1.260` target.
5. None of these runs reached IMPLEMENT or QA. The Recurkit working tree retained the same pre-existing modified and
   untracked file set; Loomrail did not claim Browser QA or Acceptance success.

## Result

**Not a full private-workflow pass.** The exercise proves real subscription-authenticated provider startup, a valid
Claude Discovery outcome, honest post-session accounting and fail-closed blocked/cancelled states. It also found and
closed two product defects: meaningless provider HumanRequests passing structural validation, and a readiness probe
whose cwd did not match production session selection.

Full private Recurkit Acceptance remains blocked until a useful end-to-end run fits an owner-approved subscription
budget. Automated provider/executor/integration/E2E coverage remains the release evidence for this change; it must not
be described as credentialed full-workflow dogfood.

## Automated verification after the findings

- `pnpm verify` passed formatting, public-readiness, lint, build, typecheck, release-integrity tests and every workspace
  package test.
- The corrected provider-selection keyboard scenario passed 10/10 stress repetitions. The complete product browser
  suite then passed 61/61 sequentially, including measured Browser QA success/failure, restart recovery, correction
  evidence and both local-provider settings paths.
- A preceding two-worker browser attempt ran during exceptional host contention and timed out in unrelated scenarios.
  All 15 affected scenarios passed sequentially before the complete 61/61 run; no product assertion was weakened and
  no retry was used to claim the final pass.
- Release packing produced the expected alpha archive and receipt. Clean-install verification passed samples, setup,
  local CLI diagnostics, receipt and installed-file integrity, with zero reported package vulnerabilities.
- No npm publication or direct paid provider API call was performed.
