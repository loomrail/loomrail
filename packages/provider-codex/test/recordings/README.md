# Recorded `codex exec --json` streams

Spec §11 requires the adapter tests to run against streams **recorded from the real CLI**, never
against invented fixtures: the wire shape is something the CLI decides, and a fixture written from
an assumption tests the assumption instead of the CLI. This file is the inventory. Every entry says
where its file came from; an entry that cannot say "captured from the real CLI" has to say what it
is instead.

| file                    | provenance                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello.jsonl`           | Captured from the real `codex` CLI (authenticated, empty temporary directory) on a trivial prompt, without `--output-schema`. Verbatim except for redaction; no line was written by hand.                                                                                                     |
| `completed.jsonl`       | Captured from the real `codex` CLI v0.144.1 (authenticated, empty temporary directory) driven with **this adapter's exact argv**, `--output-schema` included. Verbatim; no line was written by hand.                                                                                          |
| `turn-failed.jsonl`     | Captured from the real `codex` CLI v0.144.1 (authenticated, empty temporary directory) by adding `-m definitely-not-a-real-model-xyz`, which makes the model endpoint refuse the turn. Verbatim stdout; no line was written by hand.                                                          |
| `workspace-write.jsonl` | Captured from the real `codex` CLI v0.144.1 (authenticated, macOS arm64) driven with **this adapter's E1 worktree argv** inside a real linked worktree, on a run that genuinely edited a file and ran a verification command. Verbatim except for one redaction; no line was written by hand. |

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

**The one redaction:** one substitution, applied to the whole stream — the absolute worktree path became
`/tmp/loomrail-worktree`, where it appeared in `file_change.changes[].path`. Checked afterwards for
the owner's username, the macOS home-directory prefix, the session temp root and
`Application Support`: none occur. (`pnpm test:public-readiness` refuses that prefix in any tracked
file, this inventory included, which is why it is described here rather than written out.)
`thread_id` is left as recorded, matching the other entries above.

## Redaction

`docs/security/THREAT-MODEL.md` (SD-003) forbids committing the owner's own paths or hook output. A
capture is checked for absolute personal paths and secrets before it lands here, and
`pnpm test:public-readiness` re-checks the whole tree on every run.

## Adding a recording

Run the adapter's argv against the real CLI, redact, commit the bytes unchanged, and add a row
above. Do not hand-edit a captured line: an edited capture is a fixture wearing a recording's name,
and the row here must then say so.
