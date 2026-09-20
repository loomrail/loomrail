# Code-blind coordinator: local evidence

**Date:** 2026-09-19. **Scope:** experimental feature from approved base
`868be0ee9c2054cefeffda1ecc516c62ec2f8099`, separate from the 0.1.3 release.
This is not release provenance or a live-provider admission row.

## Deterministic and browser checks

The implementation preserves all six domain stages, immutable per-stage assignments, independent Review,
measured Project verification/Browser QA, and human Acceptance. Synthetic integration tests exercise the
entire path, command replay, restart, manager workspace NONE, unavailable required provider, forbidden
model/capability changes, bounded output and source-bearing context exclusion. All 69 browser scenarios
passed; the new EN/RU switch also passed light/dark, keyboard, mobile and reload checks. See plan 133.

## Owner-authorized native smoke probes

The owner authorized minimal real Codex probes and explicitly excluded Sonnet because its allowance was
exhausted. Exactly three short standalone invocations used the existing ChatGPT login through Codex CLI
`0.155.0-alpha.9.2` on `darwin/arm64`. No repository or MCP tools were attached. A 45-second external deadline
bounded each probe; all completed before it. Ephemeral mode was used; raw transcripts were not retained.
No credentials or provider API keys were read or copied. No fallback model was configured.

| Requested model | Invocation variant                                                | Input tokens | Cached input | Output tokens | Duration | Result                     |
| --------------- | ----------------------------------------------------------------- | -----------: | -----------: | ------------: | -------: | -------------------------- |
| gpt-6-astra     | Initial restricted coordinator                                    |        12128 |            0 |           138 | 13.681 s | Valid PLAN checkpoint      |
| gpt-6-astra     | Same packet, ambient documents disabled and skill catalog bounded |         6902 |            0 |           160 | 10.609 s | Valid PLAN checkpoint      |
| gpt-5.6-luna    | Restricted economy Discovery smoke                                |         5769 |            0 |            90 |  7.335 s | Valid COMPLETED checkpoint |

The Astra packets were identical. The second invocation added `project_doc_max_bytes=0` and
`skills.max_context_tokens=1`; other adapter settings and the owner outcome stayed unchanged. The observed
input difference was 5226 tokens (43.09%). This is a single paired smoke observation, not an end-to-end
quality or cost benchmark, and does not establish which of the two settings contributed how much.
The first call exceeded the proposed 12000-token post-session envelope; the reduced-context call did not.
All three calls together reported 25187 input-plus-output tokens. Reported reasoning tokens are a subset
of output, not an additional charge in this total. Monetary cost and account-limit impact are unknown.

The CLI was invoked with each exact requested model ID. The consumed stream does not independently attest
the service's executed model identity. The probes prove parser/schema completion for these invocations,
not a new compatibility promise.

## Owner-authorized native qualification attempt, 2026-09-20

The owner authorized up to 50000 additional input-plus-output tokens for a real Astra-to-Luna,
workspace/MCP, six-stage and restart qualification, with Sonnet excluded. A disposable repository and SQLite
database were created outside Git. The intended restart seam was after a successful Plan; admission remained
unchanged and the published package was not used.

The attempt stopped in Discovery and did not reach Astra, Plan or workspace mutation:

| Session | Requested model | Input tokens | Cached input | Output tokens | Reasoning output | Durable result |
| ------: | --------------- | -----------: | -----------: | ------------: | ---------------: | -------------- |
|       1 | gpt-5.6-luna    |        30510 |        20736 |           637 |              293 | NEEDS_HUMAN    |
|       2 | gpt-5.6-luna    |        20936 |        11776 |           699 |              372 | INTERRUPTED    |

The first session consumed 31147 tokens and incorrectly treated the later implementation's need to create a file
as a current Discovery permission blocker, even though Discovery had the intended read-only workspace and
Implement would receive separate write authority. The harness resolved the provider's recommended option and
started one continuation. Because Codex reports usage only after a session, that continuation raised the observed
cumulative total to 52782 tokens: 2782 above the authorized ceiling. This was a qualification-harness scheduling
error; no further provider invocation was made. Cached input is already included in input tokens and reasoning
output is already included in output tokens, so neither is added again.

