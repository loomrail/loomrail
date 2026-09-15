# ADR-0034: Bounded diagnostic provider activity

**Status:** Accepted

**Date:** 2026-09-15

## Context

ADR-0014 gave Loomrail one authoritative account of what a provider session did to a workspace. Every call
through the daemon-owned gateway reserves a `WorkspaceToolCall` and appends `WORKSPACE_TOOL_CALL_CHANGED`
before the side effect, and that record is append-only, carries only scope IDs, a hashed call key, operation,
bounded target, digests and typed outcome, and never stores file contents, command output or a raw provider
payload. It is deliberately narrow: it says what Loomrail permitted and performed, in Loomrail's own closed
vocabulary.

Both local CLIs also narrate their own actions on stdout, and neither adapter took anything from that
narration. For Codex the rationale is written down and still in the code: `packages/provider-codex/src/stream.ts`
folds every such line into a payload-free `item.ignored` case whose comment says the event carries no payload
deliberately, because Loomrail's account of what a session changed comes from `git diff` against the worktree,
and modelling the provider's own `file_change.changes[]` would stand up a second, weaker source for a fact that
already has a strong one. The Claude Code adapter exposed only the terminal `result` event, and dropped every
`system` event outright because hook events carry stdout and stderr captured on the owner's machine (SD-003).

That reasoning is correct and is not being reversed. It answers the question "what changed", and the answer
stays `git diff`, measured verification and domain-owned Acceptance. It does not answer a different question
the owner keeps asking during and after a run: what is the agent doing, and what did it do. The audited trail
cannot answer that one. It records only what crossed the gateway, in operation codes rather than in the
provider's own words, and it holds nothing the agent said about its own work. Between a session's start and its
typed outcome the Task Cockpit could show a list of gateway calls and nothing else, and the Agent Fleet table
could say a run was RUNNING without saying what it was running.

The same discard also broke the adapters' own diagnostics, as the code already admitted: the ignored lines were
counted in `linesUnused`, so a healthy workspace-write session reported that its adapter had failed to use most
of its own stream. A counter that fires on every successful run is not a signal.

The reversal is therefore narrow, and it is justified by the distinction the original rationale was defending.
What was refused was a second source of truth. What is added here is not a source of truth at all: it is stored
apart from the audited trail, labelled at read time with where each entry came from, prunable, and invisible to
the domain.

Raw provider stdout/stderr remains unrecorded under SD-003, and the statement to that effect in
`docs/security/THREAT-MODEL.md` §Q7 stays true. This decision covers a bounded projection only. Capturing the
raw stream in file segments behind an owner opt-in is a separate decision that has not been taken.

## Decision

### A diagnostic feed that carries no authority

`AgentRunActivity` is a bounded, redacted, prunable record of what a provider reported doing during one
AgentRun. It explains a run; it never proves anything about one.

Nothing in it enters the append-only Event vocabulary: both of its commands (`RECORD_AGENT_RUN_ACTIVITY`,
`MARK_AGENT_RUN_ACTIVITY_DEGRADED`) return results with no `event` field, so a recorded action appends no
domain history. `@loomrail/domain` does not read it. It takes no part in Acceptance, the acceptance package,
the launch evidence package, insights, reporting export or the crash payload. The IMPLEMENT completion gate is
unchanged: an attempt still completes only on an audited `WRITE_FILE`/`EDIT_FILE`/`DELETE_FILE` in the same
StageAttempt, and no provider-reported entry can supply it.

### Capture stays inside the adapter

The shape of these events is provider-specific, so parsing stays where provider payloads already live. Each
adapter reads its own stream in `onLine` and hands out only the neutral, `.strict()`-bounded
`ProviderActivityEntry` through a new optional `ProviderSessionListener.onActivity`, optional in the same way
as `onAllowance` and `onProcessStarted`: an adapter that never calls it is still correct. Activity parsing is a
separate function from the outcome parser in both packages, so an action the adapter cannot read can never
change what Loomrail believes about the session's result.

Each entry carries `actionKey`, `kind`, `label` (at most 500 characters), `detail` (at most 2,000), `status`
(at most 120), `terminal` and `truncated`. What the parsers take is deliberately thin:

- Codex `command_execution` becomes a `TOOL_CALL` labelled with the command, with the exit code as status;
  `aggregated_output` is not read.
- Codex `file_change` becomes a `FILE_CHANGE` carrying paths only, never the content of a change.
- Codex `agent_message` becomes `AGENT_TEXT`.
- Claude Code `tool_use` becomes a `TOOL_CALL` labelled with the tool name, with at most one target value
  looked up by tool name from a closed table (`command`, `file_path`, `pattern`). The argument object is never
  serialized, so provider-supplied file content cannot ride in by construction rather than by filtering.
