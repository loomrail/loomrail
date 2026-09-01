# Loomrail threat model

**Status:** Phase 0 baseline
**Updated:** 2026-09-01
**Review cadence:** every Phase and before public release

## 1. Scope

Phase 0 includes a local loopback daemon, browser UI, SQLite state, local artifacts and a deterministic mock provider.
Later surfaces are listed so current contracts do not make them impossible to secure, but their detailed controls
require Phase-specific threat deltas.

The sentence "it does not execute shell/Git/provider/browser actions" stood here through Phase 0 and is **no longer
true of two of the four**. A2 made Loomrail spawn real provider CLIs as child processes of the daemon, and E1 made it
run `git` and hand one of those CLIs a writable worktree for every stage it serves but the owner's own
acceptance decision. Both are covered by their deltas in §6 rather than by this
paragraph. Browser actions are still not executed. New Projects default to `AUTO`: the daemon may select an installed,
authenticated live CLI, while an owner can choose Mock explicitly for a zero-quota run. The provider-selection controls
and probe boundaries are specified in T26.

## 2. Security objectives

1. Only the local user who launched Loomrail can issue commands.
2. A website cannot use localhost access to control Loomrail.
3. A WorkItem, artifact or imported instruction is untrusted content, not executable authority.
4. State transitions, approvals and overrides are attributable and cannot be silently rewritten.
5. Secrets never enter prompts, SQLite, logs or Git by default.
6. Restart/retry cannot duplicate a risky action.
7. A provider, plugin or agent cannot expand its own permissions.
8. Public repository history contains no private data.

## 3. Assets

| Asset                        | Impact if compromised                              |
| ---------------------------- | -------------------------------------------------- |
| Local repository/code        | source disclosure or destructive modification      |
| Provider credentials/session | unauthorized model usage and data exposure         |
| Project environment secrets  | third-party/service compromise                     |
| SQLite state and decisions   | workflow tampering, false acceptance, privacy loss |
| Human approvals              | privilege escalation and unsafe actions            |
| Logs/transcripts/artifacts   | code, paths, prompts or secrets disclosure         |
| Budget policy/usage          | uncontrolled cost and denial of service            |
| Browser profile/session      | authenticated website actions                      |
| Git history/releases         | supply-chain compromise                            |

## 4. Actors

- legitimate local owner;
- authorized contributor/maintainer;
- untrusted website opened in the user's browser;
- untrusted repository content or dependency;
- compromised/malicious provider output;
- malicious/buggy plugin or imported agent profile;
- another unprivileged local process;
- attacker with control of the user's OS account — mostly outside the MVP boundary.

## 5. Trust boundaries

```mermaid
flowchart LR
    WEB[Untrusted websites] --> BROWSER[Browser]
    BROWSER -->|Origin + session + CSRF| DAEMON[Loopback daemon]
    DAEMON --> DB[(Local state)]
    DAEMON --> ART[Artifacts/logs]
    REPO[Untrusted repository content] -. later .-> DAEMON
    DAEMON -. capability contract .-> PROVIDER[Provider CLI]
    DAEMON -. scoped runner .-> TOOL[Shell/Git/browser]
    OS[OS credential store] -. scoped secret .-> TOOL
```

Browser-to-daemon is a real trust boundary even though both run locally. Repository text and provider responses are
data. A Git worktree is collision isolation, not a security sandbox.

## 6. Phase 0 threats and controls

| ID  | Threat                                                                     | Risk     | Required controls                                                                                                                                                                            | Verification / gate                                         |
| --- | -------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| T01 | Host binds to LAN/all interfaces                                           | Critical | explicit loopback bind and startup assertion                                                                                                                                                 | M1/M2 integration asserts the listener address              |
| T02 | Malicious site sends localhost commands                                    | Critical | one-time bootstrap, HttpOnly SameSite session, exact Origin, CSRF header, no wildcard CORS                                                                                                   | M1/M2 foreign-Origin, session and CSRF integration tests    |
| T03 | Unauthorized or persistent access to the event stream                      | High     | `requireSession` on the SSE route, same as every other GET; `Origin` compared when sent, `SameSite=Strict` otherwise; heartbeat closes the stream on session expiry; open-stream limit       | see A1.5 event-channel delta below                          |
| T04 | Bootstrap token leaks in URL/log/referrer                                  | High     | URL fragment, one-minute TTL, hash storage, atomic consume, log redaction                                                                                                                    | M1/M2 replay, request-URL, fragment, referrer and log tests |
| T05 | Stored XSS through WorkItem/artifact                                       | High     | output escaping, no raw HTML Markdown, CSP, size limits                                                                                                                                      | M3 persisted-text browser test and CSP                      |
| T06 | Path traversal in fixture project                                          | High     | canonical path containment and no symlink escape                                                                                                                                             | M2 HTTP traversal plus directory/manifest symlink tests     |
| T07 | Duplicate command/dispatch                                                 | High     | command ID idempotency, transaction + unique constraints                                                                                                                                     | M2 concurrent retry and command-reuse tests                 |
| T08 | False Done/approval tampering                                              | High     | state-machine gate, append-only Event/Decision/evidence, optimistic version                                                                                                                  | M2 transition tests; M6 Scenario D and acceptance replay    |
| T09 | SQLite corruption/migration failure                                        | High     | WAL, short transactions, backup before migration, fail closed                                                                                                                                | M2 backup/checksum/reopen tests; full restore drill in M7   |
| T10 | Sensitive values in logs/errors                                            | High     | structured allowlisted fields and pre-persistence redaction                                                                                                                                  | M2 bootstrap/session canary redaction test                  |
| T11 | Event/resource exhaustion                                                  | Medium   | payload limits, pagination, queue bounds, open-stream cap; event-stream frames are three opaque identifiers and are not queued per subscriber (no slow-consumer policy — see the A1.5 delta) | M2 body/query bounds; A1.5 open-stream limit tests          |
| T12 | Dependency/supply-chain compromise                                         | High     | lockfile, trusted registry, minimum release age, audit, reviewed updates                                                                                                                     | pinned CI install, production audit and reviewed updates    |
| T13 | Private data committed publicly                                            | High     | `.gitignore`, pre-public scan, review checklist, synthetic fixtures                                                                                                                          | automated public-tree scan; full history scan in M7         |
| T14 | Theme/UI hides critical state                                              | Medium   | text/icon semantics, contrast, no color-only gates                                                                                                                                           | M1–M3 light/dark, keyboard and state browser checks         |
| T15 | Checkpoint steers the next provider session across a swap                  | High     | schema-validated checkpoint, explicit untrusted-data delimiters in the pack, full text visible to owner (see A1 delta below)                                                                 | see A1 delta below                                          |
| T16 | Live adapter spawns an owner-privileged child process                      | High     | argv array to `child_process.spawn`, no shell interpolation; never enable a provider's permission-bypass flag automatically (SD-001)                                                         | see A2 delta below                                          |
| T17 | Child process orphaned by a dead daemon outlives it                        | Medium   | pid recorded on the `ProviderSession`; startup reconciliation kills it before the session is marked ended                                                                                    | see A2 delta below                                          |
| T18 | Untrusted provider stream carries the owner's own hook output              | High     | only typed fields cross the adapter boundary; no raw wire line is retained anywhere a caller can observe                                                                                     | see A2 delta below                                          |
| T21 | Client path expands a diff read or exhausts the daemon                     | Medium   | authenticated route; canonical worktree boundary; literal Git pathspec plus exact name match; file-count and byte limits; summary debounce                                                   | see E1.5 change-visibility delta below                      |
| T22 | Live provider bypasses typed evidence or owner acceptance                  | High     | stage-specific strict result schema; daemon-owned provider attribution; Review/QA typed artifacts; domain rejects ordinary Acceptance completion                                             | see D2 live-route delta below                               |
| T23 | Public landing leaks private data or executes third-party code             | High     | static build from reviewed assets; no forms, analytics or external runtime resources; self-only CSP; pinned Pages actions; build and deploy permissions separated                            | landing public-contract test, public-tree scan and Pages CI |
| T24 | Repository onboarding leaks data or overwrites owner policy                | High     | bounded allowlist scan; no source/env/lock contents; no command execution; untrusted provenance; explicit owner adoption; compare-and-set digest; atomic publication; durable recovery       | see B5+B1 Constitution delta below                          |
| T33 | Plugin manifest is mistaken for a sandbox or gains workflow authority      | High     | separate process; closed read-only SDK; no domain hooks; ordinary C1 Consent/probe/Grant; manifest claims are labelled unverified                                                            | see C2 Plugin SDK delta below                               |
| T34 | New-project scaffold overwrites a path or executes a template payload      | Critical | built-in immutable recipes only; nonexistent target; exclusive directory claim; create-new writes; no package install/hooks/commit/push; durable marker-bound recovery                       | see B4 scaffolding delta below                              |
| T35 | Global Attention read leaks cross-Project text or weakens acceptance       | High     | authenticated bounded projection; closed schemas; referential validation; React text rendering; acceptance only deep-links to its exact owner gate                                           | see A4 Attention delta below                                |
| T36 | Parallel scheduling oversubscribes capacity or crosses workspace authority | High     | bounded deterministic plan; transactional AgentRun/limit/lease claim; stable checkpoint; exact profile/provider snapshot; no automatic interrupted-run retry                                 | see A3 scheduling delta below                               |

