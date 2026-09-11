<div align="center">
  <img src="docs/assets/brand/loomrail-wordmark.svg" alt="Loomrail" width="360" />
  <p><strong>AI agents work. You decide.</strong></p>
  <p>
    <a href="https://loomrail.github.io/loomrail/">Website</a> ·
    <a href="docs/guides/GETTING-STARTED.md">Quick start</a> ·
    <a href="docs/guides/GETTING-STARTED.ru.md">Быстрый старт</a> ·
    <a href="docs/README.md">Documentation</a> ·
    <a href="ROADMAP.md">Roadmap</a>
  </p>
  <p>
    <a href="https://github.com/loomrail/loomrail/actions/workflows/ci.yml"><img src="https://github.com/loomrail/loomrail/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-6173ff" alt="Apache 2.0 license" /></a>
    <img src="https://img.shields.io/badge/status-stable-2f6b52" alt="Stable status" />
    <img src="https://img.shields.io/badge/Node.js-24.19-43853d" alt="Node.js 24.19" />
  </p>
</div>

Loomrail is a local control plane for AI-assisted software work. It keeps the task brief, workflow state, Human
Requests, budgets, evidence, and final owner decision durable across agent sessions instead of treating chat history as
the source of truth.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/workbench-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/workbench-light.png" />
  <img src="docs/assets/screenshots/workbench-light.png" alt="Loomrail Workbench showing delivery state, a task contract, and owner activity" width="100%" />
</picture>

> [!IMPORTANT]
> Loomrail is Stable software for macOS on Apple Silicon. New projects use **Auto**, which selects only a
> compatible, signed-in local
> Codex CLI or Claude Code CLI. Loomrail does not ask for provider API keys or use separate API billing; a missing,
> incompatible, or signed-out CLI blocks startup instead of falling back. Loomrail never creates provider credentials,
> enables permission-bypass flags, commits, pushes, merges, or deploys for you. A task worktree is not an
> operating-system sandbox. Windows and Linux live-provider execution is not supported by this release and fails closed;
> Windows remains covered by source, browser and clean-install CI while its real local-CLI evidence is pending.

## Install and run safely

Requirements: Node.js `>=24.19 <25`, macOS on Apple Silicon, a browser on the same machine, the isolated Chromium build
managed by the installed Playwright package, and at least one official local agent CLI already signed in:

- Codex: install the official CLI and run `codex login` once; or
- Claude Code: install the official CLI and run `claude auth login` once.

That login remains owned by the provider CLI. Loomrail detects it read-only and never asks you to copy an API key.
Windows and Linux are not supported live-provider targets in this macOS-scoped Stable release.

Start in a new empty directory, not inside a repository you care about:

