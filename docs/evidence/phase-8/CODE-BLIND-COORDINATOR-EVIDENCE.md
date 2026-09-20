# Code-blind coordinator: local evidence

**Date:** 2026-09-19. **Scope:** experimental feature from approved base
`868be0ee9c2054cefeffda1ecc516c62ec2f8099`, separate from the 0.1.3 release.
This is not release provenance. The final section records the later, separately approved exact live execution
admission; earlier smoke and failed attempts are retained as historical evidence and did not authorize it.

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
attempt remains negative evidence and did not authorize compatibility admission: no write tool ran, no six-stage
completion or restart continuation was demonstrated, and the exact installed CLI version remained unadmitted at
this point.

After this fix, provider-core passed 90/90 tests and the complete `pnpm verify` suite passed with Vitest workers
serialized through its supported environment setting. The default parallel browser run had first hit one bounded
client-side navigation timeout under heavy host load; the isolated scenario, the serialized browser package (37/37)
and the complete serialized workspace run all passed without changing product timeouts.

## Successful owner-authorized native qualification, 2026-09-20

The owner then authorized a new, separate ceiling of 200000 input-plus-output tokens for the full native route,
with a minimum 35000-token reserve before every new provider session. The prior negative attempt was not charged
to this new ceiling. The qualification used the installed Codex CLI `0.155.0-alpha.9.2` on `darwin/arm64`, a new
disposable one-file repository and SQLite database outside Git, the production Codex adapter, the production
workspace/MCP bridge and the normal six-stage workflow. Sonnet and Fable remained excluded.

| Stage      | Session | Requested model | Input tokens | Cached input | Output tokens | Reasoning output | Durable result                           |
| ---------- | ------: | --------------- | -----------: | -----------: | ------------: | ---------------: | ---------------------------------------- |
| Discovery  |       1 | gpt-5.6-luna    |        23628 |        14848 |           839 |              171 | safe HumanRequest; no mutation           |
| Discovery  |       2 | gpt-5.6-luna    |        20917 |        11776 |           438 |              140 | COMPLETED                                |
| Plan       |       1 | gpt-6-astra     |         6900 |            0 |           367 |               38 | semantic schema rejection; no checkpoint |
| Plan       |       2 | gpt-6-astra     |         6898 |            0 |           348 |               47 | valid PLAN checkpoint                    |
| Implement  |       1 | gpt-5.6-luna    |        39931 |        28672 |           593 |               79 | COMPLETED                                |
| Review     |       1 | gpt-5.6-luna    |        23622 |        13824 |           476 |              100 | PASSED, zero findings                    |
| Acceptance |       1 | gpt-5.6-luna    |         7018 |            0 |           410 |              223 | READY_FOR_ACCEPTANCE                     |

The exact total was 132385 input-plus-output tokens, leaving 67615 under the authorized ceiling. Cached input is
already part of input and reasoning output is already part of output. The reserve was checked before every spawn;
it was never crossed. QA was the deterministic measured Browser QA stage and did not start a provider session.

The first Discovery session emitted a superfluous non-blocking `Proceeding` confirmation even though it correctly
recognized that no new owner information was needed. The owner explicitly authorized continuing safe gates; the
same durable attempt resumed and completed. The first Astra result was valid JSON but used one-based `dependsOn`
references, so the semantic DAG validator rejected it and opened the normal blocking diagnostic request without
publishing a checkpoint. Inspection of sanitized activity identified the exact mismatch. The owner-authorized
answer requested zero-based references to earlier orders; the same Plan attempt resumed and produced a valid DAG.
These events are retained as qualification evidence rather than hidden as a clean first-pass result.

After the corrected Plan, the harness shut down the MCP gateway, closed SQLite, reopened both and confirmed the
durable Plan sessions were unchanged before continuing. Implement changed the sole tracked file from
`committed\n` to exactly `Current work\n`; independent Review reread the result and returned no findings. The
deterministic QA gate passed, Acceptance produced a criterion-linked package, and the owner-authorized final gate
was resolved only after the harness rechecked all six stages, exact file bytes and the workspace-tool audit. The
PipelineRun ended `SUCCEEDED`, the WorkItem ended `DONE`, and the AcceptancePackage ended `ACCEPTED`.

Runtime invocation assertions and durable policy snapshots established the authority split:

- Astra Plan requested `gpt-6-astra`, had workspace `NONE`, network false and no MCP connections; its closed context
  did not contain the disposable filename or either old/new file contents.
- Discovery and Review requested `gpt-5.6-luna` with read-only workspace tools. Implement requested the same model
  with read-write tools. Acceptance had workspace `NONE` and no MCP connections.
- Durable tool audit recorded all successful write-class operations only under Implement; Discovery and Review
  performed reads, and no manager or Acceptance workspace call existed.

The raw database, CLI activity and disposable worktree remain outside Git. Only this sanitized summary is retained.
As with the smoke probes, persisted requested model IDs and exact CLI arguments do not independently attest the
service-side model identity. The run qualifies this installed native route and its fail-closed recovery behavior;
it is not a quality/cost non-inferiority benchmark and does not itself change compatibility admission.

After recording this evidence, the complete serialized `pnpm verify` passed again: formatting, public readiness,
lint, typecheck and all workspace tests, including provider-core 90/90, Codex adapter 58/58, Browser QA 37/37,
MCP gateway 28/28, persistence 213/213, daemon 370/370 and CLI 33/33.

## Separate compatibility admission, 2026-09-20

- After the successful qualification, the owner separately confirmed execution admission for exact Codex CLI
  `0.155.0-alpha.9.2 / darwin / arm64`. The runtime matrix and fail-closed tests were updated only for that identity.
- Codex allowance reporting for this version remains unverified and unadmitted. No support is inherited by a
  neighboring version, another architecture, Windows or Linux.
- Fable and Sonnet were not exercised; Fable is unavailable in this first slice.
- No measured non-inferiority or full-task savings claim is made.
- The new mode is not part of published npm 0.1.3 and must not ship through that release identity.

After the admission change, focused Codex tests passed 60/60 and combined Codex/Claude compatibility diagnostics
passed 19/19. The complete serialized `pnpm verify` passed formatting, public readiness, lint, typecheck and every
workspace suite on the admitted macOS arm64 host. The same exact-target test stays fail closed on Windows CI.

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
qualification and still later separate owner admission decision are recorded above; no new provider call was needed
for the promotion.

The controls follow the official [subagents reference](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and
[non-interactive execution reference](https://learn.chatgpt.com/docs/non-interactive-mode).
