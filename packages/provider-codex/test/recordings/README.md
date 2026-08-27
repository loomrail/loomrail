# Recorded `codex exec --json` streams

Spec §11 requires the adapter tests to run against streams **recorded from the real CLI**, never
against invented fixtures: the wire shape is something the CLI decides, and a fixture written from
an assumption tests the assumption instead of the CLI. This file is the inventory. Every entry says
where its file came from; an entry that cannot say "captured from the real CLI" has to say what it
is instead.

| file              | provenance                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello.jsonl`     | Captured from the real `codex` CLI (authenticated, empty temporary directory) on a trivial prompt, without `--output-schema`. Verbatim except for redaction; no line was written by hand.            |
| `completed.jsonl` | Captured from the real `codex` CLI v0.144.1 (authenticated, empty temporary directory) driven with **this adapter's exact argv**, `--output-schema` included. Verbatim; no line was written by hand. |

`completed.jsonl` replaced an earlier file of the same name that was **not** a recording: its final
line was an invented, un-enveloped checkpoint object, which is where the adapter wrongly expected
`--output-schema`'s answer to arrive. The real capture shows the answer arriving as the `text` of an
`item.completed` / `agent_message` event, and the adapter never looked there — so every real Codex
session ended with no checkpoint, and the test built on the invented line confirmed the mistake
instead of catching it.

## Redaction

`docs/security/THREAT-MODEL.md` (SD-003) forbids committing the owner's own paths or hook output. A
capture is checked for absolute personal paths and secrets before it lands here, and
`pnpm test:public-readiness` re-checks the whole tree on every run.

## Adding a recording

Run the adapter's argv against the real CLI, redact, commit the bytes unchanged, and add a row
above. Do not hand-edit a captured line: an edited capture is a fixture wearing a recording's name,
and the row here must then say so.
