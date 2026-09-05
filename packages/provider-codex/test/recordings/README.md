# Recorded `codex exec --json` streams

Spec §11 requires the adapter tests to run against streams **recorded from the real CLI**, never
against invented fixtures: the wire shape is something the CLI decides, and a fixture written from
an assumption tests the assumption instead of the CLI. This file is the inventory. Every entry says
where its file came from; an entry that cannot say "captured from the real CLI" has to say what it
is instead.

| file                                                | provenance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello.jsonl`                                       | Captured from the real `codex` CLI (authenticated, empty temporary directory) on a trivial prompt, without `--output-schema`. Verbatim except for redaction; no line was written by hand.                                                                                                                                                                                                                                                                                                                                                            |
| `completed.jsonl`                                   | Captured from the real `codex` CLI v0.144.1 (authenticated, empty temporary directory) driven with **this adapter's exact argv**, `--output-schema` included. Verbatim; no line was written by hand.                                                                                                                                                                                                                                                                                                                                                 |
| `turn-failed.jsonl`                                 | Captured from the real `codex` CLI v0.144.1 (authenticated, empty temporary directory) by adding `-m definitely-not-a-real-model-xyz`, which makes the model endpoint refuse the turn. Verbatim stdout; no line was written by hand.                                                                                                                                                                                                                                                                                                                 |
| `workspace-write.jsonl`                             | Captured from the real `codex` CLI v0.144.1 (authenticated, macOS arm64) driven with **this adapter's E1 worktree argv** inside a real linked worktree, on a run that genuinely edited a file and ran a verification command. No line was written by hand, but unlike the three above this file is **not** the CLI's own bytes: redacting the worktree path re-serialized every line through a JSON round-trip, so all 11 lines are spaced JSON where the CLI emits compact. See "The redaction" below for what that preserves and what it does not. |
| `codex-0.153.0-alpha.5-success-macos-arm64.jsonl`   | Captured from authenticated Codex CLI v0.153.0-alpha.5 on macOS arm64 with the Q14 adapter's exact read-only argv and FAST model `gpt-5.6-luna`. The four stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                                                                                    |
| `codex-0.153.0-alpha.5-failure-macos-arm64.jsonl`   | Captured from the same CLI/target with the same argv except for the deliberately invalid model `loomrail-invalid-model-q14`. It failed before useful inference. The five stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                                                                     |
| `codex-0.153.0-alpha.5-workspace-macos-arm64.jsonl` | Captured from the same CLI/target with the exact writable-workspace argv and FAST model. The run changed only `status.mjs` in a synthetic Git repository and passed `npm run check`. The temporary root name was replaced literally over the raw text; JSON was not parsed or reserialized.                                                                                                                                                                                                                                                          |
| `codex-0.153.0-alpha.5-mcp-macos-arm64.jsonl`       | Captured from the same CLI/target with the exact read-only argv plus the adapter's three session-scoped `mcp_servers.*` assignments. A synthetic read-only MCP tool returned `echo:macos-arm64`. The seven stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                                   |
| `codex-0.153.4-success-macos-arm64.jsonl`           | Captured from authenticated Codex CLI v0.153.4 on macOS arm64 with the adapter's exact read-only argv and FAST model `gpt-5.6-luna`. The four stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                                                                                                |
| `codex-0.153.4-failure-macos-arm64.jsonl`           | Captured from the same CLI/target with the same argv except for the deliberately invalid model `loomrail-invalid-model-01534`. It failed before useful inference. The five stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                                                                   |
| `codex-0.153.4-workspace-macos-arm64.jsonl`         | Captured from the same CLI/target with the exact writable-workspace argv and FAST model. The run changed only `status.mjs` in a synthetic Git repository and passed `npm run check`. The temporary root name was replaced literally over the raw text; JSON was not parsed or reserialized.                                                                                                                                                                                                                                                          |
| `codex-0.153.4-mcp-macos-arm64.jsonl`               | Captured from the same CLI/target with the exact read-only argv plus the adapter's three session-scoped `mcp_servers.*` assignments. A synthetic annotated read-only MCP tool returned `echo:macos-arm64-01534`. The seven stdout lines are byte-exact; no replacement was needed.                                                                                                                                                                                                                                                                   |

`completed.jsonl` replaced an earlier file of the same name that was **not** a recording: its final
line was an invented, un-enveloped checkpoint object, which is where the adapter wrongly expected
`--output-schema`'s answer to arrive. The real capture shows the answer arriving as the `text` of an
`item.completed` / `agent_message` event, and the adapter never looked there — so every real Codex
session ended with no checkpoint, and the test built on the invented line confirmed the mistake
instead of catching it.

## `workspace-write.jsonl`

Captured with the owner's explicit authorisation to spend quota, by the exact invocation this
adapter builds when it is given a workspace:

```
codex exec --json --ignore-user-config \
  -C <worktree> \
  -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --output-schema <schema.json> \
  "<prompt>" < /dev/null