The product prompt and Structured Output descriptions now state explicitly that read-only Discovery is intentional,
that future file changes belong to Implement, and that `NEEDS_HUMAN` must never request tools, permissions or
authority for a later stage. Unit tests lock both the runtime prompt and provider-visible schema guidance. The
attempt remains negative evidence, not a compatibility admission: no write tool ran, no six-stage completion or
restart continuation was demonstrated, and the exact installed CLI version remains unadmitted.

After this fix, provider-core passed 90/90 tests and the complete `pnpm verify` suite passed with Vitest workers
serialized through its supported environment setting. The default parallel browser run had first hit one bounded
client-side navigation timeout under heavy host load; the isolated scenario, the serialized browser package (37/37)
and the complete serialized workspace run all passed without changing product timeouts.

## Remaining release gates

- The new installed Codex version is still **not admitted** by Loomrail; existing exact admission rows are unchanged.
- A fresh, separately authorized native workspace/MCP allow-deny, six-stage workflow and recovery qualification is
  still required after the Discovery authority fix. Any future harness must reserve a complete worst-observed
  session before dispatch because usage enforcement is post-session.
- Fable and Sonnet were not exercised; Fable is unavailable in this first slice.
- No measured non-inferiority or full-task savings claim is made.
- The new mode is not part of published npm 0.1.3 and must not ship through that release identity.

## Independent implementation review, 2026-09-20

Reviewed the feature against base `868be0ee9c2054cefeffda1ecc516c62ec2f8099`, plan 133, PD-034, ADR-0035 and T88.
Two independent review axes were kept separate:

### Standards

The initial review found a structural context-boundary violation and duplicated model IDs. Follow-up found broad
bookkeeping reads still inside the session loop. All were corrected: coordinator facts and operational counters
have narrow validated SQLite queries, the loop does not load workflow/checkpoint/recipe/activity prose, and economy
model identities use the shared contract. Final re-review found no remaining violations or justified code smells.
The guarantee concerns coordinator session preparation/execution, not the entire domain-owned daemon process.

### Spec

The initial review found ordinary Astra mappings being rejected without opt-in and ordinary source context being
loaded before coordinator projection. Both were corrected. Re-review checked same-run Discovery provenance, capped
counts, immutable continuation, session accounting and the unchanged one-human-gate semantics, with no remaining
confirmed specification findings. Native qualification and a cost/quality benchmark remain separate gates.

The regression test for ordinary Astra failed before the fix and passed afterwards. Targeted tests also cover
the closed query, count 2 and 50 capped to 20, cross-pipeline isolation, absent Discovery, exact checkpoint identity,
wrong-stage rejection and restart. A direct manager session-loop guard forbids all four prior broad queries and
checks handoff, database reopen, session ordinals 1/2, preserved usage of 110 synthetic tokens and absence of a
checkpoint text canary. The existing ordinary six-stage route is retained.

The repeated full browser suite passed 69/69; the isolated crash-recovery drill passed with one interrupted run,
no replay and one durable report. Compatibility diagnostics passed 17/17 without changing exact admission rows.
The updated feature-local package passed clean installation, receipt/file checks, samples, setup, diagnostics,
startup and log lifecycle; its consumer audit found no known vulnerabilities. This was a DIRTY development
receipt at the feature parent commit, not CLEAN release provenance, and the archive was not published.
Final `pnpm verify` passed for this follow-up: formatting, public readiness, lint, typecheck and the complete
workspace test suite. Final independent review counts: Standards 0 open findings; Spec 0 open findings.
No additional native model calls or admission changes were made during review remediation. The later bounded native
qualification attempt is recorded separately above and does not promote compatibility.

The controls follow the official [subagents reference](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and
[non-interactive execution reference](https://learn.chatgpt.com/docs/non-interactive-mode).
