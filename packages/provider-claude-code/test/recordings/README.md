# `claude -p --output-format stream-json` streams

Spec §11 requires the adapter tests to run against streams **recorded from the real CLI**, never
against invented fixtures: the wire shape is something the CLI decides, and a fixture written from
an assumption tests the assumption instead of the CLI. This file is the inventory. Every entry says
where its file came from; an entry that cannot say "captured from the real CLI" has to say what it
is instead — and one of the two below cannot.

| file                                       | provenance                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not-logged-in.jsonl`                      | Captured from the real `claude` CLI v2.1.114, unauthenticated, in an empty temporary directory. Verbatim except for redaction of absolute paths. Carries genuine `hook_started` / `hook_response` / `hook_progress` events, which is what the redaction test runs on.                                  |
| `hello.jsonl`                              | **Derived, not recorded.** See below.                                                                                                                                                                                                                                                                  |
| `claude-2.1.260-success-macos-arm64.jsonl` | Captured from authenticated Claude Code v2.1.260 on macOS arm64 with the corrected Q14 adapter argv, strict empty MCP config and FAST model `claude-haiku-4-5-20251001`. The source stream proved that removing only Zod's root `$schema` dialect annotation makes the final result schema acceptable. |
| `claude-2.1.260-failure-macos-arm64.jsonl` | Captured from the same CLI/target with the same corrected argv except for deliberately invalid model `loomrail-invalid-model-q14`. It produced a real terminal `is_error: true` result without a useful model turn.                                                                                    |
| `claude-2.1.260-mcp-macos-arm64.jsonl`     | Captured from the same CLI/target with strict session-scoped MCP config and the granted tool projected as `--allowedTools mcp__loomrail_q14__evidence_echo`. The synthetic read-only tool returned `echo:macos-arm64`.                                                                                 |

The three v2.1.260 files are security-filtered real-stream projections, not byte-exact captures. The source streams
contained owner hook events and path-bearing ambient metadata that SD-003 forbids in Git. A mechanical JSON pass kept
only a projected `system/init` line, the terminal `result`, and, for the MCP file, assistant/user lines containing the
synthetic MCP tool exchange. Values in retained fields were not invented or edited, but serialization was normalized.
The discarded source streams remain temporary runtime data and are not committed.

## `hello.jsonl` is derived, and one of its lines is a hand-written assumption

It was made from `not-logged-in.jsonl` by flipping `is_error` to `false`, emptying `modelUsage`, and
**writing the terminal `result` line by hand** so that its `result` field carries checkpoint JSON.
Its `session_id` and `uuid` values were deliberately changed to a distinct, obviously synthetic
`dd000000-…` series, so that no future reader can mistake two files sharing ids for two independent
captures — which is exactly how the derivation was originally missed.

The claim that hand-written line encodes — **that a successful `--json-schema` run puts checkpoint
JSON in the `result` field** — is _unverified against any real CLI_. It is plausible (`result` is the
final assistant text) and it is what the flag documents, but nothing in this repository has ever
observed it. The `claude` CLI available in this environment is unauthenticated, and neither an agent
nor the operator may authenticate one with the owner's credentials.

**This is the second assumption of exactly this shape in milestone A2, and the first one was the
milestone's Critical**: `provider-codex` assumed `--output-schema`'s answer arrived as a bare
un-enveloped line, a fixture encoded that assumption, the test confirmed it, and every real Codex
session silently produced no checkpoint. The owner probe that settles this one is listed in
`docs/plans/11-a2-live-provider-adapters-spec.ru.md` §11.

The test that reads this file is kept regardless: it still pins the shape the adapter assumes, which
is worth pinning. It just must not be read as evidence about the CLI.

## Redaction

`docs/security/THREAT-MODEL.md` (SD-003) forbids committing the owner's own paths or hook output. A
capture is checked for absolute personal paths and secrets before it lands here, and
`pnpm test:public-readiness` re-checks the whole tree on every run.