- Claude Code `tool_result` contributes only a verdict — `ok` or `error` — onto the entry its `tool_use`
  created. `content` is the tool's output and is not stored.
- Claude Code `text` blocks become `AGENT_TEXT`, keyed by the line's own `uuid` (or `message.id`) plus the
  block index, so two different messages cannot merge into one stored row.
- Claude Code `system` lines, which carry the CLI's own init output and the owner's hook stdout/stderr, are not
  in the parsed union at all, so they cannot reach an entry through an unseen subtype (SD-003).

The `kind` vocabulary reserves `PROVIDER_ERROR`, but no shipped parser emits it; the feed currently carries
tool calls, file changes and agent text only.

One provider action produces exactly one entry. A provider reports an action twice — start and completion —
and the terminal report updates the row the start created, keyed on the provider's own action identifier.
An action whose completion never arrives keeps `status = null` and reads as unfinished, which is honest rather
than defective. `actionKey` is the one field never truncated: two distinct long identifiers cut to a shared
prefix would merge two different actions into one row, so an over-long key makes the whole entry fail
validation and be dropped instead.

### Two sources, different authority, merged only on read

Storage stays separate. `workspace_tool_calls` remains the audited, append-only, undeletable record; the new
`agent_run_activity` table holds the provider's unverified account of itself. Nothing mixes them at rest.

`origin` — `DAEMON_AUDITED` or `PROVIDER_REPORTED` — is computed by the reader from which table a row came
from. It is not a column and is never accepted from a provider, because a stored origin is a value that can be
written wrongly. The merge is done on the server so the client has one cursor and one order rather than two
independently paginated lists, and the order is `(at, origin, id)` compared code-unit-wise, matching the
BINARY collation of the SQL that orders the audited side, so two requests never disagree about equal
timestamps.

The cursor is opaque base64url over that same triple, parsed back through a `.strict()` schema; a malformed or
forged cursor is refused with `INVALID_ACTIVITY_CURSOR` rather than silently treated as "start again", and a
cursor naming a position that has since been pruned restarts the page from the oldest entry still held with
`gap: true` so the owner is told about the hole. `seq` is monotonic within one source and not dense, and it is
not the cursor.

The audited action is now shown in exactly one place. `WORKSPACE_TOOL_CALL_CHANGED` no longer renders in the
WorkItem Activity timeline, which stays the work item's lifecycle history; Run Activity is that action's sole
home.

### Storage is deliberately mutable and prunable

Migration 0062 adds `agent_run_activity` and `agent_run_activity_state`, both `STRICT`, with length checks
mirroring the contract's bounds and foreign keys to Project, WorkItem, AgentRun and ProviderSession. Unlike
`events` and `workspace_tool_calls`, this table is meant to be written over and deleted from: a terminal
report upserts on `(provider_session_id, action_key)`, never overwriting a non-null `label`/`detail` with null,
and at most 1,000 entries are kept per run. Past that, the oldest are evicted by `seq` and the run's
`omitted_count` grows, which the owner is shown. Eviction is what makes `seq` sparse.

Two per-run facts live beside the entries because no entry can carry them: how many were dropped, and whether
the recorder ever failed.

### Recording is best-effort and cannot fail the run it describes

`onActivity` runs inside the adapter's stdout handler, where `runProcess` wraps every line listener in a guard
that stops the child and rejects the session on a throw. A diagnostic must never be able to kill the run it is
diagnosing, so the callback validates, redacts and enqueues, and nothing on that path opens a transaction. Its
outer `catch` — the last thing before that guard — sets the degraded flag by bare assignment first and puts
everything that can throw, the logger included, inside a further guard.

Writing happens on a 250 ms drain off the hot path, with a forced final drain in the session's `finally` so a
queue tail is not lost with the session. The in-memory queue is bounded at 500 entries: a provider that outruns
the drain loses the newest entries and the feed says so, rather than growing without limit inside a
long-running daemon.

`degraded` is a property of the AgentRun, not of a session, and it survives handoff between sessions of the
same run. It is set when the queue overflows, when a write fails, when the recorder itself throws, and by
startup reconciliation for every AgentRun it interrupts, because the queue died with the process and nothing
will ever write what it held. Marking it is its own short command with its own transaction, since the write
that failed has already rolled back and cannot record its own failure; the session's final drain marks it
again as a backstop.

### Redaction and confinement happen before the write