`M7` entries identify future capabilities. The persisted M6 Workbench and owner acceptance gate are present; the
event-delivery channel landed with A1.5 as SSE, not WebSocket (ADR-0003), and T03 is closed by the tests cited in
the delta below.

### A3 parallel scheduling delta (T36)

A3 allows several provider processes to run at once. A read-then-spawn implementation could exceed the owner's
global, Project or provider limits under concurrent wakeups; two runs could also observe a free workspace and both
start before either lease is visible. A role or provider setting changed between selection and spawn could give a
run different authority from the one the scheduler evaluated. Rated **High**: the failure can multiply spend and
put a write-enabled, network-enabled agent in a workspace whose exclusive claim belongs to another run.

Required mitigations and verification:

- scheduler input is bounded to 200 candidates and 200 active runs; default global concurrency is 3 and every
  configured global/project/provider limit uses a closed non-negative bound;
- pure `planDispatchBatch` owns stable priority/order, capacity accounting, checkpoint compatibility and
  machine-readable deferral reasons. Its first implementation is covered by focused deterministic tests; it remains
  advisory and never starts a process;
- `START_AGENT_RUN` repeats global/project/provider, active-attempt and active-WorkItem checks in one SQLite
  transaction, creates the durable AgentRun and captures exact AgentProfile revision/effective provider
  before spawn. It claims an existing workspace in that transaction. When the first worktree does not exist yet,
  the exclusive active-WorkItem claim closes the provisioning race; daemon records the new workspace already leased
  before provider spawn. No daemon-memory semaphore may be the only authority;
- AgentRun records the hash of its immutable policy snapshot; each ProviderSession separately retains the exact
  ContextPackRecipe content hash, so a handoff cannot make a run-level hash falsely attest to changing provider input;
- multiple read-only claims may share a workspace only when they name the same immutable checkpoint. Any writer
  conflicts with every same-workspace claim; the existing E1 storage lease remains a backstop;
- provider handoff stays inside one AgentRun and one capacity slot. Shutdown aborts every live ProviderSession;
  startup reconciliation marks orphan sessions/runs interrupted before scheduling and never retries them
  automatically;
- role-playbook and permission composition is intersection-only: a lower layer cannot remove required context or
  add a capability denied above it. Browser input cannot submit provider argv, workspace paths or slot claims;
- required gates before enabling the pool: concurrent claim race, 3+1 capacity, per-Project/provider isolation,
  writer/read conflict, same-checkpoint readers, handoff, blocking HumanRequest isolation, shutdown and restart on
  macOS and Windows.

The scheduler kernel alone does not create a parallel execution surface. Transactional AgentRun reservation,
terminal release, restart recovery, the bounded daemon pool and all-live-session shutdown are implemented and
covered together. The authenticated Fleet projection is bounded, reconstructs its running and waiting rows from
durable state, and exposes closed wait reasons rather than raw provider output. A3 still must not be presented as a
published release until the cross-platform release gate passes.

### A4 Attention Inbox delta (T35)

A4 adds one global owner read, `GET /api/v1/attention`. Unlike the earlier Project-filtered HumanRequest list, it
returns open request text and related Project/WorkItem metadata from every local Project in the authenticated
workspace. A stale or compromised browser session could therefore enumerate more local metadata in one request; a
careless Inbox action could also turn the final acceptance HumanRequest into an ordinary answer and bypass the
evidence gate. Rated **High** because the second failure would falsify owner acceptance, even though the read remains
same-owner and loopback-only.

Mitigations and verification:

- the route uses the same HttpOnly SameSite session as all local reads, accepts no Project/path filter, and exposes no
  mutation; the existing answer route retains exact Origin and CSRF checks. Daemon integration verifies
  unauthenticated access returns 401;
- SQLite reads at most 201 open rows, the public response returns at most 200 and reports `hasMore`; contract and
  domain tests reject an oversized caller rather than permitting an unbounded in-memory projection;
- one deterministic domain interface validates that HumanRequest, Project, WorkItem and current StageAttempt ids
  agree before it classifies or orders anything. Missing/inconsistent relations fail closed, and request prose never
  selects category or action;
- both daemon output and browser input are parsed with closed runtime schemas. Project names, task titles and request
  text render as React text nodes; the persisted-text browser XSS test remains applicable;
- an AcceptancePackage produces only `REVIEW_ACCEPTANCE`. The Inbox never calls the generic answer endpoint for it;
  it deep-links the exact Project and WorkItem to Task Cockpit, where optimistic-versioned `Accept`, `Return to work`
  and `Reject` remain the only authority. Persistence/daemon tests cover the projection across restart and after
  resolution; browser E2E compares the link ids to the authenticated projection itself;
- browser coverage exercises two Projects, keyboard selection, reload, RU/EN, light/dark themes and
  1280/768/375/320 px viewports.

Residual risk is unchanged from the local session boundary: any party controlling the owner-authenticated browser or
OS account can read local project metadata already available elsewhere. A4 adds aggregation, not a new remote or
cross-account channel. HumanRequest remains forbidden for secrets.

### A1 session-handoff delta (T15)

A `StageAttempt` now runs as a sequence of provider sessions, each reassembled from durable state, and a session
ends by publishing a checkpoint that becomes part of the _next_ session's context (spec
`docs/plans/07-a1-session-handoff-spec.ru.md` §6, §8). A checkpoint is provider output, i.e. untrusted input under
AGENTS.md; what A1 adds is a durable, reliable delivery channel for that untrusted text into a following session's
context, one that survives a change of provider adapter. A compromised or derailed agent can therefore write text
into a checkpoint aimed at steering the session that picks up its work, and Loomrail itself delivers it across
that trust boundary. Rated **High**: the channel is durable, crosses a boundary, and is invisible to the owner
unless the checkpoint is actually shown.

Mitigations, verified in code:

- the checkpoint is structured and schema-validated (`checkpointDraftSchema`, enforced in
  `apps/daemon/src/session-loop.ts`) rather than accepted as a free-form blob; an invalid checkpoint is rejected
  rather than half-accepted, since the next pack is built on it;
- it is rendered into the pack wrapped in explicit `BEGIN/END UNTRUSTED AGENT REPORT` delimiters and framed as
  data describing past work, never as instructions (`packages/context-assembly/src/render.ts`, the `untrusted`
  helper), verified by `packages/context-assembly/test/render.unit.test.ts`
  ("marks a checkpoint as untrusted provider output");
- the full checkpoint text — summary, completed, remaining, dead ends, open questions — is visible to the owner in
  the Task Cockpit, not summarized or truncated (`packages/ui/src/patterns.tsx`'s checkpoint disclosure,
  wired from real session data in `apps/web/src/views/WorkbenchPage.tsx`), verified by the `e2e/walking-skeleton.spec.ts`
  test "shows the sessions inside a running stage attempt, with occupancy, handoff, and full checkpoint text";
- the channel surviving a provider swap specifically — session 1 on one adapter, session 2 on a genuinely
  different one, the checkpoint still carried into the second session's pack — is verified by
  `apps/daemon/test/session.integration.test.ts` ("continues after the adapter is swapped between sessions"),
  which drives two separate `runStageAttempt` calls (mirroring the daemon-restart boundary that is the only way a
  swap can happen, since one daemon process runs one provider adapter for its whole lifetime) rather than a
  single call routed by a test-only wrapper, so a defect in which session's declared context window drives the
  next pack's budget has somewhere real to surface.

**Known limitation.** The untrusted-block framing in `render.ts` is plain string concatenation with no escaping of
the delimiter tokens themselves. A provider could emit the literal text `END UNTRUSTED AGENT REPORT` inside its
own checkpoint fields, followed by fabricated content shaped like instructions, attempting a delimiter-collision
escape out of the untrusted block. This is a known property of textual delimiter framing in general and is not
eliminated here; the owner-visible full-text mitigation above is the backstop for it, not a substitute.

### A1.5 event-channel delta (T03)

