# Loomrail user guide

> Early pre-alpha · [Quick start](GETTING-STARTED.md) · [Русская версия](USER-GUIDE.ru.md)

This guide takes you from a clean local launch to an accepted delivery, then explains how to run a real coding agent,
inspect its work, recover after a restart, and preserve Loomrail's local state.

Loomrail is local-first, but it is not a security sandbox or a Git client. A live agent runs with your operating-system
account and may use the network. Loomrail creates an isolated Git worktree for a task, shows what changed, and keeps the
workflow state; it does not commit, push, or merge the agent's result.

## 1. Install and start Loomrail

Use Node.js `>=24.19 <25`. For the first run, install the explicit public pre-alpha channel in a separate empty
directory rather than inside a repository you care about:

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail setup
npx loomrail start
```

The explicit Chromium download is a one-time prerequisite for isolated Browser QA; Loomrail does not reuse a signed-in
browser profile. Setup defaults to a Mock walkthrough, verifies the complete local route without changing state, and
prints the exact owner actions that remain. The `next` tag keeps the pre-alpha channel explicit. To put the launcher
on your `PATH` instead:

```bash
npm install -g --ignore-scripts loomrail@next
npx playwright install chromium
loomrail setup
loomrail start
```

Loomrail binds to an available loopback port and opens the Workbench in your default browser. If the browser should not
open automatically:

```bash
npx loomrail --no-open --port 4176
```

For a global installation, run the same flags as `loomrail --no-open --port 4176`.

Open the printed one-time URL in a browser **on the same machine** within 60 seconds. It signs in one browser and then
stops working. `--no-open` is not remote mode: the daemon still listens only on loopback.

To run from source instead, use `pnpm dev` from the repository. This is the contributor path; it builds the whole
workspace before starting Loomrail.

Keep the terminal open. Closing the browser tab does not stop Loomrail or its queue. Press `Ctrl+C` in the terminal for
a graceful shutdown and wait for the command to exit.

## 2. Know which provider is running

Provider choice belongs to a Project. Open **Settings → AI provider** after selecting the project:

| Choice      | What happens                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Auto        | Uses an installed, authenticated live CLI. If none is ready, new sessions use the clearly marked Mock fallback. |
| Mock        | Deterministic test double for agent work. Browser QA is still measured by the local Playwright driver.          |
| Codex       | The real `codex` CLI runs supported agent stages in the task's Git worktree. Browser QA stays daemon-owned.     |
| Claude Code | The real `claude` CLI serves Discovery, Plan, and Review. Unsupported agent stages stop as a Human Request.     |

Install and authenticate Codex or Claude Code with that provider's own CLI, then start Loomrail normally. Choose
**Check again** after installing or signing in. Loomrail checks only whether the executable exists and whether the
provider's status command succeeds; it does not capture credentials or status output. When both live CLIs are ready,
Auto prefers the one with broader stage coverage. A change applies to new provider sessions; a running session keeps
the adapter it started with.

An explicit live choice that is not installed or authenticated is refused visibly rather than silently replaced by
Mock. Start with **Mock** even if you plan to use Codex: it confirms installation, browser authentication,
persistence, Human Requests, budgets, and acceptance without spending provider quota.

`LOOMRAIL_PROVIDER=MOCK|CODEX|CLAUDE_CODE` remains an optional, case-sensitive process-wide override for automation
or troubleshooting. It locks the Project selector until restart. An unknown value is reported and keeps the process
in Mock mode. Ordinary use does not require this variable.

## 3. Complete the first mock delivery

### Create a project and task

1. On an empty installation, choose **Initialize demo workspace**. Loomrail copies the two bundled templates into its
   data directory and initializes real local Git repositories for them.
2. Choose a project and select **New task**.
3. Add a title and a brief that states the outcome, constraints, and relevant files. Choose the priority and create the
   task.
4. Open the task and use **Edit task** to add one acceptance criterion per line. Acceptance is more useful when these
   are observable results rather than implementation instructions.
5. Select **Move to Ready**, then **Start workflow**.

The button starts the same bounded Discovery → Plan → Implementation → Review → QA → Acceptance template for every
provider. Mock supplies deterministic agent-stage results; with Codex, live sessions do that work. QA itself always
uses Loomrail's isolated Playwright driver and cannot be passed by provider prose.

### Watch parallel work in Agent Fleet

Open **Agent Fleet** in the sidebar to see agent work across every local Project. Each row identifies the Task,
Project, assigned versioned role, stage, provider, and either **Running**, **Ready**, or **Waiting**. A waiting row also
states the exact scheduler reason, such as a global, Project, provider, checkpoint, or workspace limit. Select the
Task name to return to its Task Cockpit.

Loomrail runs at most three AgentRuns at once by default. The Fleet count is a read-only projection of durable queue
and run state, not a second scheduler: reloading the page or restarting Loomrail reconstructs it from SQLite. Fleet
cannot grant permissions, raise a budget, answer a Human Request, or accept a delivery. Those actions stay in their
existing owner gates.

### Read an independent review

After Implementation, Loomrail starts a fresh **Code reviewer** AgentRun over the recorded Git tree. With **Auto** and
both live CLIs ready, Review prefers the provider the latest Developer run did not use. An explicit Project provider
selection remains a lock, so the cockpit labels the result **Same provider** while still using a separate reviewer run.

The Task Cockpit shows the round, verdict, provider relation, reviewed tree, and bounded findings with severity,
portable file/line location, and reproduction steps. A passed review advances to QA. A first
**Changes requested** result queues a second Implementation and fresh Review. A second stops on a Human Request:
the owner may authorize exactly one final bounded fix/re-review or cancel the run. If that final review still requests
changes, no fourth dispatch is created.

Only the owner may mark an open finding **Risk accepted** or **False positive**, and a reason is required. The decision
is audited and survives restart; it does not make the author their own reviewer or silently bypass re-review.

### Prepare browser QA

The bundled web demo needs no second process: its fixed plan measures Loomrail's local readiness endpoint. For your
own web repository, start the app on loopback and commit a bounded `.loomrail/browser-qa.json` plan before the workflow
reaches QA. The Task Cockpit then shows the measured tree, target matrix, environment, failures, observations, defects,
screenshots, and traces. See [Browser QA](BROWSER-QA.md) for the exact format and security boundary.

### Answer the Human Request

The mock Discovery stage opens a blocking question and the task becomes **Waiting for you**. Open **Attention** in the
sidebar: it lists open requests from every Project, with the affected task, stage, priority, and action. Use Arrow Up,
Arrow Down, Home, or End to move through the list, choose an option, and select **Answer & resume**. The task and its
banner remain alternate entry points to the same answer form.

The request, your answer, and the resulting Decision are durable. Reloading the page or restarting Loomrail does not
erase an unanswered request. The global list is capped at 200 visible items and says when more remain. It is a
projection of durable workflow state, not a second queue; answering in either place closes the same HumanRequest and
records one Decision.

### Handle the budget pause

The mock Implementation stage reaches its configured estimated-token limit and becomes **Budget paused**. Review the
usage and select the offered **Approve … token budget** action if you want the workflow to continue.

A budget override creates a new policy revision; it does not rewrite previous usage. Other hard pauses, such as a
provider rejecting its input or making no progress, do not offer a budget action that cannot solve them. Follow their
Human Request instead.

While a stage is running, **Pause** asks Loomrail to stop scheduling forward work. **Resume** is available for a soft
pause or an interrupted run. **Cancel run** is terminal for that run, so use it only when you intend to stop the route.

### Make the acceptance decision

After Review and QA, the task shows an **Acceptance package** containing typed evidence and a criterion matrix. Inspect
those records and choose one owner action:

Acceptance also appears in **Attention**, but it cannot be answered as an ordinary Human Request. Choose **Review
acceptance** there to open the exact Project and task before deciding.

- **Accept delivery** marks the task Done;
- **Return to work** records that another pass is needed;
- **Reject** records a rejected delivery.

Accepted tasks leave the Active view. Use **All issues** to see them again. Loomrail records the decision, but still
does not commit or publish any repository content.

## 4. Create or register a repository

### Create a new project

Open **Settings → Projects → Create a new project** and enter an absolute path whose parent exists and final directory
does not. Choose **Review exact files** before approving anything. The review binds the canonical target, built-in
`typescript-node` recipe version, every file digest, and the full proposal digest. **Create this project** then writes
only those files with create-new semantics, adds `.loomrail/scaffold.json`, initializes Git without user templates or
hooks, verifies the result, and selects the Project.

Loomrail does not download a template, install dependencies, execute generated code, create a commit, add a remote,
or push. Open the resulting directory in a terminal and run `pnpm install` and `pnpm test` yourself. A stopped
publication remains a durable operation: after reload or restart, Settings shows it again. Resolve the local conflict
and choose **Retry safely**; Loomrail does not overwrite conflicting files or delete the target automatically.

### Register an existing repository

Open **Settings → Projects → Register a local repository** and enter an absolute path to the repository's top-level
directory. A subdirectory, relative path, non-Git directory, or repository without a first commit is refused rather
than guessed.

Before the first agent stage, Loomrail:

1. records the repository's current `HEAD`;
2. creates one carry-in snapshot commit containing tracked changes and untracked files that Git does not ignore;
3. creates a `loomrail/...` branch;
4. adds a linked worktree below Loomrail's data directory.

This keeps your current working copy, index, and checked-out branch untouched. It does modify the repository's shared
Git metadata by adding worktree bookkeeping, a Loomrail branch, a snapshot commit, and unreachable objects used while
reading changes. Do not register a repository whose uncommitted or untracked files you are unwilling to expose to the
selected agent.

A worktree prevents two tasks from accidentally editing the same checkout. It does not restrict the agent's operating-
system permissions or network access. Review the [threat model](../security/THREAT-MODEL.md) before using a live
provider on sensitive code.

### Review and adopt the Project Constitution

After registration, open **Settings → Project Constitution**. The first scan is read-only and bounded: it inspects
allowlisted root metadata, CI workflows, and architecture documentation without reading source files, environment
files, lockfile contents, or script bodies. Scan results show warnings when a source was skipped or a limit was
reached.

Choose the suggested preset or another preset, then review all seven proposed sections and their source labels.
Loomrail writes nothing to the repository until you choose **Adopt and publish**. Adoption creates a versioned owner
decision and publishes `.loomrail/constitution.md` through a compare-and-set write. If the target changed after the
scan, publication fails without overwriting the owner's file; rescan or review the conflict before retrying.

The Constitution is durable project policy, not a provider transcript. Replacing it creates a new version and keeps
the earlier decision in the audit history.

## 5. Run and inspect live work

Install and sign into the provider CLI, open **Settings → AI provider**, choose **Auto** or the provider explicitly,
and use **Check again**. Confirm that the panel names the effective live provider and shows **Ready**, then create a
task in the registered project. No Loomrail restart or extra launch command is required. The brief and acceptance
criteria are the durable instructions each session receives.

For a bounded repository and exact brief you can safely discard afterwards, use the
[reproducible Codex route](../examples/full-route/README.md).

Open the task while it runs:

- **Workflow** shows stages, attempts, provider sessions, checkpoints, and context-window occupancy;
- **Workspace** names the source repository, Loomrail branch, base commit, and worktree path;
- **Changes** lists files that differ from the task's starting snapshot.

Expand one text file to request its unified diff. Binary files are named but have no text patch. Large lists and patches
are explicitly truncated. An empty list means Loomrail successfully measured an unchanged worktree; a read failure is
shown as a refusal instead.

Only the expanded file body is fetched and refreshed. The display is an inspection surface, not staging or acceptance
of individual hunks. To keep the result, open the shown worktree in your editor and perform your own Git workflow. Until
you do, Loomrail has committed none of the agent's edits.

Claude Code currently cannot complete the same live route: it serves Discovery, Plan, and Review, but not
Implementation. Browser QA is provider-independent, but the route cannot reach it until a supported implementation
stage produces an exact tree. Loomrail refuses an unsupported stage through a blocking Human Request instead of
silently switching providers.

## 6. Add Context7 or another MCP connection

Open **Settings → MCP connections**. Context7 is bundled with Loomrail, so choose **Review bundled Context7**; do not
run an installation command. Review the absolute Node executable and package entrypoint, check the exact-command
confirmation, then approve it. This consent permits only a bounded capability probe. Choose **Probe capabilities**,
verify `resolve-library-id` and `query-docs`, select the tools, attest that they are read-only, and grant them. New
provider sessions receive the connection through Loomrail's local proxy; an already running session is unchanged.

Context7 calls an external documentation service. Do not put secrets, personal data, proprietary source code, or
private business context in its queries. Loomrail ships no Context7 API key and uses the anonymous tier.

The manual form below the preset is for an already installed local stdio MCP server. Enter one absolute executable,
one argv element per line, and the exact read-only tool names. Loomrail rejects shell/package launchers, URLs, env and
secret fields. It never downloads a package from this form. Consent, probe, and tool Grant remain separate steps.

## 7. Restart and recovery

Every launch creates a new browser bootstrap; an old authenticated tab may show that its local session ended. Start
Loomrail again and use the new tab or printed link.

Tasks, events, Decisions, budgets, Human Requests, evidence, queue entries, and workspace records live in SQLite and
survive restart. A provider process that died with the daemon is not treated as if it were still running. Loomrail
reconciles the interrupted session, preserves its durable checkpoint/context, and either continues queued work or shows
a **Recovery report** and **Resume** action for owner intervention.

The task's worktree is checked again at startup. If its directory vanished, Loomrail marks the workspace gone and does
not silently cut a replacement: a new tree could overwrite the meaning of the recorded branch and baseline.

## 8. Preserve or restore local state

The default data directory is:

| Platform | Directory                                |
| -------- | ---------------------------------------- |
| macOS    | `~/Library/Application Support/Loomrail` |
| Windows  | `%LOCALAPPDATA%\Loomrail`                |

Set `LOOMRAIL_DATA_DIR` before launch to use an explicit isolated location. This is useful for evaluation or for making
the storage path easy to back up.

The directory contains:

- `state.sqlite` and any SQLite WAL files;
- `backups/`, when a non-empty database needed a backup before a schema migration;
- `logs/`, containing bounded redacted daemon diagnostics rather than workflow truth or raw provider output;
- `demo-projects/`, the materialized demo repositories;
- `workspaces/`, the task worktrees.

There is no supported online export/restore UI yet. To preserve the current installation safely:

1. Stop Loomrail with `Ctrl+C` and wait for the process to exit.
2. Copy or archive the **entire data directory**, including any `state.sqlite-wal` or `state.sqlite-shm` files that remain.
3. Back up every external repository you registered as well.
4. For uncommitted agent work you care about, also copy it from the task's displayed worktree or commit it yourself in
   that repository.

Do not copy only `state.sqlite` while Loomrail is running; WAL may contain committed state that the main file does not.
The automatic files under `backups/` are migration safety copies, not a scheduled full backup, and they do not contain
your external repositories.

For the least surprising restore, stop Loomrail, restore the whole data directory to the same path, restore registered
repositories to their original paths, and start Loomrail normally. Linked worktrees store connections in both the data
directory and the source repository's Git metadata; moving only one side can make the workspace appear orphaned.

Use `loomrail doctor` before startup and `loomrail data-path` when you explicitly need the resolved storage path. The
[operations guide](OPERATIONS.md) owns the complete diagnostic, upgrade, rollback and uninstall contract.

After stopping Loomrail, `loomrail logs export` prints a complete re-redacted NDJSON snapshot and
`loomrail logs delete` removes only Loomrail-owned log segments. The latter does not delete Events, acceptance
records, Browser QA evidence, repositories, workspaces, or unknown neighboring files. Operational logs have a
30-day/16 MiB bound; still review an export before sharing it.

## 9. Troubleshooting

**The page says the local session ended.** The daemon stopped or the one-time session is no longer valid. Restart
Loomrail and use the new authenticated tab. Refreshing an old tab cannot mint a new session.

**The selected provider CLI was not found.** Install and authenticate that CLI using its own instructions, then choose
**Settings → AI provider → Check again**. No extra Loomrail launch command is required. An explicit unavailable
provider is refused rather than silently replaced by Mock; Auto may use the clearly labelled Mock fallback.

**The launcher fell back to mock.** Check the exact case-sensitive value: `MOCK`, `CODEX`, or `CLAUDE_CODE`.

**Context7 reaches an anonymous limit or reports authentication.** The bundled preset deliberately carries no secret.
Disable or revoke it if the anonymous service is unsuitable; API-key storage is not supported in this release. Do not
paste a key into the MCP arguments.

**A project is unusable.** Restore the repository at its registered absolute path. For a bundled demo, Settings can
offer **Repair demo repository**. Loomrail does not silently point an owner-registered Project somewhere else.

**New-project creation stopped safely.** Open Settings to recover the same operation, inspect its closed error code,
and resolve the local path, marker, file, or Git conflict. Choose **Retry safely** only afterward. Do not delete a
marker-bound directory unless you have inspected and intentionally backed up any files in it.

**A worktree is gone or unreadable.** Use the path, branch, and refusal shown in the task. Loomrail will not claim that
unmeasured work is intact, and it will not create a replacement worktree for the same task.

**The changed-file list is empty.** The sentence “This task has changed nothing in its worktree yet” means the read
succeeded. A missing Git executable, missing worktree, invalid baseline, or unreadable directory has its own error
instead of masquerading as an empty list.

## Current pre-alpha limits

- The npm package is pre-alpha and there is no desktop installer.
- The daemon is local-only; there is no remote or multi-user mode.
- Provider preference is saved per Project; an optional process-wide environment override locks it until restart.
- Claude Code has no validated write path for Implementation; Browser QA is daemon-owned.
- Loomrail does not commit, squash, push, merge, or clean up the owner's result.
- There is no supported online state export, retention UI, or portable workspace restore.
- A worktree is collision isolation, not a complete security sandbox.

For contributor setup and architecture, return to the [README](../../README.md). For packaging details, see the
[release guide](../RELEASE.md).