<!-- loomrail-guided-activation-v1:start -->

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@latest
npx playwright install chromium
npx loomrail try
```

<!-- loomrail-guided-activation-v1:end -->

The Chromium download is an explicit one-time installation for deterministic Browser QA. Loomrail never reuses your
signed-in browser profile. `loomrail try` first checks the local CLI version and login read-only. If a required check
fails it writes nothing and tells you whether to install, update, or sign in to that CLI. When ready, it states the
local state/log side effects, starts the loopback daemon, and opens the guided route. Each later mutation remains a
visible owner action.

The launcher binds to `127.0.0.1`, opens a one-time authenticated URL, and stores state in local SQLite. Keep the
terminal open and stop Loomrail with `Ctrl+C`.

If the browser must not open automatically:

```bash
npx loomrail try --no-open --port 4176
```

Open the printed URL on the same machine within 60 seconds. `--no-open` does not enable remote access.

For a global launcher, use `npm install -g --ignore-scripts loomrail@latest`, run
`npx playwright install chromium`, and then `loomrail try`.
The project-local route above is recommended because it keeps Loomrail and its browser runtime isolated.

## First run

1. Choose **Prepare demo workspace**.
2. Choose **Codex CLI** or **Claude Code CLI** for this project.
3. Create the exact guided task and move it to **Ready**.
4. Start the guided workflow with the displayed Loomrail budget and model tier.
5. Open **Attention**, answer any blocking Human Request, and review every explicit budget change.
6. When acceptance appears in **Attention**, open its exact task, inspect Review and QA evidence, then accept the
   delivery or return it to work as the owner.

The bundled web demo needs no second server: its deterministic QA step measures Loomrail's own local readiness
endpoint on the selected port. Your repositories use an explicit `.loomrail/browser-qa.json` plan; see the
[Browser QA guide](docs/guides/BROWSER-QA.md).

The task, request, budget, evidence, and decision survive page reloads and Loomrail restarts. The
[quick start](docs/guides/GETTING-STARTED.md) walks through the route in detail.

## Your repository and providers

The guides explain repository registration, Project Constitution review, task worktrees,
change inspection, backup, recovery, diagnostics, upgrade, and uninstall:

- [Owner guide](docs/guides/USER-GUIDE.md)
- [Руководство владельца](docs/guides/USER-GUIDE.ru.md)
- [Operations guide](docs/guides/OPERATIONS.md) · [Эксплуатация](docs/guides/OPERATIONS.ru.md)
- [Provider compatibility](docs/guides/PROVIDER-COMPATIBILITY.md) · [Совместимость провайдеров](docs/guides/PROVIDER-COMPATIBILITY.ru.md)
- [Bundled samples and roles](docs/guides/SAMPLES.md) · [Встроенные примеры и роли](docs/guides/SAMPLES.ru.md)
- [Reproducible full-route example](docs/examples/full-route/README.md)
- [Security and trust boundaries](docs/security/THREAT-MODEL.md)

Install and sign in to an official provider CLI, then start Loomrail normally. In **Settings → AI provider**, use
**Check again** to refresh readiness. Auto considers only compatible and authenticated local runtimes. An explicit
unavailable provider remains visible and fails closed. `LOOMRAIL_PROVIDER` remains an optional process-wide override
for automation and troubleshooting, but it does not bypass version checks, login, stage support, permissions, or
budgets.

Context7 is different from an AI provider: its exact-pinned MCP server ships with Loomrail. In **Settings → MCP
connections**, choose **Review bundled Context7**; no global install or `npx` command is needed. Loomrail still requires
you to approve the exact local process and grant its two read-only tools. Context7 documentation queries leave your
machine, so never include secrets, personal data, or proprietary code.

## Current boundary

- Local browser UI, loopback daemon, and local SQLite state.
- Explicit selection between the locally installed Codex CLI and Claude Code CLI, with no API-key route or synthetic
  runtime fallback.
- All six stages, including `IMPLEMENT` and `QA`, use the real selected local agent. Repository access goes only
  through Loomrail's bounded workspace tools, and provider text alone is never treated as file or test evidence.
- Local CLI token usage is reconciled after a session. Loomrail enforces time, turn, tool and output limits during
  execution and can block later work from the durable ledger, but cannot promise an exact stop at a token boundary
  inside the current provider session.
- Up to three agent runs in parallel by default, with durable global, Project, provider, and workspace gates plus an
  Agent Fleet view of active roles and exact queue reasons.
- Project-scoped local MCP connections and a bundled, owner-approved Context7 preset.
- A global, restart-safe Attention Inbox for Human Requests and acceptance deep-links across every Project.
- A typed read-only tool SDK at `loomrail/plugin-sdk`; local registration still uses explicit C1 consent and grant.
- Existing-repository registration, readiness checks, per-task worktrees, change inspection, and owner-approved
  Project Constitution.
- Explicit new-project creation from a fixed local recipe, with exact file review, durable recovery, and local Git
  initialization. Loomrail does not install dependencies or create a commit.
- No desktop installer, remote access, cloud sync, team accounts, automatic Git publishing, or complete OS sandbox.

The versioned product scope lives in [Product decisions](docs/product/PRODUCT-DECISIONS.ru.md) and the
[Master plan](docs/product/MASTER-PLAN.ru.md). Historical implementation plans remain under `docs/plans/`; they are
engineering records, not a public roadmap.

## Develop from source

```bash
git clone https://github.com/loomrail/loomrail.git
cd loomrail
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the workspace, starts Loomrail on loopback, and opens a one-time authenticated browser session.

Before contributing:

```bash
pnpm verify
pnpm exec playwright install chromium
pnpm test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture overview](docs/architecture/OVERVIEW.md), and the
[release guide](docs/RELEASE.md). Plugin authors should start with the
[Plugin SDK guide](docs/guides/PLUGIN-SDK.md) or its [Russian version](docs/guides/PLUGIN-SDK.ru.md).
Use the [structured issue chooser](https://github.com/loomrail/loomrail/issues/new/choose) for reproducible bugs or
bounded product proposals; suspected vulnerabilities belong in the [private security channel](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
