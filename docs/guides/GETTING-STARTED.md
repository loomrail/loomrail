# Loomrail quick start

> Public pre-alpha · [Русская версия](GETTING-STARTED.ru.md) · [Owner guide](USER-GUIDE.md)

This is the shortest safe route from an empty directory to a persisted mock delivery. You will explicitly choose
Mock before starting the workflow, so it starts no Codex or Claude Code process, touches no existing repository, and
spends no provider quota.

## Requirements

- Node.js `>=24.19 <25`
- macOS or Windows; Linux is best effort
- a browser on the same machine
- the isolated Chromium build installed explicitly by Playwright

Check Node before installing:

```bash
node --version
```

## 1. Install and start

Create a separate evaluation directory. Do not begin inside a repository you care about.

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail setup
npx loomrail start
```

`next` selects the public pre-alpha channel explicitly. The launcher binds to `127.0.0.1` and opens a one-time
authenticated URL. New projects use **Auto**, which can find an installed, signed-in provider CLI; the next section
switches the demo project to **Mock** before any workflow starts. Keep the terminal open.

The Chromium download is a one-time Browser QA prerequisite. It is isolated from your signed-in browser profile. In
the setup prompt, press Enter for the recommended **Mock walkthrough**. Setup composes the read-only diagnostics with
the Chromium and route checks; it changes and persists nothing. A new database or missing live-provider login is safe
for the Mock route. See the [operations guide](OPERATIONS.md) for machine-readable setup, diagnostic codes, upgrade,
rollback, backup, and uninstall.

If the browser must not open automatically:

```bash
npx loomrail --no-open --port 4176
```

Open the printed URL in a browser on the same machine within 60 seconds. `--no-open` does not enable remote access.

To put the launcher on your `PATH` instead, run `npm install -g --ignore-scripts loomrail@next`, then
`npx playwright install chromium`, `loomrail setup`, and `loomrail start`. The project-local installation above is
recommended for evaluation because the selected pre-alpha channel remains visible.

The package already includes the pinned Context7 MCP server. You do not need to install it globally or run `npx` for
it; configuration remains an explicit owner action in **Settings → MCP connections** after the mock walkthrough.

## 2. Complete the mock delivery

1. Choose **Initialize demo workspace**.
2. Open **Settings → AI provider**, choose **Mock**, and close Settings.
3. Create a task with a concrete outcome and observable acceptance criteria.
4. Move it to **Ready**, then choose **Start workflow**.
5. Open **Attention**, answer the blocking Human Request, and approve the explicit mock budget increase when the run
   pauses.
6. When acceptance appears in **Attention**, open its task, inspect Review and QA evidence, then accept or return the
   delivery as the owner.

The bundled web demo needs no development server. Its deterministic QA step measures Loomrail's local readiness
endpoint at the port the launcher actually selected and records screenshots and traces before opening acceptance.

Reloading the page or restarting Loomrail does not erase the task, request, Decision, budget, evidence, or acceptance
state. Stop Loomrail with `Ctrl+C` and wait for the command to exit.

**Attention** is global: its badge and list include every Project, regardless of which Project is selected on the
board. Arrow keys move through the list. Ordinary questions can be answered there; final acceptance always opens the
exact Task Cockpit so its evidence and consequences remain visible.

## Optional: create a fresh project

Open **Settings → Projects → Create a new project**, enter an absolute path whose final directory does not exist, and
choose **Review exact files**. Check the canonical target, built-in recipe version, complete file list, and proposal
digest before selecting **Create this project**. Loomrail creates those files, writes its recovery marker, initializes
Git, verifies the repository, and selects the Project.

It does not install dependencies, run generated code, create a commit, add a remote, or push. Open the created
directory in your terminal and run `pnpm install`, then `pnpm test`, only when you are ready. If publication stops,
Settings restores the same durable operation after reload; resolve the named local conflict and choose **Retry
safely**. Loomrail never clears the directory automatically.

## After the first run

Continue with the [owner guide](USER-GUIDE.md) before registering a repository or enabling a live provider. It covers
Project Constitution review, Context7/MCP setup, task worktrees, change inspection, recovery, backup, and
troubleshooting. Read the
[threat model](../security/THREAT-MODEL.md) before exposing sensitive code to an agent: a worktree isolates task files,
but it is not an operating-system sandbox.
