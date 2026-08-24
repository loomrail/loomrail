<div align="center">
  <img src="docs/assets/brand/loomrail-wordmark.svg" alt="Loomrail" width="360" />
  <p><strong>The local control plane for accountable AI software teams.</strong></p>
  <p>
    <a href="https://github.com/loomrail/loomrail/actions/workflows/ci.yml"><img src="https://github.com/loomrail/loomrail/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-5e6ad2" alt="Apache 2.0 license" /></a>
    <img src="https://img.shields.io/badge/status-pre--alpha-c58b20" alt="Pre-alpha status" />
    <img src="https://img.shields.io/badge/Node.js-24.19-43853d" alt="Node.js 24.19" />
  </p>
</div>

Loomrail is a local-first workspace for planning, running, and supervising complete software-delivery workflows
across coding agents such as Codex and Claude Code. It is designed around tasks, evidence, budgets, review, and human
decisions instead of disconnected chat sessions.

> [!IMPORTANT]
> Loomrail is an early pre-alpha. The local kernel, authenticated browser session, SQLite state, audit log, and
> cross-platform CI are real. The Workbench now runs a restart-safe synthetic Discovery → Plan workflow with a durable
> Human Request and Decision in English and Russian. Real agent execution is not available yet.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/workbench-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/workbench-light.png" />
  <img src="docs/assets/screenshots/workbench-light.png" alt="Loomrail Workbench with a Kanban delivery board and task inspector" width="100%" />
</picture>

## Why Loomrail

- **Task-centric delivery.** Keep discovery, planning, implementation, review, QA, and acceptance on one accountable
  route.
- **Local by default.** The daemon binds to loopback, state lives in local SQLite, and the browser uses a one-time
  authenticated bootstrap session.
- **Human control.** Questions, approvals, budgets, recovery decisions, and acceptance stay visible and explicit.
- **Auditable work.** Commands are idempotent and state changes are recorded as append-only events.
- **Cross-platform baseline.** macOS and Windows run the same blocking verification and browser smoke tests.

## Current checkpoint

| Area          | Today                                                                                  | Next                                           |
| ------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Local runtime | Loopback daemon, CLI launcher, one-time browser session                                | Packaged installer and release artifacts       |
| State         | Tasks, runs, stage attempts, dispatches, Human Requests, Decisions, append-only Events | Budgets, pause, and recovery reconciliation    |
| Workbench     | Persisted board, task cockpit, Attention banner, EN/RU, light/dark                     | Full Attention Inbox and richer workflow views |
| Agents        | Capability-checked provider contract and deterministic mock adapter                    | Supervised Codex/Claude adapters               |
| Platforms     | macOS and Windows CI are green                                                         | Clean-machine acceptance and hardening         |

## How it is intended to work

```mermaid
flowchart LR
  Brief[Task brief] --> Plan[Delivery plan]
  Plan --> Build[Implementation agents]
  Build --> Review[Independent review]
  Review --> QA[Browser QA and evidence]
  QA --> Accept{Human acceptance}
  Accept -->|Approved| Done[Done]
  Accept -->|Changes requested| Plan
  Guardrails[Rules · permissions · budgets] -. constrain .-> Plan
  Guardrails -. constrain .-> Build
  Guardrails -. constrain .-> Review
```

Loomrail is the control plane around this route. It does not replace the coding agents; it gives their work a shared
model, clear permissions, recoverable state, and an inspectable history.

## Run from source

There is no published npm package or desktop installer yet. The supported way to try the current checkpoint is to
run the repository from source.

### Requirements

- Node.js `24.19.x`
- Corepack
- macOS or Windows

```bash
git clone https://github.com/loomrail/loomrail.git
cd loomrail
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the workspace, starts Loomrail on an available loopback port, and opens a one-time authenticated URL
in the default browser. Stop it with `Ctrl+C`.

For a fixed port after the first build:

```bash
pnpm build
pnpm start --port 4176
```

Use `pnpm start --no-open --port 4176` when the browser should not open automatically. `LOOMRAIL_DATA_DIR` can point a
development run at an isolated data directory.

| Platform | Default local state                                   |
| -------- | ----------------------------------------------------- |
| macOS    | `~/Library/Application Support/Loomrail/state.sqlite` |
| Windows  | `%LOCALAPPDATA%\Loomrail\state.sqlite`                |

## Repository

```text
apps/
  cli/       # local launcher and authenticated browser bootstrap
  daemon/    # loopback API, commands, events, and SQLite lifecycle
  web/       # React Workbench
packages/
  contracts/          # shared schemas and transport contracts
  domain/             # deterministic WorkItem and workflow decisions
  persistence-sqlite/ # SQLite repositories, queue, and migrations
  provider-core/      # provider lifecycle and capability boundary
  provider-mock/      # deterministic synthetic provider scenarios
  workflow-engine/    # versioned workflow template validation
  ui/                 # shared product primitives and patterns
docs/        # product, architecture, security, design, plans, and evidence
```

The daemon owns state and capability boundaries. The web app never receives raw provider credentials and does not
talk directly to future agent, shell, or Git adapters.

## Roadmap

- [x] **M0 — Foundation:** monorepo, contracts, CI, public-readiness rules
- [x] **M1 — Walking skeleton:** CLI → daemon → authenticated browser UI
- [x] **M2 — Local kernel:** SQLite state, idempotent commands, append-only events, macOS/Windows gate
- [x] **M3 — Real task cockpit:** authenticated API client, persisted projects/work items, editing, EN/RU, activity
      replay and secure reconnect guidance
- [x] **M4 — Mock delivery workflow:** restart-safe dispatch queue, Human Request, Decision, and resumable task
      pipeline
- [ ] **M5 — Budgets and recovery:** explicit limits, pause/resume, crash recovery
- [ ] **M6 — Acceptance:** evidence, review, owner approval, audit surface
- [ ] **M7 — Public checkpoint:** clean install, hardening, packaging, release documentation

Real Codex/Claude execution, shell/Git access, worktrees, plugins, remote mode, and desktop packaging remain outside the
current checkpoint.

## Development

```bash
pnpm verify
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm verify` runs formatting, public-tree safety checks, linting, type checks, and the test suite. Changes to the CLI,
daemon session flow, or web shell should also pass the browser smoke test on both blocking platforms.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Product and engineering sources of truth:

- [Master plan](docs/product/MASTER-PLAN.ru.md)
- [Product decisions](docs/product/PRODUCT-DECISIONS.ru.md)
- [Architecture overview](docs/architecture/OVERVIEW.md)
- [Phase 0 implementation plan](docs/plans/00-phase-0-implementation-plan.ru.md)
- [Threat model](docs/security/THREAT-MODEL.md)
- [Component system](docs/design/COMPONENT-SYSTEM.md)
- [Brand guide](docs/design/BRAND.md)
- [Localization contract](docs/design/LOCALIZATION.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
