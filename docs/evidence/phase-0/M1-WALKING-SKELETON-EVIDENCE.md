# Phase 0 / M1 walking skeleton evidence

**Date:** 2026-08-22
**Status:** macOS local gate complete; Windows CI execution pending first reviewed push

## 1. Accepted implementation

- strict TypeScript 6 / pnpm workspace on pinned Node.js 24.19.0 and pnpm 11.21.0;
- `apps/cli` starts the daemon and opens the browser without printing its bootstrap token;
- `apps/daemon` binds to loopback, exposes explicit live/ready endpoints, consumes a hashed one-minute bootstrap
  grant once, and issues an `HttpOnly` `SameSite=Strict` local session;
- `apps/web` exchanges the URL fragment before React rendering and removes it from the visible URL;
- versioned Zod contracts validate session, health, error, and daemon-status boundaries;
- semantic light/dark/system tokens render the same Command Center structure;
- `packages/persistence-sqlite` owns the cross-platform `node:sqlite` portability test without starting M2
  repositories or migrations early;
- pinned GitHub Actions run verification, dependency audit, SQLite portability, and browser smoke on macOS and
  Windows;
- Dependabot tracks npm and GitHub Actions updates after publication.

## 2. Local verification observed

```text
pnpm build       passed
pnpm lint        passed
pnpm typecheck   passed
pnpm test        12 tests passed across 5 test files
pnpm test:e2e    1 Chromium scenario passed
pnpm audit --prod --audit-level high
                  no known vulnerabilities
```

The browser scenario proved the full local path: one-time fragment exchange, authenticated Command Center, fragment
removal, persisted cookie session across reload, and persisted explicit dark-theme preference.

The SQLite scenario used a temporary path containing spaces and Cyrillic characters, committed a WorkItem and Event
in one transaction, created an online backup, reopened it read-only, and verified both rows.

## 3. Security finding resolved during M1

The first production dependency audit found a high-severity route-guard bypass in the initially selected
`@fastify/static` 8.x line. M1 moved directly to patched `@fastify/static` 10.1.3, rebuilt the daemon, reran its session
tests and browser path, and repeated the audit with no known vulnerabilities.

## 4. Visual review

Temporary, untracked screenshots were reviewed at 1440px in light and dark themes and at 390px in dark theme. The
layout retained readable status text, non-color status labels, visible theme controls, and no horizontal overflow.
Screenshots intentionally remain outside Git because M1 evidence does not require permanent binary artifacts.

## 5. Honest limitations and pending gate

- M1 sessions are process-local; durable session revocation belongs to M2 persistence composition.
- No mutating domain API exists yet, so CSRF enforcement starts with the first M2 command endpoint.
- No WebSocket, WorkItem state, provider, shell, Git, or product BrowserDriver behavior is enabled.
- GitHub Actions has not run because the repository remains uncommitted and unpushed by agreement.
- Windows compatibility is configured but must remain marked pending until the first real matrix run succeeds.

## 6. Repository hygiene

- no secret, `.env`, personal email, local database, browser trace, screenshot, or bootstrap token entered the tree;
- generated dependencies, builds, Playwright results, and Loomrail runtime state remain ignored;
- no commit or push was created.
