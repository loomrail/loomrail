# Loomrail Phase 0 / M4 — mock workflow and Human Request

Status: locally complete, awaiting the next checkpoint.

## Outcome

M4 добавляет первый реальный, но полностью синтетический delivery loop:

```text
Ready WorkItem
  → durable START dispatch
  → Discovery / WAITING_HUMAN
  → durable single-choice HumanRequest
  → Decision + durable RESUME dispatch
  → Discovery succeeded
  → Plan succeeded
```

Это проверяет orchestration semantics до подключения опасных provider, shell, Git или browser capabilities.

## Delivered

- versioned WorkflowTemplate validation и bounded `mock-delivery-v1` template;
- PipelineRun и StageAttempt state machines;
- SQLite migration для templates, runs, attempts, dispatch queue, HumanRequest и Decision;
- capability-validated `provider-core` contract и deterministic `provider-mock` Scenario A;
- startup drain для незавершённых mock dispatches;
- атомарный `Answer & resume`, single-resolution guard и append-only Decision;
- task inspector с workflow rail, Human Request answer controls и localized EN/RU copy;
- project Attention banner для blocking requests;
- workflow events в существующем task timeline;
- domain, persistence, daemon integration и browser E2E coverage.

## Explicit boundaries

- M4 template специально ограничен `DISCOVERY → PLAN`; `IMPLEMENT → REVIEW → QA → ACCEPTANCE` появятся в следующих
  milestones вместе с budgets, recovery и final acceptance semantics.
- Provider — deterministic mock fixture. Реальные Codex/Claude sessions не запускаются.
- Нет shell, Git, worktree, filesystem mutation или remote networking.
- WorkItem не становится `DONE`: финальная authority остаётся за M6 acceptance.
- Attention Inbox пока представлен project-level blocking banner и task cockpit, без отдельной полноэкранной страницы.

## Evidence

- HumanRequest и Decision переживают закрытие/reopen SQLite state;
- daemon restart восстанавливает `WAITING_HUMAN` без transient памяти;
- второй answer получает conflict и не создаёт вторую Decision;
- ответ возобновляет тот же StageAttempt через durable `RESUME` dispatch;
- независимый WorkItem остаётся в своём state;
- E2E проверяет start → reload → answer → completed timeline;
- `pnpm verify` и `pnpm test:e2e` являются release gate checkpoint.
