<div align="center">
  <img src="docs/assets/brand/loomrail-wordmark.svg" alt="Loomrail" width="360" />
  <p><strong>AI agents work. You decide.</strong></p>
  <p>
    <a href="https://loomrail.github.io/loomrail/">Website</a> ·
    <a href="docs/guides/GETTING-STARTED.md">Quick start</a> ·
    <a href="docs/guides/GETTING-STARTED.ru.md">Быстрый старт</a> ·
    <a href="docs/README.md">Documentation</a>
  </p>
  <p>
    <a href="https://github.com/loomrail/loomrail/actions/workflows/ci.yml"><img src="https://github.com/loomrail/loomrail/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-6173ff" alt="Apache 2.0 license" /></a>
    <img src="https://img.shields.io/badge/status-pre--alpha-c58b20" alt="Pre-alpha status" />
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
> Loomrail is public pre-alpha software. The recommended first run uses a deterministic mock: it starts no external
> agent and spends no provider quota. Live providers are opt-in. Loomrail never commits, pushes, merges, or deploys
> agent changes for you, and a task worktree is not an operating-system sandbox.

## Install and run safely

Requirements: Node.js `>=24.19 <25`, macOS or Windows, and a browser on the same machine. Linux is best effort.

Start in a new empty directory, not inside a repository you care about:

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install loomrail@next
npx loomrail
```

The launcher binds to `127.0.0.1`, opens a one-time authenticated URL, and stores state in local SQLite. Keep the
terminal open and stop Loomrail with `Ctrl+C`.

If the browser must not open automatically:

```bash
npx loomrail --no-open --port 4176
```

Open the printed URL on the same machine within 60 seconds. `--no-open` does not enable remote access.

For a global launcher, use `npm install -g loomrail@next` and then `loomrail`. The project-local route above is
recommended for evaluation because it keeps the selected pre-alpha channel visible.

## First run

1. Choose **Initialize demo workspace**.
2. Create a task with a concrete outcome and observable acceptance criteria.
3. Move it to **Ready** and start the workflow.
4. Answer the blocking Human Request and approve the explicit mock budget increase.
5. Inspect Review and QA evidence.
6. Accept the delivery or return it to work as the owner.

The task, request, budget, evidence, and decision survive page reloads and Loomrail restarts. The
[quick start](docs/guides/GETTING-STARTED.md) walks through the route in detail.

## Your repository and live providers

After the mock route works, the owner guide explains repository registration, Project Constitution review, task
worktrees, change inspection, backup, and recovery:

- [Owner guide](docs/guides/USER-GUIDE.md)
- [Руководство владельца](docs/guides/USER-GUIDE.ru.md)
- [Reproducible full-route example](docs/examples/full-route/README.md)
- [Security and trust boundaries](docs/security/THREAT-MODEL.md)

Live providers are explicit. Install and authenticate the provider CLI yourself, then start the same Loomrail
installation with `LOOMRAIL_PROVIDER=CODEX` or `LOOMRAIL_PROVIDER=CLAUDE_CODE`. Read the owner guide and threat model
before exposing a repository to either CLI.

## Current boundary

- Local browser UI, loopback daemon, and local SQLite state.
- Deterministic mock-first workflow with durable Human Requests, budgets, evidence, recovery, and owner Decisions.
- Local Git repository registration, per-task worktrees, change inspection, and owner-approved Project Constitution.
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
[release guide](docs/RELEASE.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
