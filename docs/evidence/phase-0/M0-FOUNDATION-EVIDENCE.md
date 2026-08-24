# Phase 0 / M0 foundation evidence

**Date:** 2026-08-22
**Status:** Documentation complete; Windows runtime gate pending first CI execution

## 1. Runtime reality check

| Surface      | Observed current state                                     | M0 decision                                       |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| Node.js      | 24.19.0 latest LTS; 26 Current                             | pin 24.19.0                                       |
| pnpm         | 11 stable; 12 prerelease                                   | pin 11.21.0                                       |
| TypeScript   | 7 released with new native compiler; 6 established JS line | start on 6.x, revisit after Phase 0               |
| React        | 19.2 current documented line                               | React 19.2                                        |
| Vite         | 8.1 current stable line                                    | Vite 8.1                                          |
| Tailwind CSS | 4.3 current documented line                                | Tailwind 4.3                                      |
| Fastify      | 5.x current LTS line                                       | Fastify 5.x                                       |
| Vitest       | 4.1 current stable line                                    | Vitest 4.x                                        |
| SQLite       | `node:sqlite` release candidate with backup API            | built-in module behind adapter + CI fallback gate |

Primary sources are linked from ADR-0001 and ADR-0002.

## 2. Node binary provenance

The SQLite spike used the official Node.js distribution:

```text
node-v24.19.0-darwin-arm64.tar.xz
SHA-256 3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94
```

The checksum matched the official `SHASUMS256.txt` for Node 24.19.0.

## 3. SQLite smoke scenario

The isolated smoke scenario performed:

1. open file-backed `DatabaseSync` with bounded timeout and defensive mode;
2. enable foreign keys and WAL;
3. create current-state and append-only event tables;
4. insert state and event through prepared statements in one explicit transaction;
5. close and create an online backup;
6. reopen the backup read-only;
7. verify WorkItem row, event sequence and WAL mode.

Observed result:

```json
{
  "node": "v24.19.0",
  "workItem": { "id": "task-1", "version": 1 },
  "event": { "sequence": 1, "aggregate_id": "task-1" },
  "journalMode": { "journal_mode": "wal" }
}
```

The same functional scenario passed on installed Node 22.18, where Node emits an experimental SQLite warning. This is
supporting evidence only; Node 22 is not the chosen baseline.

## 4. Accepted M0 artifacts

- `docs/adr/0001-typescript-monorepo-baseline.md`;
- `docs/adr/0002-sqlite-state-and-audit.md`;
- `docs/adr/0003-loopback-session-security.md`;
- `docs/architecture/OVERVIEW.md`;
- `docs/security/THREAT-MODEL.md`;
- root `AGENTS.md` and `CLAUDE.md`;
- approved product decisions and Phase 0 plan.

## 5. Pending gate

The repository has not been committed or pushed, so GitHub Actions cannot yet provide Windows evidence. M1 must add
an identical Node 24.19 `node:sqlite` smoke test on `windows-latest` before persistence implementation is treated as
portable. Failure triggers the fallback comparison defined in ADR-0002; it must not be waived silently.

## 6. Safety check

- no real repository content was scanned;
- no shell/Git/provider/browser action was added to Loomrail;
- no API key or `.env` value was used;
- temporary SQLite databases and downloaded runtime stayed outside the repository;
- no commit or push was created.
