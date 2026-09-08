# Q15 — Canonical activation route

**Дата:** 2026-09-04

**Последнее уточнение:** 2026-09-08 — local subscription CLI boundary

**Статус:** implemented; fresh fixed-commit evidence pending

**Предшественники:** Q6, Q8, Q10, Q14, Q20

**Нормативные решения:** PD-003, PD-009, PD-016, PD-019, UXD-005, UXD-007, SD-003, T04, T13, T23,
T42, T49

## 1. Outcome

Новый пользователь проходит один понятный маршрут от безопасной установки до настоящего durable Acceptance
Package. Loomrail использует уже установленный и авторизованный Codex CLI или Claude Code CLI и его подписочную
сессию: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, отдельный API-биллинг и production Mock в маршрут не входят.

Канонический contract содержит exact install commands и одну versioned real-execution Task recipe. CLI, Workbench,
landing, README и RU/EN guides потребляют либо проверяют именно его, а не поддерживают независимые копии.

`loomrail try` не является скрытым installer. Chromium, provider install и provider login остаются отдельными явными
действиями владельца. Команда сначала выполняет read-only live-provider preflight и только при `READY` запускает
обычный loopback daemon, создаёт обычный local state/log lifecycle и открывает `/try`. Repository write, agent run и
Acceptance не происходят до следующих видимых действий владельца.

## 2. Deep module и canonical contract

Внешний seam Q15 — один runtime-validated `GuidedActivationContract` в `@loomrail/contracts`. Он скрывает:

- public install sequence для `loomrail@next`;
- id/version bounded local-CLI mission;
- exact bundled fixture и Task recipe;
- pipeline и per-AgentRun token caps плюс model tier;
- стабильный idempotency key создания одной demo Task.

Contract хранится как JSON рядом со schema. TypeScript consumers и standard-library repository verifier читают один
источник. Изменить команды, recipe или policy можно только новой contract version либо reviewed совместимым изменением
текущей pre-alpha revision. Verifier сравнивает marked blocks README и RU/EN quick start, CLI help, exact fixture
recipe и protected landing consumer.

## 3. CLI contract

Launcher принимает `loomrail try [--no-open] [--port N]` с теми же portable port/open semantics, что `start`.

1. Запускается `collectSetupReadiness("LIVE")` без TTY prompt.
2. `BLOCKED` печатает bounded readiness report, ничего не запускает и возвращает exit code `1`.
3. `READY` явно сообщает, что дальше будут созданы local state/logs и запущены daemon/browser.
4. Обычный daemon стартует без принудительного provider override и открывает `/try#bootstrap=...`.
5. При `--no-open` exact one-time URL печатается владельцу; token не попадает в operational log.

Readiness означает, что хотя бы один поддержанный local CLI имеет совместимую точную версию и существующую
subscription authentication. `setup` сохраняет zero-write/zero-launch семантику. `try` не устанавливает Chromium,
не логинит provider и не запускает workflow автоматически.

## 4. `/try` mission

Mission — deterministic projection существующих durable сущностей, а не вторая state machine и не browser
localStorage:

1. materialised bundled Project;
2. Project Provider Preference `AUTO`, выбирающий только готовый Codex CLI или Claude Code CLI;
3. одна idempotently созданная Task из canonical recipe с непустым brief/criteria;
4. переход Task `BACKLOG -> READY`;
5. старт существующего workflow с canonical bounded policy;
6. Human Request, Review, measured project verification, QA и Acceptance состояния существующего PipelineRun;
7. owner `Accept | Return | Reject` только в Task Cockpit.

Если сохранённая preference указывает на недоступный provider, явное действие `/try` возвращает Project в `AUTO`.
После этого доступный local CLI выбирает domain-owned provider registry; UI не подменяет эту развилку hardcoded
Codex/Claude payload. Активный или неизвестный `LOOMRAIL_PROVIDER` остаётся блокирующим override и не изменяется UI.

После reload/restart `/try` заново выводит progress из Project, WorkItem и Workflow reads. Query `task` лишь выбирает
конкретную durable Task; если он отсутствует, UI находит newest non-cancelled exact-recipe Task. Provider output,
browser storage и marketing progress не могут отметить шаг завершённым.

Каждый экран показывает один текущий outcome и primary action. Он не дублирует формы Attention или Acceptance:
вместо этого ведёт в существующую authoritative surface. Завершение предлагает продолжить local Community,
подключить собственный repository/provider или прочитать про bounded Guided Launch. Q15 не создаёт платёж, account,
lead form или обещание поддержки.

## 5. Security и recovery

- JSON contract runtime-validated и bounded; unknown fields fail closed.
- Demo Task создаётся существующей `CREATE_WORK_ITEM` command с fixed mission command id, поэтому lost response/retry
  возвращает тот же result, а не создаёт дубль.
- Остальные действия используют существующие optimistic-versioned commands, session/Origin/CSRF и audit Events.
- `/try` не получает отдельной filesystem/shell/Git/provider authority: real execution использует Q20 bounded
  workspace executor и owner-approved recipes.
- AUTO применяется отдельной явной кнопкой только для recovery недоступной сохранённой preference; готовый AUTO
  Project не требует лишней provider mutation.
- Bootstrap token остаётся fragment-only, одноразовым и удаляется до render.
- Provider output остаётся недоверенным вводом и не может расширить permissions, budgets или acceptance authority.
- Windows использует тот же argv/parser/path contract; live Windows Codex/Claude evidence остаётся отдельным stable
  gate.

## 6. Acceptance criteria

1. Один strict contract управляет install block, exact sample recipe и bounded run policy; mutation, unknown и unsafe
   data отклоняются.
2. README, landing и RU/EN quick start потребляют один exact install block; fixture recipe совпадает с contract.
3. `loomrail try` fail closed при blocked local-provider preflight и открывает/печатает exact `/try` bootstrap URL
   только после `READY`.
4. `/try` создаёт непустую canonical Task idempotently, требует explicit Ready и Start actions и не создаёт
   собственную workflow truth.
5. AUTO выбирает любой готовый поддержанный local CLI; stale unavailable preference восстанавливается через явное
   owner-действие без hardcoded provider lock-in.
6. Reload и daemon restart восстанавливают шаг из durable state; stale URL/task input не создаёт ложный progress.
7. Mission показывает Human Request, independent Review, measured verification/QA и owner Acceptance как отдельные
   gates и никогда не принимает результат самостоятельно.
8. EN/RU, keyboard, light/dark и narrow viewport проходят Browser QA; packaged `try --no-open` проходит clean
   macOS/Windows lane.
9. Protected landing импортирует canonical contract и проходит отдельный fixed-commit Pages browser gate.

## 7. Non-goals

- автоматический provider install/login или direct OpenAI/Anthropic API;
- production Mock, synthetic success или скрытый provider fallback;
- скрытая установка Node/npm package/Chromium/dependencies;
- новый workflow engine, Acceptance authority или ActivationMission table;
- analytics, account, billing, lead collection или network telemetry;
- npm publish, tag, dist-tag или GitHub Release.
