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

## Remaining release gates

- The new installed Codex version is still **not admitted** by Loomrail; existing exact admission rows are unchanged.
- Full native workspace/MCP allow-deny, six-stage workflow and recovery qualification are still required.
- Fable and Sonnet were not exercised; Fable is unavailable in this first slice.
- No measured non-inferiority or full-task savings claim is made.
- The new mode is not part of approved npm candidate 0.1.3 and must not ship through that candidate.

The controls follow the official [subagents reference](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and
[non-interactive execution reference](https://learn.chatgpt.com/docs/non-interactive-mode).
