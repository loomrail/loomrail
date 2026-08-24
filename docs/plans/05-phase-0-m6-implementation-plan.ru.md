# Loomrail Phase 0 / M6 — evidence and owner acceptance

Status: implemented and verified on 2026-08-24.

## Outcome

M6 завершает Phase 0 mock delivery loop явным acceptance gate:

```text
Implement → Review artifact → QA artifact → AcceptancePackage
  → blocking owner request
  → Accept → WorkItem DONE
  → Return / Reject → WorkItem BLOCKED
```

Ни provider, ни daemon не могут перевести WorkItem в `DONE` без отдельной human command.

## Locked contracts

- Review и QA создают typed append-only artifacts, а не строки в transient UI;
- AcceptancePackage связывает каждый acceptance criterion с implementation summary, review artifact, QA artifact,
  verification instruction и known-risk field;
- package создаётся только после успешных Review и QA;
- pending package всегда имеет durable blocking HumanRequest;
- final action — `ACCEPT`, `RETURN_TO_WORK` или `REJECT`;
- только `ACCEPT` переводит WorkItem в `DONE` и завершает PipelineRun как `SUCCEEDED`;
- `RETURN_TO_WORK` и `REJECT` закрывают текущий run как `FAILED` и оставляют WorkItem в `BLOCKED` для явного
  следующего решения; автоматического повторного исполнения нет;
- acceptance command versioned и idempotent; повтор с тем же command ID не создаёт duplicate Decision/Event;
- обычный `MOVE_WORK_ITEM → DONE` остаётся запрещён;
- все artifacts, package, request, decision, usage и workflow events используют тот же WorkItem correlation trail.

## UI checkpoint

- inspector показывает Review/QA evidence и минимальную criterion matrix;
- pending acceptance имеет три явные owner actions без optimistic success;
- activity различает artifact creation, acceptance requested и final resolution;
- EN/RU, light/dark, desktop/mobile и keyboard states остаются согласованными;
- compact command summary показывает needs-you, active и at-risk counts без отдельного vanity dashboard.

## Explicit boundaries

- artifacts полностью синтетические и не утверждают, что реальный diff или browser run был проверен;
- реальных provider sessions, shell, Git, filesystem mutation и remote networking всё ещё нет;
- Return/Reject в M6 не запускают новый pipeline автоматически;
- release/deploy/merge не выполняются acceptance command.

## Release evidence

- domain tests на package prerequisites и все три owner actions;
- SQLite tests на artifact immutability, package versioning, idempotency и restart persistence;
- daemon Scenario D integration test;
- E2E полного mock flow до `DONE` только после Accept;
- `pnpm verify`, `pnpm test:e2e`, manual browser review и Standards/Spec review относительно `32da5f0`.

Итоговая запись проверки: [`M6-ACCEPTANCE-EVIDENCE.md`](../evidence/phase-0/M6-ACCEPTANCE-EVIDENCE.md).
