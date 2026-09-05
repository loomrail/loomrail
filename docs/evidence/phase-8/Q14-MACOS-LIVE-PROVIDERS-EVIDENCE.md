# Q14 macOS live-provider evidence

**Date:** 2026-09-04; Codex exact-target refresh: 2026-09-05

**Scope:** owner-authorized quota-bearing compatibility capture on macOS arm64; Windows explicitly pending

## Exact targets

| Provider    | CLI               | Runtime target                | Install kind                                                                          | FAST model                  | Invocation revision                        |
| ----------- | ----------------- | ----------------------------- | ------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------ |
| Codex       | `0.153.0-alpha.5` | Darwin 25.4.0, `darwin/arm64` | Native arm64 CLI bundled with ChatGPT desktop                                         | `gpt-5.6-luna`              | Q14 Codex JSONL/read-only/workspace/MCP v1 |
| Codex       | `0.153.4`         | Darwin 25.4.0, `darwin/arm64` | Native arm64 CLI bundled with ChatGPT desktop                                         | `gpt-5.6-luna`              | Q14 Codex JSONL/read-only/workspace/MCP v1 |
| Claude Code | `2.1.260`         | Darwin 25.4.0, `darwin/arm64` | npm global package in the active Node 24.19 NVM installation; native arm64 executable | `claude-haiku-4-5-20251001` | Q14 Claude stream-json/plan/strict-MCP v1  |

Both exact version probes and provider-owned auth commands completed successfully. After the compatibility corrections
below, packaged Doctor reports `VERIFIED`, `AUTHENTICATED`, and `ready=true` for both live providers on this target.
The matrix key is exact `(version, platform, architecture)`: these rows do not admit Windows, Linux, macOS x64, or a
newer provider version.

The 2026-09-05 refresh promotes the installed Codex `0.153.4` target without inferring a version range. Its exact
read-only invocation produced a schema-valid terminal result with 14,252 input, 71 output and 14 reasoning tokens.
The writable synthetic-repository run changed only `status.mjs`, passed `npm run check`, and reported 74,883 input
tokens (56,320 cached), 674 output tokens and 92 reasoning tokens. The session-scoped MCP run called exactly the
annotated read-only `loomrail_q14.evidence_echo` tool, received `echo:macos-arm64-01534`, and reported 43,276 input
tokens (28,160 cached), 289 output tokens and 91 reasoning tokens. The controlled invalid-model run produced a
terminal provider failure before useful inference. The four sanitized recordings replay through the current adapter
and the same independent final-result schema validation as the original Q14 captures.

The allowance-specific `0.153.4 / darwin / arm64 / ChatGPT` row was checked independently through the bounded
production App Server reader and returned a live three-window projection. That read started no model turn and does
not substitute for the execution evidence above.

## Real CLI capture

The owner explicitly authorized provider quota. Prompts and repositories were public synthetic fixtures; no private
repository text was sent. Codex success used 14,245 input and 47 output tokens. Its workspace run changed one line in
`status.mjs`, passed `npm run check`, and used 74,024 input tokens of which 56,320 were cached, plus 560 output and 99
reasoning tokens. Its successful MCP run used 43,308 input tokens of which 28,160 were cached, plus 311 output and 81
reasoning tokens. Codex did not report currency cost.

Claude's successful schema run cost USD 0.054243 and returned a schema-valid terminal result. The successful MCP run
cost USD 0.0283964, connected the strict `loomrail_q14` server, called exactly the granted read-only
`mcp__loomrail_q14__evidence_echo` tool, and received `echo:macos-arm64`. Controlled invalid-model captures for both
providers failed on the typed provider-failure path without useful model work.

Committed recordings are inventoried beside the adapter tests. Codex files preserve captured stdout bytes except for
one literal temporary-root substitution in the workspace stream. Claude source streams contained owner hook events
and ambient path metadata; the committed files are mechanically filtered JSON projections retaining only safe init,
terminal result, and synthetic MCP exchange fields. The raw source streams remain temporary runtime data outside Git.

## Corrections found by the real gate

The first Claude success invocation failed before inference because v2.1.260 rejects Zod's root JSON Schema 2020-12
dialect URI. The provider adapter now removes only that root annotation; the same closed object, required fields,
nested union and final runtime validation remain.

The first Claude MCP invocation connected the strict server but denied the tool because the adapter wrote the proxy
config without projecting `ProviderMcpConnection.enabledTools`. The adapter now emits only exact
`mcp__<connection-id>__<granted-tool>` names through `--allowedTools`; empty connection sets emit no flag. The
successful retry used no permission bypass.

The first Codex MCP attempt correctly denied an unannotated tool under noninteractive approval policy. Marking the
synthetic tool with standard read-only/idempotent/closed-world annotations allowed the retry; Loomrail did not add an
approval or bypass flag.

Finally, Doctor initially reported Claude auth as required even after successful quota-bearing sessions. The bounded
auth process environment omitted the ordinary OS `USER` identity that Claude uses to locate provider-owned auth.
`USER` and `LOGNAME` are now admitted while unrelated environment values remain excluded; a canary test proves the
boundary.

## Replay and local verification

- Provider core: 6 files, 58 tests passed, including exact platform/architecture mismatch and auth-env canary cases.
- Codex adapter: 3 files, 67 tests passed, including current success/failure/workspace/MCP replay and independent
  final-result schema validation.
