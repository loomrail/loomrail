# ADR-0001 — TypeScript monorepo and runtime baseline

**Status:** Accepted
**Date:** 2026-08-22

## Context

Phase 0 должна доказать daemon, persistence, WebSocket и React UI на macOS/Windows без преждевременного desktop или
native layer. Один язык и один package graph уменьшают число contracts, build systems и platform-specific failures.

На дату решения Node 24 является latest LTS, Node 26 — Current. pnpm 11 — stable line и требует Node 22+. TypeScript
7 уже выпущен как новый native compiler, но это крупная смена implementation/tooling surface; Phase 0 важнее
предсказуемая совместимость ESLint, test runners и editor tooling, чем максимальная скорость typecheck.

Primary references:

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [pnpm 11 release notes](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)
- [TypeScript release blog](https://devblogs.microsoft.com/typescript/)
- [React versions](https://react.dev/versions)
- [Vite 8 announcement](https://vite.dev/blog/announcing-vite8)
- [Tailwind CSS releases](https://tailwindcss.com/blog)
- [Fastify LTS policy](https://fastify.dev/docs/v5.10.x/Reference/LTS/)
- [Vitest releases](https://main.vitest.dev/blog)

## Decision

### Runtime and package manager

- pin Node.js `24.19.0` for Phase 0 development and CI;
- declare supported engine `>=24.19 <25` until the first compatibility matrix exists;
- pin pnpm `11.21.0` through root `packageManager` and Corepack;
- do not use Node 26 Current or pnpm 12 prerelease;
- update patch versions deliberately through a reviewed dependency change.

### Language and tooling

- TypeScript 6.x strict is the initial compiler line;
- re-evaluate TypeScript 7 after Phase 0 when ESLint, editor, declaration emit and project-reference compatibility are
  proven in this repository;
- ECMAScript modules only;
- ESLint + Prettier own lint/format policy;
- Vitest 4.x owns unit/integration tests;
- Playwright may test Loomrail's UI, but product BrowserDriver arrives later.

### Application stack

- daemon: Fastify 5.x, explicit HTTP/WS composition root and structured logging;
- validation: Zod 4.x schemas at every untrusted boundary;
- web: React 19.2 + Vite 8.1;
- server state: TanStack Query 5.x;
- routing: TanStack Router 1.x;
- styling: Tailwind CSS 4.3 backed by CSS semantic tokens;
- accessible primitives: headless Radix primitives only where native elements are insufficient;
- CLI: Node standard library argument parsing until requirements justify a CLI framework.

Exact dependency patches are recorded by the first lockfile. Major/minor lines above are the compatibility baseline,
not permission to use floating ranges in releases.

### Repository shape

```text
apps/cli -> apps/daemon + browser launcher
apps/daemon -> domain/application ports + adapters
apps/web -> contracts + ui

packages/domain              # deterministic rules; no HTTP/SQLite/provider imports
packages/contracts           # versioned wire schemas and mapping
packages/persistence-sqlite  # SQLite adapter
packages/workflow-engine     # state machine and durable dispatch
packages/provider-core       # provider port and capabilities
packages/provider-mock       # Phase 0 deterministic adapter
packages/ui                  # tokens and reusable primitives
packages/testkit             # fixtures/fake clock/builders
```

Dependency direction is inward. `domain` does not import React, Fastify, SQLite or providers. Adapters may depend on
ports/contracts; ports do not depend on adapters. Circular package dependencies fail CI.

### Deliberate omissions

- no Turborepo/Nx until plain `pnpm -r` becomes measurably insufficient;
- no Electron/Tauri/Rust in browser-first phases;
- no ORM until typed repository boundaries prove raw SQL is the bottleneck;
- no global state library before a state problem exists beyond TanStack Query and local React state;
- no component kit that dictates Loomrail's visual language.

## Consequences

### Positive

- one language and toolchain across daemon, contracts and UI;
- official binaries for macOS/Windows;
- fewer build layers and smaller contributor setup;
- contracts can be imported and validated on both sides;
- desktop shell remains replaceable.

### Costs and risks

- Node process and synchronous SQLite require explicit control of blocking work;
- TypeScript 7 adoption is intentionally delayed;
- Vite 8 uses a newer Rolldown-based build path and needs Windows CI from the first scaffold;
- Fastify/Zod integration is explicit rather than hidden behind a full-stack framework.

## Revisit when

- Phase 0 build graph becomes too slow for plain pnpm;
- TypeScript 7 ecosystem support is proven by repository CI;
- a desktop shell needs native process/security capabilities;
- a package boundary has no independent contract or tests and should be collapsed.
