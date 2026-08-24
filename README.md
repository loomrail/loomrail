# Loomrail

**The local control plane for accountable AI software teams.**

Loomrail is a local-first, browser-first workspace for running and supervising complete software-delivery workflows
across coding agents such as Codex and Claude Code.

The product and Phase 0 boundaries are approved. The M2 local kernel now launches an authenticated browser UI through
a loopback-only daemon and persists fixture Projects, WorkItems, idempotent commands, and append-only Events in local
SQLite. It intentionally contains no real provider, shell, Git, or browser-automation capability yet.

## Run the walking skeleton

Prerequisites: Node.js 24.19.0 and Corepack. The same pinned runtime is used on macOS and Windows CI.

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install
pnpm dev
```

`pnpm dev` builds the workspace, starts Loomrail on an OS-assigned loopback port, and opens a one-time authenticated
URL in the default browser. Stop it with `Ctrl+C`. Use `pnpm start --no-open` after a build when browser opening is
not wanted. State is stored in the platform application-data directory; `LOOMRAIL_DATA_DIR` can point a development
run at an isolated local directory.

The main quality gate is `pnpm verify`; the browser smoke test is `pnpm test:e2e` after installing Chromium with
`pnpm exec playwright install chromium`.

## Product direction

- manage projects, epics, tasks, and parallel agent sessions from one Kanban workspace;
- move work through discovery, planning, implementation, independent review, browser QA, and human acceptance;
- surface questions and approvals that require human input;
- keep project rules, architecture, code style, budgets, evidence, and audit history local and inspectable;
- support light and dark themes as equal first-class interfaces;
- target solo developers and small teams, with macOS and Windows as primary platforms.

Read the current [Russian working master plan](docs/product/MASTER-PLAN.ru.md) for the approved product boundary,
architecture, delivery phases, and safety model. The
[approved decision record](docs/product/PRODUCT-DECISIONS.ru.md) captures the current product invariants, and the
[Phase 0 implementation plan](docs/plans/00-phase-0-implementation-plan.ru.md) defines the first mocked vertical
slice. A canonical English edition is required before the public launch. Contribution and repository-history rules
are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

The current technical baseline is documented in the [architecture overview](docs/architecture/OVERVIEW.md),
[ADR index](docs/adr/README.md), and [Phase 0 threat model](docs/security/THREAT-MODEL.md).

## Status

Private pre-alpha implementation under Apache License 2.0. The macOS M2 gate is green. The matching Windows gate is
configured in GitHub Actions and will become blocking after the first intentionally reviewed push.

The current Workbench is an owner-reviewed synthetic UI fixture for the upcoming M3 integration. It consumes the
authenticated daemon status, but its projects, cards, filters, inspector details, and actions are not yet backed by
the persisted WorkItem API. Unsupported command actions are disabled in this checkpoint; filters, task selection,
display settings, and theme controls remain interactive for design review. The real WorkItem integration, including
realtime replay/reconnect, is the next milestone.