Everything that reaches `label`, `detail` or `status` passes through `sanitizeSupervisedOutput` from
`@loomrail/process-supervision` with the redaction set the workspace executor already builds — the same exported
`secretRedactions` predicate over the same environment and the same daemon roots — plus this session's own
worktree path. That
strips ANSI escape sequences and control characters, normalizes newlines, and replaces every redaction value
with `[REDACTED]`. No second sanitizer was written.

A reported path is normalized against the worktree lexically, before redaction rather than after, since
redacting first would leave nothing for normalization to recognize. A path that resolves outside the worktree —
or any absolute path in a session that has no worktree — becomes the opaque marker `[path outside workspace]`,
never a relative escape that still describes the owner's directory layout. Paths that stay inside are recorded
with POSIX separators so the same run reads the same way on any machine that later opens the database.

Text that does not fit its bound is cut on a code-point boundary and the entry is flagged `truncated`; there is
no silent trimming and no ellipsis appended to the text itself. Redaction can make a string longer than the
parser left it, so the bounds are applied after it.

### Delivery and surfaces

The event-channel frame is unchanged: it remains three opaque identifiers, `eventSignalSchema` was not
extended, and the client fetches content over ordinary authenticated HTTP on a signal. Because recording
appends no Event, the recorder publishes that signal directly rather than through the Event-broadcasting seam,
debounced to at most one per 250 ms so a chatty run does not become a stream of frames.

`GET /api/v1/agent-runs/:runId/activity` is authenticated like every other read, scoped by AgentRun existence
exactly as the neighbouring `:id` routes are, and answers with `cache-control: no-store` and
`x-content-type-options: nosniff`. A page carries at most 200 entries plus `nextCursor`, `omittedCount`,
`degraded` and `gap`.

In the Task Cockpit the section is collapsed to the latest action and a count; its body is absent from the DOM
entirely until the owner expands it, so a long run costs nothing to render until it is asked for. Origin is
shown as words, not colour, and the expanded view carries a plain-language explanation of what the two origins
mean. Agent Fleet stays a table and gains one latest-action column, filled for RUNNING entries by a single
projection query across both sources rather than by paging the feed. All provider text is rendered as text;
nothing interprets it as Markdown, HTML or a link.

## Consequences

- The owner can see what an agent is doing while it runs and what it did in a finished run, without a raw log
  and without the feed being able to claim anything.
- The two authorities stay legible. An audited action and a provider claim are stored apart, labelled apart and
  described apart in the UI, so the feed cannot quietly launder a provider's account into evidence.
- Untrusted provider text now reaches the owner's UI on a new surface. It is bounded, redacted, stripped of
  control characters and rendered as text, but it is still the provider's own words on the owner's screen, and
  it is the first such surface outside the checkpoint and report paths.
- There is a new table outside the append-only history, with its own retention rules: rows are updated in
  place and evicted. Its only implemented bound is the 1,000-entry per-run cap. The age-based cleanup SD-004
  describes for unpinned diagnostic data is not wired to this table, so a long-lived database keeps up to
  1,000 entries per AgentRun indefinitely.
- Every recorded entry costs one receipt row in the append-only `commands` table, and an action that reports
  twice costs two. This is an accepted known limit, not an oversight: `WORKSPACE_TOOL_CALL_CHANGED` already
  writes one command per action, so the property exists in this code without the feed, and removing it needs
  retention over `commands`, which changes the idempotent-replay guarantee and deserves its own specification.
  Heavy local use grows the database faster than it otherwise would.
- `degraded` is what the owner sees instead of a quietly short feed. It means the recorder knows this run's
  feed is incomplete — it overflowed, a write failed, the recorder threw, or the daemon died mid-run — and it
  is shown as an "Incomplete" badge on the collapsed section and a sentence in the expanded one. It does not
  cover every possible loss: an entry that fails contract validation, and an entry reported after the session
  closed, are dropped without setting it.
- The feed is not a complete record even when healthy. Eviction, the bounded queue, and dropped malformed
  entries all mean absence proves nothing, which is why it is never asked to.
- A recorder failure cannot change a session's outcome, usage, checkpoint or Acceptance. The cost of that
  guarantee is that a broken recorder is silent apart from the degraded flag and a bounded log line.
- The adapters' `linesUnused`/`linesUnreadable` counters no longer fire on lines that produced activity, so a
  successful run stops reporting that its own stream was mostly unusable.
- Level 2 — the raw provider stream in file segments, behind an owner opt-in — is still an open decision, and
  this ADR does not prejudge it beyond keeping level 1 free of raw output.
