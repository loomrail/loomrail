# Loomrail user guide

> Early pre-alpha · [Русская версия](USER-GUIDE.ru.md)

This guide takes you from a clean local launch to an accepted delivery, then explains how to run a real coding agent,
inspect its work, recover after a restart, and preserve Loomrail's local state.

Loomrail is local-first, but it is not a security sandbox or a Git client. A live agent runs with your operating-system
account and may use the network. Loomrail creates an isolated Git worktree for a task, shows what changed, and keeps the
workflow state; it does not commit, push, or merge the agent's result.

## 1. Install and start Loomrail

Loomrail is not published to npm yet. The supported pre-alpha installation is the tarball built from this repository.
You need the Node.js version pinned in [`.nvmrc`](../../.nvmrc) and Corepack.

From a Loomrail checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm pack:release
```

The last command writes `dist-release/loomrail-<version>.tgz`. Use the filename it actually printed; the current
pre-alpha filename in the examples is `loomrail-0.0.0.tgz`. Installing globally keeps this checkout free of an
npm-generated manifest or lockfile.

On macOS:

```bash
npm install -g "/absolute/path/to/loomrail/dist-release/loomrail-0.0.0.tgz"
loomrail
```

In Windows PowerShell:

```powershell
npm install -g "D:\path\to\loomrail\dist-release\loomrail-0.0.0.tgz"
loomrail
```

Loomrail binds to an available loopback port and opens the Workbench in your default browser. If the browser should not
open automatically:

```bash
loomrail --no-open --port 4176
```

Open the printed one-time URL in a browser **on the same machine** within 60 seconds. It signs in one browser and then
stops working. `--no-open` is not remote mode: the daemon still listens only on loopback.

To run from source instead, use `pnpm dev` from the repository. This is the contributor path; it builds the whole
workspace before starting Loomrail.

Keep the terminal open. Closing the browser tab does not stop Loomrail or its queue. Press `Ctrl+C` in the terminal for
a graceful shutdown and wait for the command to exit.

## 2. Know which provider is running

The launcher names the provider before it opens the Workbench. The default is safe for a first pass:

| Value           | What happens                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| unset or `MOCK` | Deterministic test double. No external agent runs; all six stages are available.                     |
| `CODEX`         | The real `codex` CLI runs in the task's Git worktree for all six stages.                             |
| `CLAUDE_CODE`   | The real `claude` CLI serves Discovery, Plan, and Review only. Other stages stop as a Human Request. |

Values are case-sensitive. An unknown value falls back to `MOCK`; the launcher prints a warning so a successful mock
run cannot be mistaken for live work.

For Codex on macOS or another POSIX shell:

```bash
LOOMRAIL_PROVIDER=CODEX loomrail
```

For Codex in Windows PowerShell:

```powershell
$env:LOOMRAIL_PROVIDER = "CODEX"
loomrail
```

Replace `CODEX` with `CLAUDE_CODE` to use Claude Code. Install and authenticate that provider's CLI yourself before
starting Loomrail. Loomrail does not collect, store, or add provider credentials to the child process.

Start with `MOCK` even if you plan to use Codex. It confirms that installation, browser authentication, persistence,
Human Requests, budgets, and acceptance all work without spending provider quota.

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
provider. With the default provider, the mock supplies deterministic stage results; with Codex, real sessions do.

### Answer the Human Request

The mock Discovery stage opens a blocking question and the task becomes **Waiting for you**. Open it from the task or
the **Needs your decision** banner, choose an option, and select **Answer & resume**.

The request, your answer, and the resulting Decision are durable. Reloading the page or restarting Loomrail does not
erase an unanswered request.

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

- **Accept delivery** marks the task Done;
- **Return to work** records that another pass is needed;
- **Reject** records a rejected delivery.

Accepted tasks leave the Active view. Use **All issues** to see them again. Loomrail records the decision, but still
does not commit or publish any repository content.

## 4. Register your own repository

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

## 5. Run and inspect live work

Restart Loomrail with `LOOMRAIL_PROVIDER=CODEX`, confirm that the launcher says `Provider: CODEX`, and create a task in
the registered project. The brief and acceptance criteria are the durable instructions each session receives.

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

Claude Code currently cannot complete the same live route: it serves Discovery, Plan, and Review, but not Implementation
or QA. When the workflow reaches an unsupported stage, Loomrail refuses dispatch through a blocking Human Request
instead of silently switching providers.

## 6. Restart and recovery

Every launch creates a new browser bootstrap; an old authenticated tab may show that its local session ended. Start
Loomrail again and use the new tab or printed link.

Tasks, events, Decisions, budgets, Human Requests, evidence, queue entries, and workspace records live in SQLite and
survive restart. A provider process that died with the daemon is not treated as if it were still running. Loomrail
reconciles the interrupted session, preserves its durable checkpoint/context, and either continues queued work or shows
a **Recovery report** and **Resume** action for owner intervention.

The task's worktree is checked again at startup. If its directory vanished, Loomrail marks the workspace gone and does
not silently cut a replacement: a new tree could overwrite the meaning of the recorded branch and baseline.

## 7. Preserve or restore local state

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

## 8. Troubleshooting

**The page says the local session ended.** The daemon stopped or the one-time session is no longer valid. Restart
Loomrail and use the new authenticated tab. Refreshing an old tab cannot mint a new session.

**The launcher says the provider CLI was not found.** Install that CLI, authenticate it using its own instructions, and
restart Loomrail. Dispatch is refused until the selected adapter can start; it does not fall back to another provider.

**The launcher fell back to mock.** Check the exact case-sensitive value: `MOCK`, `CODEX`, or `CLAUDE_CODE`.

**A project is unusable.** Restore the repository at its registered absolute path. For a bundled demo, Settings can
offer **Repair demo repository**. Loomrail does not silently point an owner-registered Project somewhere else.

**A worktree is gone or unreadable.** Use the path, branch, and refusal shown in the task. Loomrail will not claim that
unmeasured work is intact, and it will not create a replacement worktree for the same task.

**The changed-file list is empty.** The sentence “This task has changed nothing in its worktree yet” means the read
succeeded. A missing Git executable, missing worktree, invalid baseline, or unreadable directory has its own error
instead of masquerading as an empty list.

## Current pre-alpha limits

- The package is not published and there is no desktop installer.
- The daemon is local-only; there is no remote or multi-user mode.
- One provider is selected for the daemon's whole lifetime.
- Claude Code has no validated write path for Implementation or QA.
- Loomrail does not commit, squash, push, merge, or clean up the owner's result.
- There is no supported online state export, retention UI, or portable workspace restore.
- A worktree is collision isolation, not a complete security sandbox.

For contributor setup and architecture, return to the [README](../../README.md). For packaging details, see the
[release guide](../RELEASE.md).