A1.5 (`docs/plans/09-background-execution-and-event-stream-spec.ru.md`) adds exactly one new authenticated
surface: `GET /api/v1/stream`, an SSE connection that stays open (`apps/daemon/src/server.ts`). Its five
mitigations, verified in code:

- no session, no stream: `requireSession` gates the route exactly like every other GET, verified by
  `apps/daemon/test/event-stream.integration.test.ts`'s "refuses a stream to a caller without a session";
- a foreign page cannot open it: `SameSite=Strict` on the session cookie is the real defense, since a
  same-origin `EventSource` request carries no `Origin` header at all; `Origin` is compared when it is sent,
  verified by "refuses a stream when an Origin is sent and does not match";
- a held stream cannot outlive its session: a 15-second heartbeat (`HEARTBEAT_INTERVAL_MS`,
  `apps/daemon/src/event-stream.ts`) rechecks the session on every tick and drops the stream once it has
  expired. Three links, verified as one chain by
  `apps/daemon/test/event-stream.integration.test.ts`'s "closes a real stream once its session has
  expired" — a stream opened over real HTTP, the daemon's injected clock pushed past `SESSION_TTL_MS`,
  and the response read to its end — with "closes an open stream once its session has expired"
  covering the registry's `tick()` in isolation;
- a local process cannot exhaust file descriptors through it: open streams are capped at `MAX_OPEN_STREAMS`
  (8), enforced in one place — the registry's `open()`, which the route calls before hijacking the response
  and reports as a 503 when it refuses — verified by "refuses to open more streams than the limit and leaves
  the open ones alone" and "answers a stream request over the limit with a status rather than an opened
  stream";
- the channel carries no content: `eventSignalSchema` (`packages/contracts/src/event-stream.ts`) is a
  `.strict()` object of exactly three opaque identifiers — `projectId`, `aggregateType`, `aggregateId` — so a
  field cannot be added to the frame by accident, verified at the byte level by "carries no work item text on
  the wire" and at the schema level by `packages/contracts/test/event-stream.unit.test.ts`'s "rejects any
  field beyond the three, so content cannot be added by accident".

What the shipped channel does **not** do is manage a slow consumer, and T11's earlier "WS slow-consumer policy"
described a design that was never built. `response.write()` returns `false` when the socket's buffer is full and
`apps/daemon/src/event-stream.ts` ignores that return value, so a subscriber that stops reading accumulates frames
in its own socket buffer until the socket errors — at which point the write throws, the subscriber is dropped and
the daemon carries on (the `try/catch` around `write`). Two properties bound the exposure instead of a policy: a
frame is three opaque identifiers, so it is tens of bytes rather than a payload; and at most `MAX_OPEN_STREAMS`
(8) subscribers can exist at once, all of them same-origin pages belonging to the local owner. A real policy — a
per-subscriber queue bound with drop-and-resync on overflow — becomes worth building when the channel gains a
consumer that is not the owner's own browser, and is not claimed here before then.

