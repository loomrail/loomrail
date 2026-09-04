# Q16 — Provider allowance visibility

**Дата:** 2026-09-04

**Статус:** implemented and verified; Windows live-provider capture deferred by owner

**Основание:** BD-004, T47 и Phase 8 Q16 в
[MASTER-PLAN.ru.md](../product/MASTER-PLAN.ru.md)

## 1. Outcome

Владелец видит внешний остаток доступного лимита Codex или Claude Code и время сброса рядом с выбранным provider,
но никогда не принимает его за жёсткий бюджет Loomrail. Отсутствующий, неподдерживаемый или устаревший сигнал
показывается как `Unavailable` либо `Stale`, а не как нулевой остаток.

## 2. Источники и граница доверия

- Codex: только официальный JSON-RPC `account/rateLimits/read` и
  `account/rateLimits/updated` из `codex app-server`; `rateLimitsByLimitId` предпочтительнее legacy single-bucket
  `rateLimits`.
- Claude Code: документированный `rate_limits` JSON поступает только в interactive status-line command. Текущий
  Loomrail adapter использует headless `claude -p`; live-проверка v2.1.260 подтвердила, что после первого API response
  status-line command не вызывается до завершения процесса. Поэтому adapter сообщает `canReportRateLimits=false`, не
  добавляет `--settings` и показывает `UNAVAILABLE / PROVIDER_UNSUPPORTED`. Claude Desktop также не считается
  machine-readable source. Будущий bridge допустим только после отдельной live-проверки официального headless seam.
- Mock: capability отсутствует и всегда возвращается как `UNAVAILABLE / PROVIDER_UNSUPPORTED`.
- Provider surface читается только для exact compatibility row, где allowance capability отдельно разрешена. Semver,
  более новая версия, другая ОС, архитектура или auth mode не наследуют это разрешение. Текущая Codex allowance-row
  фиксирует `0.153.1 / darwin / arm64 / ChatGPT`; она не расширяет execution compatibility этой версии.
- Чтение allowance не запускает model turn, не выполняет login/update/install и не выдаёт repository authority.

Официальный Codex contract содержит `usedPercent`, `windowDurationMins`, Unix `resetsAt`, primary/secondary windows и
несколько limit groups. Claude Code 2.1.251+ документирует `five_hour`, `seven_day` и optional `spend_limit`; последний
может сообщить usage выше 100%. Поэтому нормализованный остаток всегда вычисляется как
`max(0, 100 - usedPercent)`, но исходный bounded `usedPercent` для spend-limit может быть больше 100.

## 3. Нормализованный контракт

`ProviderAllowanceSnapshot` — strict discriminated union schema version 1:

- общие поля: `provider`, `observedAt`, `freshness`;
- `LIVE | STALE`: от 1 до 16 `buckets`;
- `UNAVAILABLE`: пустой список и один closed reason;
- bucket: stable `id`, optional bounded display `name`, `kind`, `usedPercent`, вычисленный `remainingPercent`,
  `windowDurationMins`, `resetsAt`, `limitReached`;
- `usedPercent` конечный и неотрицательный; consumption windows ограничены 100, `SPEND_LIMIT` — 1000;
- `remainingPercent` находится в 0..100 и обязан совпадать с `max(0, 100 - usedPercent)`;
- идентификаторы, labels и количество buckets ограничены; duplicate ids запрещены;
- timestamp — UTC ISO-8601; Unix seconds преобразует adapter, UI не угадывает единицы;
- raw response, plan/account/email, credentials, transcript path, cwd и session id в контракт не входят.

Closed `unavailableReason`:

- `PROVIDER_UNSUPPORTED`;
- `TARGET_UNVERIFIED`;
- `NOT_AUTHENTICATED`;
- `DATA_NOT_PRESENT`;
- `PROVIDER_SCHEMA_DRIFT`;
- `PROVIDER_TIMEOUT`;
- `PROVIDER_UNAVAILABLE`.

`LIVE` действует не дольше 15 минут и никогда после ближайшего `resetsAt`. Будущий `observedAt` с clock skew больше
60 секунд, уже истёкшее окно и запись старше TTL проецируются как `STALE`; они не обновляются задним числом и не
выдаются за live capacity.

## 4. Deep module seam

`@loomrail/provider-core` владеет малым интерфейсом:

- `capabilities().canReportRateLimits`;
- optional `readAllowance(): Promise<ProviderAllowanceSnapshot>`;
- optional `ProviderSessionListener.onAllowance(snapshot)` для session-fed Claude update;
- pure freshness/advisory projection.

Provider packages владеют только provider-specific input schema и переводом в общий snapshot. Daemon допускает read
лишь после registry checks exact target/auth mode, сохраняет только нормализованный snapshot и выдаёт один
authenticated API projection. Web не импортирует provider package и не пересчитывает provider semantics.

## 5. Durable state и команды

