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

<!-- loomrail-guided-activation-v1:start -->

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail try
```

<!-- loomrail-guided-activation-v1:end -->

`next` selects the public pre-alpha channel explicitly. The launcher binds to `127.0.0.1` and opens a one-time
authenticated `/try` URL. New projects use **Auto**, which admits only an exact verified and signed-in provider CLI,
but this guided route always requires an explicit **Mock** choice before any workflow starts. Exact live Codex and
Claude Code rows are currently scoped to macOS arm64; Windows live-provider verification remains pending. Keep the
terminal open.

The Chromium download is a one-time Browser QA prerequisite. It is isolated from your signed-in browser profile.
`loomrail try` first composes the read-only diagnostics with Chromium and Mock-route checks. A failed preflight starts
nothing and writes nothing. A ready preflight states that it will create Loomrail-owned state and logs, then starts the
loopback daemon. See the [operations guide](OPERATIONS.md) for the separate machine-readable `setup` command,
diagnostic codes, upgrade, rollback, backup, and uninstall.

Provider versions are fail-closed independently of setup. Read the
[compatibility matrix](PROVIDER-COMPATIBILITY.md) before any live-provider route.

If the browser must not open automatically:

```bash
npx loomrail try --no-open --port 4176
```

Open the printed URL in a browser on the same machine within 60 seconds. `--no-open` does not enable remote access.

To put the launcher on your `PATH` instead, run `npm install -g --ignore-scripts loomrail@next`, then
`npx playwright install chromium` and `loomrail try`. The project-local installation above is
recommended for evaluation because the selected pre-alpha channel remains visible.

The package already includes the pinned Context7 MCP server. You do not need to install it globally or run `npx` for
it; configuration remains an explicit owner action in **Settings → MCP connections** after the mock walkthrough.

## 2. Complete the mock delivery

1. Choose **Prepare demo workspace**.
2. Choose **Use Mock for this project**.
3. Create the exact guided task, then move it to **Ready**.
4. Start the guided workflow with the displayed Loomrail task budget and Fast model tier.
5. Open **Attention**, answer the blocking Human Request, and approve the explicit mock budget increase when the run
   pauses.
6. When acceptance appears in **Attention**, open its task, inspect Review and QA evidence, then accept or return the
   delivery as the owner.

The bundled web demo needs no development server. Its deterministic QA step measures Loomrail's local readiness
endpoint at the port the launcher actually selected and records screenshots and traces before opening acceptance.
The materialized Project also contains a dependency-free application baseline and exact optional task recipes; see
the [sample catalog](SAMPLES.md). Loomrail does not run that application during the Mock walkthrough.

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
