# Loomrail Phase 0 / M5 — budgets, pause and recovery

Status: locally complete, verified against `0df5e8e`.

## Outcome

M5 превращает mock workflow из happy-path демонстрации в управляемую и восстанавливаемую локальную оркестрацию:

```text
Discovery → HumanRequest → Plan → Implement
  → usage 50% / 80% / 95% / 100%
  → HARD_PAUSED
  → explicit budget override
  → new Implement attempt
  → completed mock pipeline
```

Параллельно любой активный run получает явные `Pause`, `Resume` и `Cancel`, а orphaned `RUNNING` attempt после
рестарта не запускается повторно автоматически: он становится `INTERRUPTED` и попадает в Recovery Report.

## Locked contracts

- default mock budget: `100` estimated token units;
- immutable usage increments: `50`, `30`, `15`, `5`;
- warning thresholds: `50%`, `80%`, `95%`; hard limit: `100%`;
- каждый threshold event записывается ровно один раз на policy revision;
- hard pause блокирует обычный Resume;
- override создаёт новую immutable BudgetPolicy revision и новый StageAttempt, не переписывая историю;
- manual Pause переводит текущий attempt в `SOFT_PAUSED`; Resume создаёт durable `RESUME` dispatch;
- Cancel завершает run и текущий attempt как `CANCELLED`, не создавая новый dispatch;
- dispatch сначала атомарно переводит attempt в `RUNNING`, и только потом вызывает mock provider;
- startup reconciliation переводит orphaned `RUNNING` в `INTERRUPTED`, закрывает его dispatch как failed и создаёт
  append-only RecoveryReport;
- `WAITING_HUMAN`, `QUEUED` и terminal states при рестарте не мутируют;
- продолжение `INTERRUPTED` возможно только явной командой Resume;
- migrations `0003`/`0004` обязаны использовать существующий pre-migration SQLite backup hook; `0004` backfill-ит
  старые M4 `PIPELINE_STARTED` events до нового BudgetPolicy contract.

## UI checkpoint

Task inspector показывает:

- текущий budget, usage и последний достигнутый threshold;
- явный badge для `SOFT_PAUSED`, `HARD_PAUSED` и `INTERRUPTED`;
- доступные по состоянию действия Pause / Resume / Cancel;
- Budget override только для hard pause;
- Recovery Report с причиной и временем восстановления;
- одинаковые EN/RU строки и отсутствие ложного optimistic success.

## Delivered

- versioned budget, usage, pause, override and recovery contracts;
- deterministic Scenario B with immutable `50 / 30 / 15 / 5` usage records and one-shot threshold events;
- explicit Pause / Resume / Cancel commands with optimistic version checks and idempotent receipts;
- hard-pause guard plus immutable policy revision and new Implement attempt after override;
- startup reconciliation for orphaned running attempts without automatic replay;
- append-only SQLite policies, usage and recovery reports;
- compatibility backfill for M4 events and command receipts before the stricter M5 contracts are read;
- localized desktop/mobile workflow controls, budget meter, recovery status and activity events.

## Explicit boundaries

- только deterministic mock provider;
- никаких реальных provider sessions, shell, Git, worktree, filesystem mutation или remote networking;
- budget units в M5 синтетические и имеют quality `LOOMRAIL_ESTIMATE`;
- завершённый M5 pipeline не переводит WorkItem в `DONE`: acceptance authority остаётся за M6.

## Release evidence

- 104 unit/integration tests cover threshold monotonicity, pause/resume/cancel, hard-pause guard, idempotency,
  restart persistence, migration backup/backfill and daemon Scenario B/C;
- 7/7 browser E2E tests pass, including hard pause → override → completion;
- manual Chrome review passed for desktop, 390 px mobile, light/dark, EN/RU, overflow and application console;
- `pnpm verify`, `pnpm test:e2e` and `git diff --check` pass on Node `24.19.0`;
- final Standards/Spec review against `0df5e8e` found and fixed the M4 `PIPELINE_STARTED`/command-receipt
  compatibility gap; no remaining blocking findings.
