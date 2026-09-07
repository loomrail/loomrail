# Q20 local subscription workspace execution evidence

**Date:** 2026-09-07

**Status:** focused execution evidence; commit/digest/ancestry promotion remains pending

## Scope

This evidence covers the production replacement of direct OpenAI/Anthropic API adapters with locally installed,
subscription-authenticated Codex CLI and Claude Code CLI processes. It also covers the provider-neutral bounded
workspace executor used by IMPLEMENT and provider-authored QA.

It does not claim Windows compatibility, a complete private-project Epic, registry provenance or stable publication.
The later complete public rehearsal is recorded separately in
`Q20-MANAGED-PUBLIC-DOGFOOD-EVIDENCE.md`.

## Runtime observations

The owner authorized focused subscription-backed model runs on macOS arm64. The admitted runtimes were:

| Provider    | Exact CLI version | Authentication                | Result                                             |
| ----------- | ----------------- | ----------------------------- | -------------------------------------------------- |
| Codex       | `0.153.4`         | existing provider-owned login | IMPLEMENT read/write and QA read-only calls passed |
| Claude Code | `2.1.260`         | existing provider-owned login | IMPLEMENT read/write and QA read-only calls passed |

Each runtime reached the real one-use loopback MCP proxy and the real Loomrail executor. The temporary workspace path
contained spaces and Unicode. IMPLEMENT performed an audited bounded read and write; QA performed audited bounded
reads without write authority. Each session produced one terminal usage report. No direct provider HTTP request, API
key, account mutation, CLI install/update or purchase was used.

The live checks exposed two compatibility corrections that are covered by adapter tests:

- Codex keeps its general code-mode host disabled and exposes only the exact session MCP namespace as direct tools;
  non-interactive acknowledgement applies only to that closed enabled-tool list.
- Claude uses `--restricted`, empty setting sources, strict explicit MCP, empty built-in tools and the exact Loomrail
  allowlist. `--safe-mode` is excluded because the admitted version disables the explicitly supplied custom MCP in
  that mode.

## Enforced product seam

- Provider-specific argv, JSONL frames, tool names and continuation payloads stay inside their adapters.
- The provider-neutral interface accepts only list, bounded read, CAS write, CAS non-recursive delete and an exact
  owner-approved verification recipe ID.
- Paths are NFC relative portable paths. Traversal, absolute/drive/UNC/backslash forms, Windows reserved names,
  trailing dot/space, symlinks, special files, `.git`, `.loomrail`, `.env*` and credential/key paths fail closed.
- IMPLEMENT receives explicit `READ_WRITE`; QA receives `READ_ONLY`. There is no arbitrary command, argv, environment,
  install, Git mutation, commit, push, merge or deploy authority.
- Tool-call reserve/finish and append-only events are durable. Session-bound hashed call keys provide idempotency;
  restart marks uncertain effects `UNKNOWN_OUTCOME` without replay.
- Provider output is runtime-schema-validated, size-limited and treated as untrusted data. Raw provider payload,
  transcript, file content, command output and credentials are not persisted.
- A live IMPLEMENT completion requires a successful audited `WRITE_FILE` or `DELETE_FILE` in the same domain-owned
  Project/WorkItem/StageAttempt; provider-session continuation may reuse that proof, but another attempt cannot.
  Otherwise the deterministic domain returns `IMPLEMENT_EFFECT_NOT_OBSERVED` and hard-pauses the workflow.
- Both local runtimes declare `POST_SESSION`. Time, process tree, turns, tool calls and output are bounded before and
  during execution; actual tokens update the authoritative ledger once and may stop later dispatch. No exact
  in-flight token ceiling is claimed.

## Automated verification

On the final working tree:

- repository `pnpm verify` passed formatting, public-tree/toolchain/activation checks, lint, strict typecheck and all
  package tests;
- domain passed 303 tests, persistence passed 157, daemon passed 247, Codex adapter passed 47, Claude adapter passed
  12, MCP gateway passed 27 and CLI passed 33;
- the complete product browser suite passed 60/60 sequentially;
- the protected landing browser suite passed 7/7, including 320/375/414/768-pixel overflow checks;
- the release archive built and passed clean-install verification of samples, setup, local CLI diagnostics, receipt,
  installed files and log lifecycle;
- the stable release gate parser rejects schema v2 and the retired hard-token gate, while schema v3 remains `2/11`
  with no selected stable version.

Automated provider tests use only test-code CLI doubles and injected process/transport seams. They perform no live
model request and require no provider credential.

## Privacy review

Production provider source contains no direct API endpoint or API-key configuration. Test canaries prove that
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `.env` contents and unrelated environment secrets do not reach child processes,
workspace tool output, state, events or logs. This document contains no personal absolute path, account identifier,
credential, raw provider frame or private repository content.

## Pending promotion work

This file cannot authorize a stable row while it is uncommitted. After owner-requested commit and review, promotion
still requires exact evidence digest/commit ancestry. Windows local-CLI execution and the complete owner-selected
private dogfood contract remain independent pending gates.
