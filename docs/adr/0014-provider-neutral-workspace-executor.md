# ADR-0014: Provider-neutral bounded workspace executor

**Status:** Accepted

**Date:** 2026-09-07

## Context

ADR-0013 temporarily moved active provider work to direct APIs and kept IMPLEMENT/provider-authored QA disabled.
ADR-0015 later replaced that route with subscription-authenticated local Codex and Claude Code CLIs. Neither CLI
response is local execution authority: tool names,
arguments, call identifiers and returned prose are untrusted provider input. Passing an arbitrary command or path
from that input to the operating system would bypass the immutable AgentRun policy, owner-approved verification
recipes, workspace leases and restart rules that Loomrail owns.

The repository already has three useful authorities, but none alone is the executor boundary:

- an AgentRun policy snapshot says whether the session has `READ_ONLY` or `READ_WRITE` workspace access and whether
  network use is permitted;
- a WorkItem workspace and its lease identify the exact directory and single-writer/readers authority;
- an active Project Verification Plan records owner-approved executable, argv, cwd, environment profile, network
  policy, timeout and output limit.

Provider adapters still need to speak their native tool-call protocols. The filesystem and process policy must not
be duplicated in those adapters.

## Decision

### One deep executor boundary

`@loomrail/workspace-executor` implements one provider-neutral, session-scoped contract. Provider adapters receive
only that contract and translate native tool calls into this closed request union:

- list one directory;
- read one bounded UTF-8 file range;
- write one UTF-8 file with an expected prior SHA-256 (or explicit expected absence);
- replace one uniquely matching UTF-8 fragment in an existing file with an expected prior SHA-256;
- delete one regular file with an expected SHA-256;
- run one recipe by ID from the captured owner-approved Verification Plan.

Provider-specific command/stream payloads, call IDs and continuation messages remain inside the Codex and Claude
Code adapters. The executor never parses provider prose and never returns native provider payloads.

### Authority composition

The daemon constructs the executor only for a live ProviderSession owned by a live AgentRun and a leased workspace.
Its policy combines:

- the immutable AgentRun workspace access and network flag;
- the exact canonical WorkItem workspace;
- the active immutable Verification Plan revision captured for the session and rechecked for revocation before each
  command;
- fixed product ceilings for tool-call count, file size and provider loop depth.

The executor's policy description is also the sole source for the workspace MCP schema. `loomrail_run_recipe`
publishes the captured approved recipe IDs as an exact JSON Schema enum; labels and command details are not copied
into provider-visible prose. The executor still repeats the authoritative plan/revocation check at execution time,
so schema discovery is guidance rather than permission.

The provider-neutral invocation renderer is the sole source of the provider-visible explanation of that authority.
It distinguishes the empty native read-only scratch directory from the authoritative Loomrail workspace, tells a
read-write IMPLEMENT session to use only the closed MCP file tools, and explains compare-and-swap without copying the
workspace path, branch, proxy arguments or capability into the prompt. Before a CLI is spawned, it verifies that a
workspace grant has the `loomrail_workspace` connector plus list/read and, for `READ_WRITE`, write/delete tools. A
missing connector/required tool or a tool forbidden by the immutable access level is a typed
`ProviderInvocationAuthorityError`; there is no best-effort launch. This prose remains guidance, not authority: the
immutable invocation, advertised tool allowlist and executor checks are the enforcement layers.

`READ_ONLY` permits list/read and approved verification recipes. `READ_WRITE` additionally permits write/delete.
Only IMPLEMENT receives `READ_WRITE`; QA remains `READ_ONLY`. A plan recipe is not editable provider input: the
provider supplies only its bounded ID. A missing, disabled, changed or network-incompatible plan refuses execution.
The MCP server advertises write/delete only for `READ_WRITE`; a read-only session cannot discover a write-shaped tool
that it will inevitably be denied from using.

### Filesystem confinement

Tool paths are portable NFC relative paths using `/`, never absolute paths. Empty segments, `.`/`..`, drive or UNC
forms, controls, Windows-reserved forms and trailing dot/space are refused. Every existing path component is checked
with `lstat` and `realpath`; symbolic links and non-regular targets are refused. The canonical result must remain
below the canonical workspace root, with case-insensitive comparison on Windows.

`.git`, `.loomrail`, `.env*`, common credential/key files and credential directories are outside the tool-visible
namespace. Directory listings omit them; direct access is denied. Writes and exact-fragment edits are
compare-and-swap operations using a same-directory temporary regular file and atomic replacement. An edit requires a
non-empty old fragment that occurs exactly once; absent or ambiguous matches are typed content conflicts, never
best-effort patches. Both fragment input and final file size are bounded. No recursive delete or cleanup operation
exists.

### Commands and processes