Publication does not add a new way for state and channel to diverge: `apps/daemon/test/broadcasting-state.integration.test.ts`
verifies that a rolled-back command publishes nothing ("publishes nothing when the command was rolled back")
and that a publish failure still leaves the command applied ("keeps the command applied when publication
throws"), so ADR-0002's "publication failure does not roll back state" holds for the shipped channel.

**Does not expand T15.** The channel does not widen the untrusted-checkpoint threat above: not because the
code is careful with text, but because there is no text in the frame at all, by schema. The mitigation and the
test are the same one cited for content leakage above — "carries no work item text on the wire".

### A2 live-provider-adapters delta (T16, T17, T18)

A2 (`docs/plans/11-a2-live-provider-adapters-spec.ru.md`) replaces the synthetic mock provider with two live
adapters, `packages/provider-codex` and `packages/provider-claude-code`, that spawn the real `codex` and
`claude` CLIs as child processes of the daemon, running as the same OS user who launched Loomrail. This is the
first place in the tree where Loomrail does anything beyond read SQLite and the filesystem it already owns.

**T16 — a live adapter spawns an owner-privileged child process.** Rated High: a child that inherits the
owner's full permissions is exactly the actor SD-001 exists to keep out of "no approval needed" territory.
Mitigations, verified in code:

- every invocation is built as an argv array passed directly to `child_process.spawn`
  (`packages/provider-core/src/process-runner.ts`'s `runProcess`), never through a shell, so appending
  contextPack text or any other value to the command line has no interpolation hazard;
- neither adapter ever builds a command carrying a permission-bypass flag. A named, closed list is checked
  against the argv array (never a joined command line, which would also match the prompt) by one test per
  adapter, so a future CLI version adding another spelling is a decision made to that list, not a silent gap: `packages/provider-codex/test/adapter.unit.test.ts`'s "never builds a command carrying a
  permission-bypass flag (SD-001)" and `packages/provider-claude-code/test/adapter.unit.test.ts`'s test of the
  same name. **The list is not — and cannot be — every route out of the sandbox.** It covers flags whose _name_
  carries a danger warning, plus the specific non-danger-named flags below that are known to widen what the
  child can reach. It does not cover value-shaped relaxations, where a legitimate flag takes a dangerous value;
  those are guarded separately, by asserting the value each adapter actually sends (`-s read-only` for Codex,
  `--permission-mode plan` for Claude Code) rather than by enumerating spellings a substring check could never
  usefully match. The list, as the tests enforce it — no count is stated here, because a count in prose is precisely what drifted from the list in code last time:

  | flag                                         | CLI    | why it is on the list                                                                       |
  | -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
  | `--dangerously-skip-permissions`             | Claude | danger-named permission bypass                                                              |
  | `--allow-dangerously-skip-permissions`       | Claude | danger-named permission bypass                                                              |
  | `--dangerously-bypass-approvals-and-sandbox` | Codex  | danger-named approvals/sandbox bypass                                                       |
  | `--dangerously-bypass-hook-trust`            | Codex  | danger-named hook-trust bypass                                                              |
  | `--permission-mode bypassPermissions`        | Claude | the bypass expressed as a value                                                             |
  | `--add-dir`                                  | both   | grants tool access outside the empty temporary directory — the one that actually defeats D1 |
  | `-c` / `--config`                            | Codex  | arbitrary config override; `codex exec --help` documents `-c 'sandbox_permissions=[…]'`     |
  | `--settings`                                 | Claude | arbitrary settings file or inline JSON                                                      |
  | `--tools`                                    | Claude | widens the tool set the child may use                                                       |

  **E1 amends the `-c` / `--config` row.** In `packages/provider-codex` the Codex adapter now sends exactly one
  `-c` key of its own, so a ban on the spelling would ban the launch this milestone exists for. `-c` left the
  spelling list there and became a closed list of permitted _values_ instead; `--config` stayed on the spelling
  list. In `packages/provider-claude-code` both spellings remain banned outright, because that adapter sends no
  config override at all. See T19 below for the exception and the guard that replaced the ban.

- **C1 replaces the blanket MCP ban with a closed session-scoped exception.** Codex still sends
  `--ignore-user-config` and may add only schema-validated `mcp_servers.loomrail_*.(command|args|enabled_tools)`
  assignments for the Loomrail proxy. Claude always sends a generated `--mcp-config` together with
  `--strict-mcp-config`; an empty connector set produces an explicit empty config. Adapter tests assert both the
  empty and connected shapes and that the real server launch recipe never reaches provider argv/config;
- before E1 there is nothing on disk for a bypassed permission to reach anyway: both adapters run their CLI in
  a fresh, empty temporary directory (spec §6/§7, D1), bounding the blast radius independently of the flag
  check above. **E1 ends this for Codex** — it runs in a real Git worktree with write access, for every stage
  it serves but ACCEPTANCE, which is what moves the flag list from a defence in depth to the defence. See T19.
  It does **not** end for Claude Code: that adapter serves no stage requiring a workspace, is given none, and
  still runs `--permission-mode plan` in an empty temporary directory.

**T17 — a process orphaned by a dead daemon outlives it.** Rated Medium: bounded to the one process a single
`start()` call spawned, and self-healing at the next daemon start, but real while it lasts — an unwatched
child keeps running, and for Claude Code keeps spending against `--max-budget-usd`, with no daemon left to end
its session. Mitigation, verified in code:

- the child's pid is recorded on its `ProviderSession` (`packages/persistence-sqlite/migrations/0010_provider_session_pid.sql`,
  `apps/daemon/src/session-loop.ts`), and startup reconciliation
  (`RECONCILE_WORKFLOWS`, `packages/persistence-sqlite/src/index.ts`'s `killOrphanedSessionProcess`) sends it
  `SIGKILL` before the session is marked `ENDED` — kill first, mark second, so a crash between the two steps
  can never commit a session that reads as over while its process is still running. Verified against a real
  detached child process, not a mock, by
  `packages/persistence-sqlite/test/local-state.integration.test.ts`'s "kills a process orphaned by a daemon
  restart before ending its session", and the ordering itself by that file's "still has the session marked
  RUNNING at the moment it kills the process", which reads the row through the store's own connection from
  inside the kill and therefore fails if the two statements are swapped;
- **the kill is guarded on process identity, and fails safe.** SIGKILL is only sent when the process started no
  later than the session that recorded its pid (plus a two-second tolerance). The only way an orphan exists is
  a crash or a power-off, which usually means a reboot — and after a reboot pid allocation restarts and walks
  back up through the recorded range, so a reused pid is a live risk, bounded to the same OS user (`process.kill(pid, 0)`
  throws `EPERM` for another user's process, and the liveness check already reads that as "not alive"). Start
  time is read with a synchronous `ps -o etime=` probe; when it cannot be determined for any reason — `ps`
  absent, non-zero exit, unparseable output, or Windows, where the probe does not run at all — **the kill is
  skipped**. An orphan that survives is self-healing at the next daemon start; a `SIGKILL` to the owner's
  editor or build is not. Both directions are pinned by
  `packages/persistence-sqlite/test/local-state.integration.test.ts`'s "leaves a reused pid alone…" and
  "leaves the orphan alone, and says so, when it cannot tell when the process started";
- **every decision is recorded**, kill or skip, with the pid and the session id, through an `onOrphanProcess`
  callback that `apps/daemon` routes into its structured logger. A `SIGKILL` on the owner's machine that
  nothing anywhere wrote down was itself the finding this closes; a skipped kill is logged just as loudly,
  because "an orphan is still running and Loomrail chose not to signal it" is a fact the owner has to be able
  to find.

**T18 — the untrusted provider stream carries the owner's own hook output.** Rated High: reconnaissance found
Claude Code's event stream carries `hook_started`/`hook_response` events with the owner's own hook `stdout`
and `stderr` inside them (spec §2, D7) — arbitrary text from the owner's machine that Loomrail would otherwise
write straight into its own diagnostics. Codex's stream carries no hook channel, so the same underlying
discipline — never retain a raw wire line anywhere a caller can observe — is what both adapters are held to.
Mitigation, verified in code:

- `parseCodexEvent`/`parseClaudeEvent` extract only the few typed fields each adapter forwards (usage,
  context-window occupancy, the structured checkpoint); everything else, hook events included, is dropped
  inside the stream parser before it can reach a listener or the outcome. For Claude Code this is checked
  against a recording that carries real `hook_started`/`hook_response`/`hook_progress` events with a real,
  distinguishing `hook_id` UUID absent from every parsed shape, across every observable surface (the outcome
  and every listener callback), not the outcome alone:
  `packages/provider-claude-code/test/adapter.unit.test.ts`'s "keeps no raw provider output after the session
  ends". For Codex, which has no hook channel to record, the same test name and technique instead pins a real
  `thread_id` UUID from the recording — the closest analogue available to it — in
  `packages/provider-codex/test/adapter.unit.test.ts`.

**Known gap, not yet mitigated.** Reported spend (`ProviderUsage`, `onUsage`) is validated but has nowhere
durable to go: `usage_records` (`packages/persistence-sqlite/migrations/0003_budget_pause_recovery.sql`) is
constrained in SQL to a single estimated-tokens kind and one `amount` column, so a live adapter's real,
per-turn spend is logged (`apps/daemon/src/session-loop.ts`'s `onUsage` listener) rather than accumulated
against a budget threshold. This is a budget-enforcement gap (BD-001), not a new confidentiality or integrity
threat — spend already visible to the owner in the CLI's own output is merely not yet durable inside
Loomrail — and is tracked as follow-up work, not part of A2 (spec §3 D4).

### E1 workspace-execution delta (T19, T20, and two registration decisions)

E1 (`docs/plans/13-e1-workspace-execution-spec.ru.md`) is where a Project stops being one of two bundled
fixtures and becomes any local Git repository the owner names by path, and where the stages an agent runs
run in a Git worktree cut from it. The A2 bound that made the flag list a defence in depth — "there is
nothing on disk for a bypassed permission to reach anyway" — ends here for the Codex adapter: it now declares
all six stages and runs `codex exec -s workspace-write` in a real worktree.

**How many stages that is was corrected after the milestone shipped, and it widened.** The list was IMPLEMENT
and QA, on the reasoning that every other stage "only ever produces prose" — until a live Codex run reported
that its REVIEW could find no repository and no implementation to assess, on a work item whose IMPLEMENT stage
had just edited a file in the worktree. Producing prose is not needing no input: a review reads the change it
is judging, and a discovery or a plan on a real codebase is worth having only when it can read that codebase.
`stagesRunningInWorkspace` (`packages/domain/src/workspace.ts`) is now DISCOVERY, PLAN, IMPLEMENT, REVIEW and
QA — every stage dispatched to an agent except ACCEPTANCE, which is the owner's decision rather than a reading
of the tree. **The worktree therefore exists for five stages of a run, not two**: it is cut, carrying the owner's
uncommitted work, at a work item's FIRST agent stage rather than at IMPLEMENT.

**Write access did not widen with it, and that was a second correction.** Which stages are GIVEN the worktree
and which may WRITE in it are separate questions with separate answers — `stageRunsInWorkspace` and
`stageWritesInWorkspace` (`packages/domain/src/workspace.ts`) — and only IMPLEMENT and QA answer yes to the
second. A DISCOVERY, PLAN or REVIEW session is launched in the same worktree under `-s read-only` and with no
`-c` key at all; the answer travels to the adapter as `ProviderWorkspace.access`
(`packages/provider-core/src/index.ts`), so no adapter carries a list of stages of its own. For as long as the
Codex adapter picked its sandbox mode from the mere PRESENCE of a worktree, those three read-only stages ran
write-enabled and network-enabled — a review able to rewrite the code it was judging. Nothing else about the
containment changed — same worktree, same branch, same `-c` key where it is still sent, same flag guards.

**`-s read-only` was measured, not assumed.** A real `codex exec` run under that mode in a real linked
worktree read the repository freely — `git status --porcelain`, `git log --oneline -1` and `git diff HEAD
--stat` each exited 0 — and was refused both writes it attempted: appending to a tracked file
(`operation not permitted`) and `git commit --allow-empty` (`fatal: Unable to create
'<repo>/.git/worktrees/<name>/index.lock': Operation not permitted`). The second refusal is the load-bearing
one: a linked worktree's `index.lock` lives in the owner's `.git`, OUTSIDE the directory passed to `-C`, so
the sandbox bounds the gitdir as well as the working tree. The worktree was clean afterwards and its history
unchanged. See spec §2.15 for the capture.

Two bounds on that widening, both enforced in `apps/daemon/src/session-loop.ts`. A Project with no repository
behind it — a fixture Project still recorded at a bundled template, a path the owner moved — still dispatches
its prose stages with no workspace, exactly as it did before E1, rather than being refused (only IMPLEMENT and
QA are refused for the lack of one — `stagesRequiringWorkspace`). A Project that HAS a repository which could
not be used this minute is not that case and is not degraded silently: mid-rebase, an occupied branch, a
worktree that vanished, a `git` that would not run all reach the owner as the same blocking question IMPLEMENT
would have got, because a prose stage run blind there answers "there is no implementation to assess" about
work sitting in the repository the Project names. The two are told apart by `ProvisionRefusalCause`
(`packages/domain/src/workspace.ts`), not by reading the refusal's prose. And no worktree is cut
for an adapter that declares no stage requiring one (`adapterWorksInWorkspace`): `provider-claude-code` always
runs its CLI in a fresh temporary directory and reads `ProviderInvocation.workspace` nowhere, so nothing is
written into the owner's repository on its behalf. **The read-only-in-an-empty-directory bound of §6 therefore
still holds for that adapter in full**, and the sentence below about "both adapters" is unchanged by this
correction.

**T19 — a write-enabled, network-enabled agent runs in a tree carrying the owner's uncommitted work.** Rated
High, and accepted by the owner in that knowledge (spec D3 and D8). Since the stage-list correction above, the
carried-in content is present for five of a run's six stages rather than two, while the write access and the
network key of this threat's own title remain IMPLEMENT's and QA's alone. The rating is unchanged: the tree,
and every secret the carry-in put in it, is the same for all five, and a read-only session can read every byte
of it. The three parts of it, each verified in
code:

- **everything uncommitted is carried in, without asking.** `createCarryInSnapshot`
  (`packages/workspace/src/snapshot.ts`) builds the worktree's starting commit from a temporary index —
  `read-tree HEAD`, then `git add -A` — so edits to tracked files, whatever is already staged, deletions, and
  **untracked files that the repository does not ignore** all arrive in the worktree. `.gitignore` is the only
  boundary, and it is the repository's own, not Loomrail's: an unignored `.env.local`, a scratch key, a
  downloaded dump next to the source all travel. No prompt stands in front of this, by owner decision (D3);
- **the agent has network access in that same tree.** `workspace-write` denies network by default, and the
  adapter re-opens it with one config key (T20 below) because a stage that cannot fetch cannot install a
  dependency or run a suite that does. So a secret carried in by the first property is reachable by a process
  that can also reach the network, in one directory, at the same time. This is the accepted risk, written here
  as accepted rather than as a gap someone forgot;
- **what is recorded, and what is not yet shown.** D3's compensating control is that the carry-in is written
  down: `WORK_ITEM_WORKSPACE_CREATED` carries `carriedPaths` (`packages/contracts/src/workspace.ts`,
  `apps/daemon/src/session-loop.ts`), capped at `maxCarriedPaths` = 500 with the cut logged rather than the
  event rejected. The record is durable and reaches the browser. **It is not rendered**: the Workbench
  timeline entry for that event shows the branch name only (`apps/web/src/views/WorkbenchPage.tsx`,
  `event.workspaceCreatedDetail`). So the fact is auditable after the run, and not yet legible in the cockpit
  during it — the mitigation is half-delivered, and is recorded that way here rather than claimed whole.

Bounding the blast radius, and the reason this is High rather than Critical: the write is confined to the
worktree named by `-C`, which lives outside the repository (D2), on its own `loomrail/…` branch. Exactly what
that does and does not touch inside the owner's `.git` is stated under the registration decisions below —
the agent's own writes never leave the worktree, but the worktree and its ref are repository-level objects.

**A note on the child's environment, from reconnaissance rather than from our code.** Commands the agent runs
are executed by the Codex CLI through `/bin/zsh -lc` — a _login_ shell, which reads the owner's profile — so
the child's `PATH` and environment are the owner's, not the daemon's (spec §2.13). Loomrail adds nothing of
its own to that environment and scrubs nothing from it: SD-002 (an injected environment profile) is not in
this milestone. This is a property of the CLI observed by probe, not something Loomrail asserts or enforces,
and it is written here so that the `.env` control listed under §7 "Secrets" is not read as already true.

**T20 — the machine's own Codex config decides what the agent may do.** Rated High, and this weakening existed
_before_ E1: `codex exec` launched without `--ignore-user-config` inherits the owner's entire
`~/.codex/config.toml` — `approval_policy`, `sandbox_mode`, hooks, plugins, model providers **and MCP
servers** — while Loomrail permits only its C1 session proxy. `-s` overrides `sandbox_mode` for the
sandbox itself, but hooks, plugins and MCP servers are not sandboxed at all. Mitigations, verified in code:

- **`--ignore-user-config` is sent on every launch**, read-only and workspace-write alike
  (`packages/provider-codex/src/index.ts`), and pinned by `packages/provider-codex/test/adapter.unit.test.ts`'s
  "does not let the owner's own codex config decide what the agent may do". Authentication is unaffected: it
  lives in `CODEX_HOME`, not in `config.toml`. What the CLI does with a flag it documents is the CLI's
  behaviour, not something this repository can prove — the assertion here is over the argv Loomrail builds;
- **the `-c` exception is a closed assignment grammar, guarded by value rather than by spelling.** A writable
  workspace may add the fixed `sandbox_workspace_write.network_access=true` value. C1 may add only the three
  `mcp_servers.<safe-id>.command|args|enabled_tools` values generated from a typed Loomrail proxy connector.
  Banning the spelling would ban these launches; permitting it without checking values would permit
  `sandbox_permissions` with it. The adapter test therefore validates **every** `-c` assignment, including
  attached short-flag spellings, against that closed grammar;
- **the guard matches by prefix as well as by exact token.** A clap-based CLI accepts `-cKEY=VALUE` and
  `--config=KEY=VALUE` as single argv tokens, and the first version of this guard — `not.toContain("-c")`,
  plus a reader that only inspected the token _after_ an exact `-c` — let both through untouched. That is the
  documented sandbox escape written as one word. `flagSpelling` now recognises the bare token, the long
  attached `--flag=value` form, and, for a one-character short flag, the attached `-cvalue` form with no
  separator; a trailing `-c` with nothing after it yields an empty assignment, which is not on the allow-list
  either. The guard is itself tested against smuggled spellings rather than only used
  (`packages/provider-codex/test/adapter.unit.test.ts`, "catches a forbidden config key smuggled into a single
  argv token"), and it reads the argv **array**, never a joined command line — the context pack is a
  positional argument, so a joined-line check would fire on prompt text containing `-c`;
- **`--dangerously-*` remains absent on every path**, workspace or none, and `--skip-git-repo-check` is sent
  only in the no-workspace case: inside a worktree the check passes on its own and its absence is a free
  assertion that the directory really is a repository (spec §2.7, D8).

Two registration decisions belong on the record here too, because both are things Loomrail deliberately does
not refuse.

**A repository's own top level is always accepted — including Loomrail's own checkout.** `resolveRegisteredRepository`
(`apps/daemon/src/fixtures.ts`) refuses a path that is not a Git repository, and refuses a directory _inside_
one, but a repository root always passes and nothing special-cases this one. That is the decision, not an
oversight: the owner who types this checkout's path has named it deliberately, and a tool that cannot be
pointed at its own source is a poorer tool for it. It is also, after this milestone, the one remaining way to
hand a live agent Loomrail's own code, which is why it is written down rather than left implicit.

What protects the owner in that case is the shape of the work rather than a refusal:

- **the agent never writes in the owner's working copy.** A workspace is a Git worktree cut _outside_ the
  repository, under Loomrail's own data directory (`<data>/workspaces/<projectId>/<workItemId>`, spec D2), on
  its own `loomrail/…` branch. The owner's working copy, index and checked-out branch are untouched — the
  carry-in snapshot is built through a temporary index under the system temp directory, never the repository's
  own (`packages/workspace/src/snapshot.ts`), which is why `git status --porcelain` before and after is
  byte-identical (spec §2.9, acceptance criterion 4);
- **it does write bookkeeping inside the owner's `.git`, and saying otherwise would overstate this.** A
  worktree is a repository-level object: `git worktree add -b` creates `.git/worktrees/<name>/` and the
  `loomrail/<id>-<slug>` ref in the owner's own ref store, and `commit-tree` writes the snapshot commit into
  the owner's object store. The bound is which of those it may touch: Loomrail creates its own ref and never
  moves, rewrites or deletes a pre-existing one. The single deletion it performs is a compare-and-delete of
  the ref it created itself, and only while that ref still points at the commit Loomrail put there
  (`deleteBranchIfUnmoved`, `packages/workspace/src/worktree.ts`) — an owner who committed onto that branch
  keeps it;
- **exactly one commit, on that branch, and nothing pushed anywhere.** The only commit Loomrail creates is the
  carry-in snapshot (`packages/workspace/src/snapshot.ts`); nothing commits on the owner's behalf afterwards,
  because agent Git authority is GD-001 and out of scope here (spec §11). No code path in
  `packages/workspace/src` or `apps/daemon/src` invokes `push`, `fetch`, `clone`, `pull` or `remote`: no
  remote is contacted at any point in this milestone;
- **the refusal that remains is the one that matters.** A _subdirectory_ of a repository is still refused
  (`REPOSITORY_PATH_INSIDE_REPOSITORY`), because registering one would silently branch the enclosing
  repository and hand the agent everything in it — which the owner did not choose and would not see.

No confirmation dialog stands in front of this, by decision: a prompt that appears whenever a path resembles
Loomrail's own would train the owner to dismiss it, and it protects nothing the properties above do not.

**A Project's repository path must be absolute.** A relative path resolves against whatever directory the
daemon was launched from — a shell, a launcher, a login item — so a stored relative path names a different
repository on the next start than it did on this one. `repositoryPathSchema`
(`packages/contracts/src/work-management.ts`) enforces it on the command and on the Project itself, so no route
or fixture can put one in the database, and `resolveRegisteredRepository` answers `REPOSITORY_PATH_NOT_ABSOLUTE`
naming the path, rather than letting the owner discover it as a Project pointing somewhere they never chose.

### E1.5 change-visibility delta (T21)

E1.5 (`docs/plans/15-e1-5-change-visibility-spec.ru.md`) adds two authenticated GET routes that
read a worktree's changed-file summary and one client-named file diff. The local owner already has
authority to read that repository; the new risk is answer integrity and resource exhaustion: Git
pathspec is a language, so a string that looks like one filename can select the whole tree, and an
unbounded patch can make the daemon buffer far more than the owner asked to see.

The controls are implemented at the `packages/workspace` boundary and verified through both that
boundary and the HTTP surface:

- the client path is canonicalised inside the recorded worktree and refused on escape, including a
  prefix-sibling path such as `/tmp/wt-evil`; symlink escape is checked on its canonical target;
- every Git pathspec uses `:(literal)`, and a separate unrestricted `--name-status` read must contain
  the exact requested name. Both halves are necessary: the literal form prevents `*`, `:/` and
  `:(top)` from selecting other files, while the exact-name check prevents a directory from
  answering for every file below it;
- a path that names no changed file, cannot be resolved, or leaves the worktree is a named 400
  refusal, never an empty diff that would claim the file was unchanged;
- a summary is capped at 2,000 files and one body at 512 KiB, with explicit `truncated` and
  `omittedBytes`; refreshes of the expensive subtree are coalesced to the measured 1,600-ms window,
  while closed cards have no active read;
- the routes require the same local session as every other GET. Diff content is returned only to
  that browser response and is not added to structured log fields or durable state.

Verification: `packages/workspace/test/changes.integration.test.ts` covers traversal, symlink,
pathspec-magic, directory, missing-file and byte-boundary cases against real temporary Git
repositories; `apps/daemon/test/server.integration.test.ts` repeats hostile paths through HTTP and
checks session, missing/unreadable worktrees and missing Git; the Workbench browser test proves the
summary does not fetch bodies eagerly and that only the expanded body refreshes.

One repository write is deliberately recorded rather than hidden: the temporary index itself is
outside the worktree, but `git add -A` and `write-tree` put unreachable blobs/trees in the owner's
shared object database. They do not touch the working tree, the owner's index, refs or commit
history, and normal Git garbage collection may remove them. The stage label therefore preserves
SHA equality indefinitely but is a usable diff base only while those objects remain.

### D2 live-route delta (T22)

D2 (`docs/plans/19-d2-full-route-example-spec.ru.md`) closes a false-success path at the provider
boundary. Before it, both live adapters constrained every final answer to a generic checkpoint and
translated it to `COMPLETED`. Review and QA therefore had no way to produce their required evidence,
while the same ordinary completion on the final Acceptance stage followed `nextStage === null` and
marked the PipelineRun succeeded without an AcceptancePackage or owner decision.

The controls are structural and verified below the model layer:

- `provider-core` selects one strict JSON Schema from the durable WorkflowStage. Review and QA each
  require exactly their own typed artifact; Acceptance permits `READY_FOR_ACCEPTANCE` or a blocking
  owner question, never ordinary completion;
- an invalid terminal result is an unproductive session. Claude Code no longer promotes arbitrary
  prose or whitespace to a successful stage merely because the CLI exited zero;
- the daemon supplies `capabilities().provider` beside the untrusted outcome in
  `APPLY_PROVIDER_OUTCOME`; provider output cannot choose its own audit attribution;
- the domain independently rejects `COMPLETED` on Acceptance, even if an adapter or internal caller
  bypasses the stage-result decoder;
- EvidenceArtifact and SQLite accept only `MOCK`, `CODEX` or `CLAUDE_CODE`. Migration 0014 preserves
  historical MOCK rows, and append-only triggers remain after the table rebuild.
- the normal first-attempt path may expose at most one provider-authored owner gate. The daemon derives
  this from durable HumanRequests on StageAttempts in the current run and passes an explicit policy to
  the adapter; after the gate is used, both the CLI schema and the shared decoder reject `NEEDS_HUMAN`
  on the resumed attempt and automatically following stages. An explicit retry receives one fresh,
  bounded gate. This bounds a provider-driven question loop without weakening the separate human-only
  AcceptancePackage. Operational provider/CLI failures still fail closed and never advance the workflow.

Verification: provider-core and both live-adapter unit suites cover stage decoding, wrong evidence
kind, invalid prose, last-result semantics and the owner-only Acceptance result; domain tests cover
the forbidden transition; persistence tests cover live attribution, unknown-provider rejection and
v13 row preservation; the daemon worker integration drives a CODEX-shaped route over a temporary
real Git repository to a durable Decision, diff, both evidence artifacts and pending Acceptance.

The artifact body is still provider-authored output. Typed shape and attribution make it auditable;
they do not turn a claimed QA check into independently measured BrowserDriver evidence. The example
therefore asks the owner to run its standard-library test separately before accepting.

## 7. Future execution threats

The following controls are required before their corresponding feature can ship.

**E1 shipped part of one of these features ahead of its controls, by owner decision.** "Filesystem, shell and
Git" and "Secrets" below both describe the surface E1 opened, and E1 delivered only some of what they ask:
the task worktree, the one-writer lease and the no-push rule are real (see the E1 delta above), while the
command allow-list, the network-host list, the scrubbed child environment and keeping `.env` out of the task
worktree are not — D3 carries every unignored file in deliberately, and SD-002 is explicitly out of scope
(spec §11). The remaining items stay required for the milestone that completes SD-001, and are listed here as
outstanding rather than quietly re-scoped.

### M2 local-state delta

- mutation HTTP routes require local session, exact Origin, JSON content type and a session-bound CSRF header;
- bundled fixture registration accepts only catalog IDs and validates canonical realpaths against symlink escape;
- command ID plus canonical semantic-input hash prevents retry duplication and ID reuse;
- expected WorkItem version and deterministic transition matrix reject stale/forbidden updates before persistence;
- current state, normalized acceptance criteria, append-only Event and command receipt share one transaction;
- migration checksum drift fails startup; existing non-empty databases receive an online backup before migration;
- Events and command receipts have database triggers rejecting UPDATE and DELETE.

The remaining Phase 0 WebSocket/session-restart controls are still future work; M2 does not claim them early.

### M3 persisted Workbench delta

- WorkItem title, description and criteria render only through escaped React text nodes; raw HTML/Markdown rendering
  is absent and CSP remains `default-src 'self'`;
- browser E2E persists script-shaped fixture text, reloads it and verifies that no handler executes;
- API failures are classified as retryable daemon unavailability or session/CSRF expiry without exposing tokens;
- browser recovery cannot mint a bootstrap token: the CLI remains the only authority that opens a fresh one-time
  authenticated URL;
- failed/retried UI mutations preserve SQLite state through existing command idempotency and optimistic versioning.

### M7 public checkpoint delta

- `style-src` and `script-src` stay `'self'`, so no stylesheet or script can be injected into the Workbench;
  `style-src-attr 'unsafe-inline'` is granted only so headless overlay primitives can write positioning style
  attributes. `script-src-attr` remains `'none'`. A daemon integration test pins every one of these directives.
- The launcher prints the one-time bootstrap URL only when it does not open a browser itself. The token stays a
  single-use, 60-second, loopback-only grant, so terminal exposure is equivalent to handing it to the browser and is
  the only way to authenticate a headless or remote-terminal run. It is still never written to the structured logger,
  SQLite or Git, and a unit test asserts it is absent from launcher output whenever a browser was opened.

### D3 public-landing delta (T23)

D3 adds a public static site and a GitHub Pages deployment path. It does not connect to the local daemon and has no
authority over Loomrail state, but it widens the public supply-chain and privacy surface: a compromised dependency or
workflow could ship browser code, and an accidentally selected asset could publish private local data.

- `apps/landing` imports no runtime package and builds only static HTML, CSS, JS, fonts and reviewed files from
  `docs/assets`; there is no form, account flow, cookie or analytics integration;
- fonts are bundled at build time instead of fetched from a third party, and CSP restricts scripts, styles, images and
  fonts to the site itself; the public-contract test enumerates resource elements, rejects external resource URLs and
  checks for common analytics hooks;
- the existing public-tree scan covers every tracked and unignored landing source/asset for private paths, secrets,
  databases and unsanitized screenshots before handoff and in normal verification;
- Pages actions are pinned to full commit SHAs. The build job has `contents: read`; only the dependent deploy job gets
  `pages: write` and OIDC `id-token: write`, and no repository or deployment secret enters the build;
- the landing shows the exact public pre-alpha version and explicit capability limits. It links to the normative guide
  and example rather than inventing executable setup instructions of its own.

### B5+B1 repository-onboarding and Constitution delta (T24)

B5+B1 lets the daemon inspect an existing Project repository and, after a separate owner decision, publish
`.loomrail/constitution.md`. This crosses two boundaries at once: untrusted repository text enters durable local
state, and an approved state transition causes a write in the owner's repository. The combined threat is rated
**High** because an over-broad scan could disclose secrets and a stale proposal could replace a policy file the owner
changed after review.

- `packages/project-constitution` is the one deep module that owns both boundaries. Its scanner considers only named
  root metadata, CI workflows and bounded architecture documents; it reads at most 128 candidates, 512 KiB per file
  and 2 MiB total, does not follow symlinks, never traverses a source tree, and records lockfiles by presence only;
- `.env` and arbitrary source files are not candidates. Package scripts contribute validated names and constructed
  package-manager argv only: their command bodies never enter a Proposal, Event, SQLite row, response or log, and no
  discovered command is executed;
- every one of the seven proposed sections carries source provenance. Repository paths are labelled untrusted and
  cannot override the trusted preset, product security invariants or the owner's approval gate;
- scanning is read-only. `REQUEST_PROJECT_CONSTITUTION_ADOPTION` is a separate authenticated Origin+CSRF mutation;
  the Constitution, audit Event and durable publication follow-up are committed in one SQLite transaction;
- publication re-checks the canonical Git top level, refuses symlink/non-file targets, compares the current target
  digest with the reviewed scan, writes a same-directory temporary file and renames it atomically. A changed target is
  preserved and the publication becomes `FAILED` with a typed code;
- startup drains pending publications. If the file landed before a crash but completion did not, its content digest
  makes the retry idempotent; an older failed publication cannot be retried after a newer Constitution version exists.

Verification: `packages/project-constitution/test/onboarding.integration.test.ts` covers symlink refusal, byte bounds,
secret-script canaries, create/idempotent publication and compare-and-set preservation;
`packages/persistence-sqlite/test/constitution-state.integration.test.ts` covers transactionality, command replay and
restart recovery; `apps/daemon/test/constitution.integration.test.ts` covers the authenticated HTTP path, absence of
`.env`, instruction and script-body canaries in the response, no write before owner adoption, and preservation of an
owner edit made between scan and adoption.

### B3+B2 Project Readiness delta (T25)

B3+B2 adds a one-action local preflight over a registered repository and lets the owner attest launch decisions.
The tempting unsafe implementation would execute discovered build/security scripts, search every file for secret
values, follow workflow symlinks or turn an unverifiable input into a green result. The combined threat is rated
**High**: the operation is owner-triggered but runs over attacker-controlled repository state, and a false `READY`
could be treated as permission to launch.

- `packages/project-readiness` owns one bounded read-only interface. It accepts only the Project's stored top-level
  repository path and uses closed internal Git argv for `rev-parse`, `status`, `ls-files` and `check-ignore`; no shell,
  package manager, project script, hook or network operation is invoked;
- each Git child has a ten-second timeout and a 2 MiB output ceiling, disables optional locks and repository hooks,
  and fails closed. The tracked-secret check reads path names only. It never opens `.env`, `.npmrc`, key or credential
  files and never persists their values;
- CI inspection is restricted to regular `.github/workflows/*.yml|yaml` files: at most 32, 256 KiB each and 1 MiB
  total. Symlink, unreadable and over-bound inputs become `CI_INPUT_UNVERIFIABLE`, never `PASSED`;
- automatic checks are a closed catalog. Their status is derived from findings, while legal/payments/analytics
  owner checks begin unresolved. The domain rejects missing/duplicated/misclassified catalog entries and refuses an
  attestation against an automated check, another Project, a stale version or a non-latest Run;
- assessment rows, checks, findings, Event and command receipt share one SQLite transaction. Attestation, projected
  check/run status, append-only decision, Event and receipt share another. `READY` is computed only when no check is
  `ACTION_REQUIRED`; it remains explicitly tied to HEAD, dirty state, source digest and check time;
- all HTTP mutations require the existing local session, exact Origin, JSON content type and session CSRF token. The
  client cannot supply a filesystem path or claim an active Constitution; both facts are read from durable Project
  state by the daemon.

Verification: `packages/project-readiness/test/scanner.integration.test.ts` uses non-ASCII/space paths, a tracked
secret-value canary, a malicious package script, risky CI and a symlink/non-top-level path; it proves no command or
secret value escapes and every unverifiable input fails closed. `packages/persistence-sqlite/test/readiness-state.integration.test.ts`
covers the closed catalog, command replay, owner/automated boundaries, stale/latest-run checks, aggregate `READY` and
restart durability. `apps/daemon/test/readiness.integration.test.ts` drives registration, owner-approved Constitution,
session/CSRF-protected assessment, three owner attestations and the persisted final snapshot through HTTP.

### Provider CLI

- scrub inherited environment;
- argv arrays, no implicit shell interpolation;
- capability/version negotiation;
- provider-native approvals bridged to Loomrail;
- raw events quarantined and normalized;
- output size/rate bounds;
- never enable permission bypass automatically.

### Provider Selection delta (T26)

AUTO selection adds two child-process probes and lets an authenticated browser mutation choose which live CLI a
Project will launch next. The High-rated failure is a poisoned executable/config or a stale selector silently routing
work to a different provider while the owner believes the chosen one ran.

- executable and auth status are separate observations; a PATH hit alone never proves readiness;
- probes use fixed argv arrays, no shell, closed stdin, a short deadline and discarded stdout/stderr. Only provider
  id, installed/auth state and time are kept in memory; credential/account output is never parsed, persisted or logged;
- preference changes use Project optimistic version, CSRF/Origin/session enforcement and one transaction containing
  state, append-only Event and idempotent command receipt;
- explicit live preference never falls through to another live adapter or a successful mock result;
- daemon owns a stable adapter registry. The worker captures the exact adapter serving the live ProviderSession, so
  a concurrent Settings change cannot redirect abort/handoff;
- `LOOMRAIL_PROVIDER` override is reported to UI and disables mutation rather than secretly defeating the selector;
- no probe or selector adds a permission-bypass argument or inherits user MCP/plugin configuration.

Verification: domain tests cover no-op and version conflict; persistence covers atomic replay and restart;
daemon integration covers probe output canaries, missing/auth-required states, AUTO and environment precedence, and
adapter capture across a concurrent preference change; browser E2E covers RU/EN, keyboard and both themes.

### MCP Connections delta (T27–T31)

**T27 — authenticated browser configuration becomes local code execution. Critical.** A hostile page cannot pass
Origin/CSRF/session controls, but compromised bundled UI or a stolen local session could try to turn profile creation
into `spawn(arbitraryText)`. Proposal never executes or persists active authority; Consent is a separate one-time,
expiring challenge over a canonical digest and exact argv display. Only absolute executables and bounded argv arrays
are accepted; shell/download/elevation launchers, URL/env/secret/cwd and on-the-fly probe/session payloads are refused.
Windows preflight additionally requires a canonical `.exe` or `.com` image. Node does not enforce POSIX execute bits
on Windows, and `.cmd`/`.bat` shims would require a shell that the gateway deliberately never enables.
The refused set covers command-dispatch wrappers (`env`, `xargs`, `nohup`, `setsid`, `osascript`, `wsl`, …) as well as
shells themselves: a wrapper executes its own first argument, so a list that knew only shells by name would have let
`/usr/bin/env bash -c …` through as an "exact command" the owner had approved. The canonical digest covers the launch
and the declared tools, not the profile identifier, so re-approving an unchanged recipe is recognised as unchanged
instead of being filed as a second, identical revision.

**T28 — malicious local server escapes lifecycle or floods daemon. High.** Provider never launches the real server.
Daemon-owned gateway owns the SDK transport and closes it on session end; probe and private proxy paths bound message,
aggregate output, argument depth/size and capability counts. A Loomrail supervisor pre-validates each stdout message,
uses a detached POSIX process group or Windows `taskkill /T`, and applies EOF then TERM/grace/KILL to the full tree.
It also watches daemon liveness and performs the same cleanup immediately if the daemon disappears; integration tests
use a server with a signal-resistant descendant. Before exposure, supervisor atomically writes a mode-`0600` process
record beside durable local state. Startup validates the bounded non-symlink record and compares the current OS process
start time before killing a tree that survived both daemon and supervisor; a reused pid is left alone. The remaining
release gate is a real green Windows CI run for the `taskkill /T` branch. A platform adapter test fixes the exact
`taskkill.exe /PID <pid> /T [/F]` argument vector without shell interpolation, and CI exposes the Windows MCP lifecycle
suite as a dedicated step. The Windows identity probe returns the process creation time as an absolute Unix timestamp;
it does not combine a pre-spawn JavaScript clock with an elapsed duration measured after PowerShell startup. A fully
compromised same-user account remains outside the local-mode boundary.

**T29 — capability drift or provider ambient config widens authority. High.** Consent binds immutable revision digest;
Grant is a separate closed tool allowlist; capability snapshot is observation only. Codex keeps
`--ignore-user-config` and accepts only closed Loomrail proxy `mcp_servers.*` overrides. Claude uses generated config
with `--strict-mcp-config`. New tools remain hidden until a versioned Grant command.

**T30 — MCP content injects workflow instructions, paths or secrets. High.** Descriptions, prompts, resources,
structured content, errors and links are untrusted provider input. Roots are not ACL. C1 exposes no env/secret fields,
validates schemes/paths/sizes at gateway and never treats server text as command, approval, Decision or workflow state.
Audit stores ids/digests/counts and typed outcomes, not raw sensitive payload.

**T31 — lost tool response is retried and duplicates a side effect. High.** Gateway records `STARTED` before forward.
Disconnect/crash after forward produces durable `UNKNOWN_OUTCOME`; no automatic retry occurs, including for a tool the
owner labelled read-only. Explicit recovery requires checking external state and creating a new StageAttempt. C1 does
not auto-approve side-effect tools and does not spend the provider-authored HumanRequest gate on per-call prompts.

**T32 — bundled Context7 becomes a silent supply-chain install or exfiltration path. High.** C3 adds one external
server to Loomrail's production dependency tree and its two tools send user-authored queries to an open-world remote
documentation service. The package is exact-pinned in the lockfile/release manifest and installed only when Loomrail
itself is installed; runtime never invokes `npx`, `latest`, PATH discovery or a download fallback. The authenticated
preset endpoint accepts only expected Project version and builds executable, argv and tool names inside daemon. Normal
C1 exact Consent, realpath recheck, probe, allowlist, proxy, audit and revoke remain mandatory; newly discovered tools
receive no authority. C3 passes no API key or secret env and writes no provider/repository auto-invoke rule. UI states
that queries leave the machine and must exclude secrets, personal data and proprietary code. A compromised signed
Loomrail/Context7 release remains part of the software-update trust boundary; C3 does not claim to sandbox it.

**T33 — plugin manifest is mistaken for a sandbox or gains workflow authority. High.** C2 executes no plugin inside
the daemon and exposes no Project, WorkItem, StageAttempt, HumanRequest, Decision, budget, permission or acceptance
method. The SDK serves only MCP tools in a separate stdio process and owns the annotations
`readOnlyHint=true`/`destructiveHint=false`; authors cannot override them. A strict manifest rejects command, argv,
cwd, env, secret, workflow-hook and arbitrary-permission fields. Tool names are derived from the actual definitions
and checked again before the transport opens. Handler inputs and outputs are runtime-validated and bounded; thrown
errors become a generic result without raw message or stack. The manifest's network hosts remain an unverified claim,
not an OS allowlist: UI/docs must still describe a third-party process as having the user's account authority. Actual
provider exposure continues to require exact C1 owner Consent, a successful probe and a separate closed tool Grant;
capability discovery cannot self-authorize. Marketplace, download/install, signatures, secrets and side-effect tools
remain outside C2.

Verification required by C2: strict manifest rejection and canonicalization; exact tool/manifest equality; fixed MCP
annotations; invalid-input and redacted-failure tests; real C1 probe against a synthetic SDK plugin; clean npm subpath
resolution on macOS and Windows.

**T34 — new-project scaffold overwrites a path or executes a template payload. Critical.** B4 is the first Loomrail
flow whose purpose is to create a repository tree, so a path race, traversal, symlink or executable template could
turn one confirmation into arbitrary filesystem mutation. B4 accepts no remote/local arbitrary template: only a
built-in immutable Recipe can render files, with strict bounded portable paths, UTF-8 content and no lifecycle
scripts. Proposal is read-only and binds canonical target, recipe version and every file digest; publish recomputes
it and requires the owner's exact digest. Target must not exist and is claimed with non-recursive `mkdir`; all files
use create-new writes. Portable Node APIs do not provide directory rename-without-replacement, so recovery is explicit
rather than hidden behind a false atomicity claim: a durable Operation is stored before mutation, and an existing
target is resumable only when its regular-file marker exactly matches that Operation and proposal. Unknown marker,
changed file, symlink or special file fails closed and is never deleted. Git uses argv without shell and disables
owner/system config, ambient `GIT_*`, template/hooks/signing and terminal prompts; an unexpected recovery-tree path
also fails closed. Dependency install, generated commands, commit, push and remote creation are excluded.

Verification required by B4: traversal/root/nested-repository/symlink and target-race tests; recipe lifecycle-script
rejection; create-new conflict tests; restart after each publication step; mismatched marker/file preservation;
idempotent publish and Project registration; HTTP Origin/session/CSRF bounds; redaction canaries; RU/EN, keyboard and
light/dark browser coverage on macOS and Windows.

Verification required by C1: proposal replay/digest/expiry; CSRF/Origin; shell/download denial; ambient-config canary;
ungranted call never reaches fake server; revoke race; flood/invalid JSON; process orphan cleanup; unknown outcome/no
retry; redaction canaries; RU/EN, keyboard, light/dark E2E.

### Filesystem, shell and Git

- canonical workspace allowlist;
- task branch/worktree default;
- one writer lease per worktree;
- command/working-directory/network permission tuple;
- preflight user changes;
- destructive commands and push/merge require human approval;
- no recursive cleanup of unresolved paths.

### Secrets

- existing `.env` stays user-owned and excluded from task worktrees where possible;
- agent process receives a scrubbed environment;
- UI-added secrets use OS credential storage;
- trusted runner injects only an allowed environment profile;
- redaction occurs before persistence;
- production secret use requires separate approval;
- unrestricted/current-directory mode warns that same-user shell access can read local files.

### BrowserDriver

- origin/profile allowlists;
- isolated Playwright context by default;
- signed-in Chrome access is explicit and visible;
- prompt-injection content treated as untrusted;
- payments, publication, account/security and destructive actions require approval;
- screenshot/trace retention and redaction.

### Plugins

- separate process, signed/versioned manifest;
- declared filesystem/network/secret/browser permissions;
- no dynamic code loaded into daemon process;
- install/update requires human trust;
- crash/resource isolation and audit.

## 8. Secret classification

| Class              | Example                   | Default handling                                        |
| ------------------ | ------------------------- | ------------------------------------------------------- |
| Public config      | local port, theme         | normal config                                           |
| Sensitive metadata | repository path/name      | local only, redact from telemetry/export where selected |
| Development secret | test API key              | `.env` or OS credential store; trusted runner only      |
| Production secret  | deploy/payment credential | denied by default; exact approval and short scope       |
| Provider auth      | Codex/Claude login        | provider-owned auth; Loomrail stores no raw credential  |

HumanRequest is never a secret-input channel.

## 9. Privacy and retention

- telemetry absent in Phase 0 and opt-in later;
- Tasks/Events/Decisions/handoffs persist until user deletion/export policy;
- raw unpinned transcripts/logs/screenshots/traces default to 30 days after closure;
- export excludes secrets, `.env`, provider credentials and Git repository;
- deletion of Loomrail Project never deletes source repository/provider data without a separate exact confirmation.

## 10. Incident-safe behavior

- auth/session failure: reject command and preserve state;
- migration failure: do not open mutation API; offer backup recovery instructions;
- orphan run: mark Interrupted; never silently retry;
- suspected secret in output: redact/quarantine and create local attention event;
- corrupted provider/plugin stream: stop adapter, preserve raw bounded diagnostic, do not advance workflow;
- budget exceeded: hard pause before next dispatch.

## 11. Residual risks

- a process running as the same OS user may inspect files/processes unless a stronger OS sandbox is introduced;
- localhost HTTP does not provide transport encryption, so the boundary relies on loopback, session and browser origin
  protections;
- provider-native browser/session tools may expose authenticated data after explicit user grant;
- dependency compromise cannot be eliminated, only reduced through pinning, review and provenance;
- LLM output remains untrusted even after independent review;
- the untrusted-checkpoint delimiter framing (`packages/context-assembly/src/render.ts`) is plain string
  concatenation with no escaping of the delimiter tokens: a provider could emit the literal END delimiter
  followed by fabricated instructions and attempt a collision escape out of the untrusted block (T15). Owner
  visibility of the full checkpoint text is the mitigation this residual risk relies on, not a fix for it.

## 12. Review checklist

At every Phase:

- update assets, actors and trust boundaries;
- add threat delta for new capabilities;
- map each Critical/High threat to automated verification;
- verify redaction with canary values;
- review dependency and release provenance;
- inspect export/retention/deletion behavior;
- document residual risk and any human waiver.
