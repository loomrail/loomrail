# Getting started

> Stable for macOS Apple Silicon · [Русская версия](GETTING-STARTED.ru.md)

This route connects Loomrail to the official Codex or Claude Code CLI already installed and signed in on your
machine. It uses that CLI's existing subscription session; Loomrail does not need or accept a provider API key.
Use a fresh empty directory for the evaluation.

This Stable release supports live Codex/Claude execution on macOS Apple Silicon. Windows and Linux live-provider targets
remain unverified and fail closed; no Mock or direct API fallback is used.

## 1. Sign in to one local agent

Install an official CLI and sign in through it once:

```bash
codex login
# or
claude auth login
```

If the CLI already works locally, there is nothing else to pass to Loomrail. Loomrail checks the executable, exact
version, and login status without reading or storing the provider's session credential.

Then run the canonical install sequence:

<!-- loomrail-guided-activation-v1:start -->

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@latest
npx playwright install chromium
npx loomrail try
```

<!-- loomrail-guided-activation-v1:end -->

The command performs a read-only preflight first. A missing, incompatible, or signed-out CLI, an invalid
`LOOMRAIL_PROVIDER` override, missing Chromium, or an unsafe local state upgrade blocks startup and writes nothing.
When ready, it states the local side effects, binds the daemon to `127.0.0.1`, and opens a one-time authenticated
browser URL.

Use `npx loomrail setup --mode live` for the preflight alone or `npx loomrail doctor` for the detailed report.

## 2. Create the guided task

1. Choose **Prepare demo workspace**.
2. In **Settings → AI provider**, select **Codex CLI**, **Claude Code CLI**, or leave **Auto** enabled.
3. Create the displayed task and move it to **Ready**.
4. Review the displayed token budget and model tier, then start the workflow.
5. Answer any durable Human Request in **Attention** and review any budget change before approving it.
6. Inspect provider evidence before making an owner decision.

Both local adapters serve all six stages, including Implementation and QA. They never receive the repository path or
inherit project secrets. File and command access goes through Loomrail's bounded workspace tools with explicit
permissions, limits, audit records, and measured evidence. Provider prose is not proof that a file changed or a test
ran.

The local CLIs report token usage after a session. Loomrail can stop work by elapsed time, turn count, tool count and
output size, and can block later sessions from its durable ledger, but it cannot promise an exact token stop inside
the current CLI session.

## 3. Stop and resume

Keep the launch terminal open and press `Ctrl+C` to stop Loomrail. Workflow state, requests, budgets, and evidence are
stored in local SQLite and survive restart. The browser is delivery only; it is never the source of workflow truth.

For a no-open launch:

```bash
npx loomrail try --no-open --port 4176
```

Open the printed URL on the same machine within 60 seconds. This does not enable remote access.

Before using a real repository, read the [owner guide](USER-GUIDE.md), [local provider compatibility](PROVIDER-COMPATIBILITY.md),
[Browser QA guide](BROWSER-QA.md), and [threat model](../security/THREAT-MODEL.md).
