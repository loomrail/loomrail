# ADR-0002 — Relational SQLite state plus append-only audit

**Status:** Accepted with Windows CI gate
**Date:** 2026-08-22

**M2 implementation note:** the local-state module, immutable first migration, checksum validation, pre-migration
backup hook, command receipts and append-only Event triggers are implemented and verified on macOS. The original
Windows gate remains open until the first pushed CI matrix run.

## Context

Loomrail needs durable workflow state, queries for Kanban/UI, audit history, restart recovery and portable local
backups. Full event sourcing would make projections/migrations the critical path before the product has evidence that
it needs that complexity. A separate database server contradicts local-first setup.

Node 24 includes `node:sqlite` with `DatabaseSync`, prepared statements, timeout/defensive options and an online backup
API. On the decision date the module is a release candidate, so the dependency risk must be explicit.

Primary reference: [Node.js SQLite API](https://nodejs.org/api/sqlite.html).

## Decision

- current state lives in normalized relational SQLite tables;
- append-only `events` records every accepted domain mutation;
- command state, event and durable dispatch/outbox row are written in one transaction;
- `events.sequence` is the realtime/replay cursor;
- use built-in `node:sqlite` on pinned Node 24.19, without an ORM in Phase 0;
- all dynamic values use prepared statements; user input never forms SQL identifiers or fragments;
- enable `foreign_keys`, WAL, defensive mode and a bounded busy timeout explicitly;
- migrations are ordered immutable SQL files with a schema version table;
- create a backup before migrating a non-empty database;
- runtime DB lives in the platform application-data directory, never in a repository;
- raw heavy artifacts live in filesystem storage and are referenced by content metadata.

`DatabaseSync` is hidden behind a deep persistence module. Domain/application code uses repository and transaction
ports and cannot import `node:sqlite` directly.

## Transaction contract

For each command:

1. reject or return the previous result for a duplicate `commandId`;
2. load aggregate and validate expected version;
3. apply deterministic domain transition;
4. persist current state;
5. append domain Event;
6. enqueue any durable follow-up dispatch;
7. record command result;
8. commit;
9. publish committed Event to realtime subscribers.

WebSocket publication failure does not roll back state; reconnect replays from `events.sequence`.

## Spike result

The 2026-08-22 macOS arm64 spike used the checksum-verified official Node 24.19.0 binary and verified:

- file-backed database open/reopen;
- foreign-key schema;
- prepared inserts inside an explicit transaction;
- WAL mode;
- monotonic event sequence;
- online backup and read-only restore.

The same scenario also ran on the maintainer's installed Node 22.18, where `node:sqlite` is still marked experimental.
Node 22 is not selected as the project baseline.

## Gate and fallback

This ADR is not fully cleared until the identical smoke test passes on `windows-latest` with pinned Node 24.19 in CI.
If Windows installation/backup/locking fails or Node changes the RC API incompatibly before M1 closes:

1. keep repository/transaction ports unchanged;
2. compare `better-sqlite3` and a supported libSQL SQLite adapter;
3. select the smallest adapter with official/prebuilt macOS and Windows support;
4. record the replacement in a superseding ADR.

## Consequences

### Positive

- no external DB or native npm compilation step;
- simple transactional current-state queries;
- replayable audit/realtime events without full event sourcing;
- small backup/export surface;
- persistence implementation remains replaceable.

### Costs and risks

- synchronous queries can block the daemon event loop;
- RC API requires pinned runtime and compatibility tests;
- raw SQL/migrations require discipline and review;
- multi-process writers are outside MVP and must not be implied by WAL.

Mitigation: keep transactions short, paginate UI queries, measure event-loop delay, and move persistence to a worker
thread/process if evidence shows blocking beyond the local workload budget.
