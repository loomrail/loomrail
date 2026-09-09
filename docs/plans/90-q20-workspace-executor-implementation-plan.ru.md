# Q20 — Безопасное provider-neutral выполнение workspace tools: implementation plan

**Статус:** implemented; accepted private Recurkit Epic complete on macOS; Windows live evidence pending

1. Зафиксировать deep-module boundary, QA authority и residual risk в ADR/Product Decisions/Threat Model. **Done.**
2. Добавить neutral tool schemas/interface и production `@loomrail/workspace-executor`: canonical rooted paths,
   secret denylist, CAS writes/deletes, bounded reads/listing и exact Verification Plan recipes. **Done.**
3. Добавить durable WorkspaceToolCall, append-only change Events, idempotent reserve/finish и restart reconciliation
   после process-tree proof. **Done.**
4. Подключить executor к daemon-owned ProviderSession из immutable AgentRun/workspace/Plan authority. **Done.**
5. Реализовать bounded local CLI sessions Codex/Claude Code с `POST_SESSION` ledger, cancellation и strict untrusted
   stream/result validation; включить IMPLEMENT/QA capabilities. **Done.**
6. Разделить passing measured Browser QA и provider QA synthesis, сохранив failed/error correction behavior и exact
   evidence binding. **Done.**
7. Добавить unit/integration/E2E на allowed/forbidden operations, spaces/Unicode/Windows policy, both wire protocols,
   audit/replay/restart, UI states и secret absence. **Done.**
8. Не принимать live IMPLEMENT completion без успешной same-session audited write/delete и покрыть доменный отказ,
   durable hard pause и allowed path. **Done.**
9. Выполнить format/lint/typecheck/package tests, full `pnpm verify`, E2E и release artifact проверки без provider
   model calls. **Done: `pnpm verify`, 60/60 product E2E, 7/7 landing E2E и clean-install release package passed.**
10. Subscription-backed macOS/Windows dogfood выполнять только по отдельному owner approval. **Owner-approved macOS
    arm64 Codex `0.153.4` + Claude Code `2.1.260` IMPLEMENT/QA и formal 3-WorkItem private Recurkit Epic passed;
    Windows pending.**