- Последний нормализованный snapshot хранится отдельно для каждого live provider; Mock не создаёт строку.
- Запись проходит только через `RECORD_PROVIDER_ALLOWANCE` с actor `SYSTEM` и strict expected observation ordering.
- Snapshot и audit Event фиксируются одной SQLite transaction. Повтор того же command id идемпотентен; более старый
  `observedAt` не перезаписывает новую запись.
- Unavailable observation может заменить старый live snapshot только после успешного bounded probe. Ошибка записи не
  ломает уже завершившийся provider turn и попадает в redacted structured log.
- После restart сохранённый snapshot читается, но freshness вычисляется заново injected clock; restart не делает его
  снова `LIVE`.
- SQLite содержит только нормализованные buckets и closed reason. Raw JSON никогда не попадает в Event, log, export
  или telemetry.

## 6. Refresh и runtime lifecycle

- `GET /api/v1/provider/allowance?projectId=...` возвращает current projection для effective provider и отдельные
  snapshots всех live providers.
- `POST /api/v1/projects/:id/provider-allowance/refresh` требует session, Origin и CSRF, выполняет один bounded read и
  сохраняет его. Параллельные refresh одного provider coalesce; deadline — 3 секунды.
- Codex reader запускает fixed argv `codex app-server --listen stdio://`, выполняет `initialize`/`initialized`, один
  `account/rateLimits/read`, принимает matching response или documented update notification и гарантированно
  завершает child process. Никакие thread/turn/login/reset methods не отправляются.
- Текущий Claude headless adapter не устанавливает bridge и не меняет user/project settings. Отсутствие официального
  delivery seam является `PROVIDER_UNSUPPORTED`, а не `0%`, authentication failure или поводом парсить Desktop/TUI.

## 7. UI

Один компактный `ProviderAllowanceStrip` переиспользуется в Command Center и Task Cockpit:

- заголовок всегда содержит provider и слово `Provider allowance` / `Лимит провайдера`;
- каждая строка пишет `осталось`, окно и reset; used percentage доступен в details, поэтому bare `4%` отсутствует;
- `LIVE`, `STALE`, `UNAVAILABLE` названы текстом и иконкой, не только цветом;
- Loomrail budget остаётся отдельной секцией с подписью `Hard budget`; шкалы не объединяются;
- `Check again` доступна с клавиатуры, показывает pending/error state и не стирает последний snapshot во время запроса;
- narrow viewport переносит buckets по строкам, light/dark используют semantic tokens.

## 8. Advisory scheduling и фактический limit

- Snapshot выдаёт только объяснимый hint: `CAPACITY_AVAILABLE`, `LOW_CAPACITY`, `LIMIT_REACHED`, `UNKNOWN` и optional
  `deferUntil`.
- В Q16 hint видим владельцу и может ранжировать ещё не начатую работу, но не отменяет существующий AgentRun, не
  мутирует BudgetPolicy и не является скрытым dispatch veto. Автоматическая политика ожидания требует отдельного
  owner-approved решения.
- Фактический provider rate-limit из terminal structured failure создаёт typed attention reason
  `PROVIDER_RATE_LIMITED` и использует известный reset только как объяснение/рекомендацию. Resume остаётся отдельным
  owner action; provider snapshot не отвечает Human Request и не повышает budget.

## 9. Проверки

- contract: strict union, unknown fields, NaN/Infinity, negative/>100 windows, >100 spend-limit, derived remaining,
  duplicate/overlong ids, missing/multiple buckets, invalid Unix/ISO timestamps;
- Codex: multi-bucket priority, legacy fallback, primary/secondary, notification, wrong JSON-RPC id, error, overlong
  line, timeout, premature exit and guaranteed process termination;
- Claude: negative capability для headless/Desktop route, отсутствие `--settings`, user-setting mutation и
  терминального scraping; возврат поддержки требует отдельного provider-version fixture;
- persistence: migration, atomic event, idempotency, stale ordering, restart, rollback and raw-data canaries;
- daemon: exact compatibility/auth gate, CSRF/Origin, refresh coalescing, typed unavailable codes and no budget/workflow
  mutation;
- UI/E2E: live/stale/unavailable, explicit remaining label, multi-bucket, refresh, separate hard budget, keyboard,
  RU/EN, light/dark, narrow viewport and daemon restart;
- scheduler/domain: hint is deterministic and advisory-only; forged/stale/unavailable data cannot start, stop, accept,
  resume or increase any run.

## 10. Exit и non-goals

Q16 закрыт, когда exact supported fixtures проходят полный local/macOS/Windows contract, persistence, API и UI gate;
Codex read подтверждён sanitized live observation на macOS, а каждый неподдерживаемый provider route честно остаётся
`UNAVAILABLE`. Claude headless/Desktop не блокирует Q16 как отсутствующая capability, но не может считаться live
allowance evidence. Windows live provider capture остаётся отложенным owner gate и не выводится из fixture CI.

Не входят: billing/cost prediction, покупка или расход reset credits, управление account plan, login, provider update,
автоматический budget override, безусловное ожидание до reset, cloud sync и парсинг терминального текста.