There is no arbitrary command tool. The executor resolves the selected recipe through the existing Q17 runner:
shell-free argv, canonical cwd, isolated home/cache/temp, scrubbed environment, bounded output, deadline,
cancellation, process-tree termination, recipe provenance recheck and stable-tree verification. A
`DENIED_UNAVAILABLE` network recipe remains unavailable; the executor does not pretend to provide an OS network
sandbox. Git mutation, commit, push, merge, deploy and installer authority are not added.

### Audit, idempotency and recovery

Before each side effect, SQLite atomically reserves a `WorkspaceToolCall` and appends
`WORKSPACE_TOOL_CALL_CHANGED`. The durable record stores only scope IDs, a hashed provider call key, operation,
bounded safe target, policy/input digests, state and typed outcome metadata; it never stores file contents, command
output, credentials or a raw provider payload. Terminal completion updates the record and appends a second event in
one transaction.

The pair `(ProviderSession, hashed provider call key)` is idempotent. Reuse with different input is refused. A
terminal duplicate is not executed again; because raw output is deliberately not durable, the provider receives a
typed `REPLAYED_WITHOUT_OUTPUT` result and must inspect current state with a new call.

A command process uses the existing durable supervisor proof. On startup Loomrail first proves or kills that process
tree, then marks every still-started call `UNKNOWN_OUTCOME` and ends the interrupted ProviderSession/AgentRun through
normal reconciliation. File calls are also `UNKNOWN_OUTCOME`: Loomrail never guesses whether an atomic rename crossed
the crash boundary and never automatically replays it.

### Provider loops and QA

Both local adapters apply finite turn/call guards. Usage is accumulated across the ProviderSession and reconciled to
the immutable AgentRun ledger after the CLI exits. Because the CLIs do not expose an exact preventive token stop,
they declare `POST_SESSION`; hard bounds remain on elapsed time, turn count, tool count and output sizes. No tool is
executed after the durable ledger has exhausted the allowance.

Measured Browser QA remains daemon-owned. On a passing BrowserDriver run, its exact QARun/evidence is recorded first
while the QA StageAttempt remains running; the provider then receives read-only workspace tools and measured evidence
to prepare the required `QA_REPORT`. Domain completion binds that report back to the exact passing measured bundle.
A failed or errored BrowserDriver run follows the existing correction/HumanRequest flow without asking a provider to
reinterpret it.

If provider usage exhausts the budget after that passing measurement but before QA synthesis finishes, Resume does
not repeat BrowserDriver. The runner reuses evidence only when status, tested tree, target/plan (for a full run),
QA correction/retest plan and nested verification-correction lineage all match exactly. Missing or mismatched
evidence fails closed with a typed state-store error; a completed correction is never reopened or silently re-run.

### Completion evidence

A schema-valid provider result is still only a claim. A live IMPLEMENT StageAttempt may complete only when its
durable tool-call audit contains at least one successful `WRITE_FILE`, `EDIT_FILE` or `DELETE_FILE` for the same Project,
WorkItem and StageAttempt. The proof survives provider-session handoff and a resolved HumanRequest because those are
continuations of the same domain-owned attempt; another WorkItem, attempt or correction cycle never counts. Reads,
recipes and denied/failed/unfinished calls do not satisfy the gate. The domain rejects an unsupported claim with
typed `IMPLEMENT_EFFECT_NOT_OBSERVED`; persistence ends the session as interrupted and hard-pauses the attempt
through the existing `PROVIDER_OUTCOME_REJECTED` path. Historical append-only commands that predate live
ProviderSession completion remain readable.

## Consequences

- IMPLEMENT can make real bounded file changes and run only pre-approved recipes through either local provider.
- Large but bounded text files do not need to be echoed wholesale: exact unique-fragment CAS editing keeps the model
  payload small while preserving the same path, symlink, audit, idempotency and atomic-replacement boundary.
- Provider prose alone cannot make IMPLEMENT pass; an audited mutation in the same domain StageAttempt is required.
- QA can inspect the real workspace and summarize already-measured evidence, but cannot write or replace Browser QA.
- A budget/restart retry can continue QA synthesis from exact durable passing evidence without duplicating browser
  side effects or weakening lineage checks.
- Projects without a suitable approved recipe can still edit files in IMPLEMENT, but command execution is visibly
  unavailable and may produce a blocking HumanRequest instead of a fallback command.
- Same-OS-account processes are not a complete sandbox. The intentionally narrow recipe allowlist, scrubbed
  environment, workspace lease, symlink checks and process supervision reduce authority; stronger filesystem/network
  isolation remains a separate future decision.
- Live subscription-backed claims still require explicit owner approval and cross-platform evidence. CLI/process and
  executor doubles remain test-only.