```

`<schema.json>` was generated from the shipped contract rather than hand-written:
`z.toJSONSchema(checkpointDraftSchema)` from `@loomrail/contracts`. `<worktree>` was a real linked
worktree (`git worktree add -b loomrail/probe-task`) of a throwaway repository holding `greet.js`
and `README.md` on one commit. The prompt asked for an exported `farewell(name)` in `greet.js` and
for a node one-liner verifying it; the agent did both — the file on disk gained the function and the
verification command exited 0 printing `Goodbye, world`.

**What it proves.** Line 3 is a schema-valid `agent_message` emitted **before any tool work**, whose
`summary` states an intention ("I'll inspect `greet.js`, add the export, then run…") with
`completed: []`. Line 10 is the real answer, with `completed` populated. The two are
indistinguishable by shape and by `item.type`, so a first-wins checkpoint parser closes the stage as
COMPLETED carrying a summary that reports intention as completion (spec §2.6 / decision D9) — now
observed on a run that actually edited a file rather than on a trivial prompt.

It also carries what the A2 parser did not model: `item.started` events, and the item types
`command_execution` and `file_change`. Commands are executed through `/bin/zsh -lc`.

**The redaction.** One substitution, in content: the absolute worktree path became
`/tmp/loomrail-worktree`, where it appeared in `file_change.changes[].path`. Checked afterwards for
the owner's username, the macOS home-directory prefix, the session temp root and
`Application Support`: none occur. (`pnpm test:public-readiness` refuses that prefix in any tracked
file, this inventory included, which is why it is described here rather than written out.)
`thread_id` is left as recorded, matching the other entries above.

**But the substitution was not applied to the bytes.** It was applied to parsed objects, and the
stream was written back out by re-serializing each line — so this file is the CLI's _values_, not
the CLI's bytes. Every one of its 11 lines is spaced JSON (`{"type": "turn.started"}`); the three
captures above are the compact JSON the CLI actually writes (`{"type":"turn.started"}`). An earlier
version of this row claimed "one substitution, applied to the whole stream", which described a
`sed`-shaped edit this capture never had.

What the round-trip preserves: every key, in the order the CLI emitted it; every value, including
the non-ASCII characters this stream contains, which survived as themselves rather than as `\uXXXX`
escapes; the line count and the one-object-per-line framing the adapter's parser reads. What it does
not preserve: inter-token whitespace, and therefore the exact byte sequence — so this file cannot
answer a question about the CLI's own serialization (whether it escapes non-ASCII, how it spaces
separators, whether a line arrives split). Those questions belong to `hello.jsonl`,
`completed.jsonl` and `turn-failed.jsonl`, which are byte-exact. Nothing this file is used for
depends on them: the adapter parses each line with `JSON.parse`, which is indifferent to spacing.

A future capture should be redacted on the bytes (a literal substitution over the text) so it stays
byte-exact like the others.

## Redaction

`docs/security/THREAT-MODEL.md` (SD-003) forbids committing the owner's own paths or hook output. A
capture is checked for absolute personal paths and secrets before it lands here, and
`pnpm test:public-readiness` re-checks the whole tree on every run.

## Adding a recording

Run the adapter's argv against the real CLI, redact **by substituting over the text**, commit the
bytes unchanged, and add a row above. Do not hand-edit a captured line: an edited capture is a
fixture wearing a recording's name, and the row here must then say so. Reformatting is an edit too,
even when no value changes — if a redaction step parses and re-writes the stream, the row above has
to say that, as `workspace-write.jsonl`'s now does.