- Claude Code adapter: 3 files, 45 tests passed, including current success/failure/MCP replay, dialect omission,
  exact granted-tool argv, and independent final-result schema validation.
- Focused compatibility gate: 2 files, 11 tests passed.
- CLI dependency build completed across 18 packages; local Doctor status is `PASS` with both live providers ready.
- Repository-wide typecheck and the complete sequential test suite across 22 workspace packages pass.
- Fault injection passes, including the real child-process crash drill: one interrupted run, no replay and one durable
  report. All 53 Playwright E2E cases pass. Release packaging and isolated clean-install verification pass with zero
  audit vulnerabilities; no artifact was published.
- Repository-wide `pnpm verify` passes formatting, the 662-file public-tree check, pinned toolchain checks and the
  complete build, then stops at exactly the three pre-existing protected `apps/landing/src/main.ts` lint findings on
  lines 630, 631 and 634. Focused ESLint over every changed TypeScript file passes. The final two-axis review against
  the preceding Q14 slice found no in-scope Standards or Spec P0/P1/P2 findings.

Managed public dogfood is recorded after this compatibility slice. The protected `apps/landing/**` blocker remains
outside this slice and is neither edited nor excluded.

### 2026-09-05 exact Codex refresh verification

- Codex adapter replay, negative corpus, process lifecycle and allowance suite: 5 files, 99/99 tests passed.
- Focused Codex/Claude compatibility gate: 2 files, 15/15 tests passed.
- Public-tree/toolchain/activation gate passed across 770 files; repository-wide lint, strict typecheck and the full
  sequential workspace test suite passed.
- Packaged Doctor reports Codex `0.153.4` and Claude Code `2.1.260` as exact `VERIFIED`, `AUTHENTICATED` and ready.
  Its overall `WARN` is solely the closed `STATE_UPGRADE_REQUIRED` observation for an older local database; no state
  was reset or migrated as part of compatibility verification.
- The top-level `pnpm verify` reached formatting first and stopped only on two unrelated untracked research documents.
  Every file in this compatibility change passes the committed formatter, and all remaining `verify` stages above
  were run directly to completion. Remote CI receives neither unrelated untracked document.

## Managed public dogfood rehearsal

The pinned public Todo repository was copied to an isolated local worktree and never pushed. Codex implemented
server-side `all`/`pending`/`completed` filtering and its accessible native filter control; an independent Claude
review drove bounded fixes before passing the exact current tree. The final tree identity remained
`cb92732302851e6642035886f82fbb3e8424263b` throughout measured Browser QA and Acceptance.

The first complete deterministic browser baseline ran all eight target/scenario cells on tree
`c181b7ffd6eb7289ae4e37b03a544a0a1910e047` and failed with 44 HIGH defects. Correction 1 retested the same locked
eight cells on tree `232eb45d5e31d18c9c1eab451c592f8d9e66a2d3`; it found 16 additional HIGH defects and became `SUPERSEDED`.
Correction 2 retested the same eight cells on the final tree `cb92732302851e6642035886f82fbb3e8424263b`, passed
all 24 required assertions, finalized ten screenshot/trace attachments with no blocking console or network
observation, and resolved all 60 HIGH defects through exact passing-retest provenance. The matrix covered All,
Pending, Completed, reload, desktop light and mobile dark targets. An earlier setup `ERROR` produced no evidence and
did not replace the complete failed baseline.

The live run exercised a controlled daemon restart three times and stayed below its hard pipeline budget: 17 durable
usage records total 4,818,908 of 5,000,000 tokens. Dogfood exposed and verified three Loomrail corrections:

- a schema-valid but stage-invalid terminal provider outcome now closes the session and actual usage atomically,
  hard-pauses without advancing, and opens an answerable owner recovery request with the stable domain error code;
- a second orphaning episode after explicit resume now records a second append-only RecoveryReport instead of
  preventing daemon startup on a uniqueness conflict;
- Acceptance context now contains only the authoritative current-tree Review and measured QA artifacts, while the
  provider schema enumerates exact criteria and evidence checks rather than accepting stale or paraphrased claims.

The retried live Acceptance session ended `COMPLETED` and created an AcceptancePackage that maps all nine criteria to
the exact Review and measured-QA evidence and exposes the remaining medium application risk. The package began
`PENDING`; Loomrail itself selected no disposition. On 2026-09-04 at `15:48:21.526Z`, the local human owner used the
separate gate to accept it. The package is now `ACCEPTED` at version 2, the WorkItem is `DONE`, and the PipelineRun
completed in the same durable transition. The pre-resolution authenticated release-summary export rendered 64,271
bytes of Markdown with all nine criterion rows, the Review/QA evidence, decisions and the then-current 282 audit
events; a bounded check found no personal absolute path. The three owner-resolution events bring the final WorkItem
audit to 285 events. The public repository remains a rehearsal, not the private-dogfood evidence required by the
stable contract.

This rehearsal had one active Task plus one cancelled precursor, not a 2–3 Task dependency DAG. It therefore does not
close that separate dogfood-contract item either; no dependency evidence is inferred from sequential workflow stages.

## Remaining release gates

Windows has no quota-bearing row for either exact version and remains blocking for the full compatibility target.
Provider binary provenance is observed as install metadata, not runtime-attested. This public rehearsal's owner gate
is closed. Private dogfood (including its own owner acceptance and 2–3 Task DAG), trusted publisher provenance, and
the protected landing gate remain separate stable-release requirements.
