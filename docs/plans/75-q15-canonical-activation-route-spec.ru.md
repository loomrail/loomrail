# Q15 — Canonical activation route

**Дата:** 2026-09-04

**Статус:** approved for implementation; protected landing consumer remains a separate gate

**Предшественники:** Q6, Q8, Q10, Q14

**Нормативные решения:** PD-003, PD-009, PD-016, UXD-005, UXD-007, SD-003, T04, T13, T23, T42

## 1. Outcome

Новый пользователь проходит один понятный zero-quota маршрут от безопасной установки до настоящего durable
Acceptance Package. Канонический contract содержит exact install commands и одну versioned demo Task recipe; CLI,
Workbench, README и RU/EN guides потребляют либо проверяют именно его, а не поддерживают независимые копии.

Q15 не превращает слово `try` в скрытый installer. Chromium остаётся отдельным явным действием владельца. Команда
`loomrail try` сначала выполняет read-only Q8 Mock preflight и только при `READY` запускает обычный loopback daemon,
создаёт обычный local state/log lifecycle и открывает `/try`. Provider login, dependency install, repository write,
agent run и acceptance не происходят без следующих видимых действий владельца.

## 2. Deep module и canonical contract

Внешний seam Q15 — один runtime-validated `GuidedActivationContract` в `@loomrail/contracts`. Он скрывает:

- public install sequence для `loomrail@next`;
- id/version zero-quota mission;
- exact Q10 fixture и Task recipe;
- bounded Mock budget/model policy;
- стабильный idempotency key создания одной demo Task.

Contract хранится как JSON рядом с schema, чтобы TypeScript consumers и standard-library repository verifier читали
один источник. Изменить команды, recipe или policy можно только новой contract version либо reviewed совместимым
изменением текущей pre-alpha revision. Verifier сравнивает marked blocks README и RU/EN quick start, а также exact
Q10 recipe. Protected `apps/landing/**` остаётся отдельным consumer: текущий срез не меняет, не форматирует и не
исключает его из проверок.

## 3. CLI contract

Launcher принимает `loomrail try [--no-open] [--port N]` с теми же portable port/open semantics, что `start`.

1. Запускается `collectSetupReadiness("MOCK")` без TTY prompt.
2. `BLOCKED` печатает bounded Q8 report, ничего не запускает и возвращает exit code `1`.
3. `READY` явно сообщает, что дальше будут созданы local state/logs и запущены daemon/browser.
4. Обычный daemon стартует без provider override и открывает `/try#bootstrap=...`.
5. При `--no-open` exact one-time URL печатается владельцу; token не попадает в operational log.

`setup` сохраняет прежнюю zero-write/zero-launch семантику. `try` не устанавливает Chromium, не логинит provider и
не запускает workflow автоматически.

## 4. `/try` mission

Mission — deterministic projection уже существующих durable сущностей, а не вторая state machine и не browser
localStorage:

1. materialised `web-app-a` Project;
2. explicit Project Provider Preference `MOCK`;
3. одна idempotently созданная Task из canonical Q10 recipe с непустым brief/criteria;
4. переход Task `BACKLOG -> READY`;
5. старт существующего workflow с canonical Mock budget/model policy;
6. Human Request/Review/QA/Acceptance состояния существующего PipelineRun;
7. owner `Accept | Return | Reject` только в Task Cockpit.

После reload/restart `/try` заново выводит progress из Project, WorkItem и Workflow reads. Query `task` лишь выбирает
конкретную durable Task; если он отсутствует, UI находит newest non-cancelled exact-recipe Task. Provider output,
browser storage и marketing progress не могут отметить шаг завершённым.

Каждый экран показывает один текущий outcome и primary action. Он не дублирует формы Attention или Acceptance:
вместо этого ведёт в существующую authoritative surface. Завершение предлагает три честных направления: продолжить
local Community, подключить собственный repository/provider или прочитать про bounded Guided Launch. Q15 не создаёт
платёж, account, lead form или обещание поддержки.

## 5. Security и recovery

- JSON contract runtime-validated и bounded; unknown fields fail closed.
- Demo Task создаётся существующей `CREATE_WORK_ITEM` command с fixed mission command id, поэтому lost response/retry
  возвращает тот же result, а не создаёт дубль.
- Остальные действия используют существующие optimistic-versioned commands, session/Origin/CSRF и audit Events.
- `/try` не получает новой filesystem/shell/Git/provider authority.
- Mock preference применяется отдельной явной кнопкой до workflow start; active/invalid `LOOMRAIL_PROVIDER` уже
  блокируется Q8 preflight.
- Bootstrap token остаётся fragment-only, одноразовым и удаляется до render.
- Windows использует тот же argv/parser/path contract; Q15 не требует live-provider Windows evidence.

## 6. Acceptance criteria

1. Один strict contract управляет install block, exact sample recipe и demo run policy; mutation/unknown/unsafe data
   отклоняются.
2. README и RU/EN quick start содержат один exact marked install block; Q10 recipe совпадает с contract.
3. `loomrail try` fail closed при blocked Mock preflight и открывает/печатает exact `/try` bootstrap URL только после
   `READY`.
4. `/try` создаёт непустую canonical Task idempotently, требует explicit Mock, Ready и Start actions и не создаёт
   собственную workflow truth.
5. Reload и daemon restart восстанавливают шаг из durable state; stale URL/task input не создаёт ложный progress.
6. Mission показывает Human Request, measured Review/QA и owner Acceptance как отдельные gates и никогда не принимает
   результат самостоятельно.
7. EN/RU, keyboard, light/dark и narrow viewport проходят Browser QA; packaged `try --no-open` проходит clean
   macOS/Windows lane.
8. `apps/landing/**` не изменяется. Q15 exit gate остаётся открытым, пока protected landing не подключён к contract и
   его собственный lint/browser gate не станет зелёным.

## 7. Non-goals

- provider login, live run или quota consumption;
- скрытая установка Node/npm package/Chromium/dependencies;
- новый workflow engine, Acceptance authority или ActivationMission table;
- automatic repository tests, Q16 allowance или Q17 Verification Plan;
- analytics, account, billing, lead collection или network telemetry;
- изменение protected landing, npm publish, tag, dist-tag или GitHub Release.
