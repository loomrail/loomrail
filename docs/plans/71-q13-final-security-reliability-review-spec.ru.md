# Q13 — Final security and reliability review

**Статус:** active

**Дата:** 2026-09-03

**Предшественники:** Q1–Q12, A2, A3, E1, R1

## 1. Цель

Перед первым stable release проверить не только наличие Phase 8 gates, но и честность runtime-границ, которые
появились между ранними milestones. Q13 закрывает обнаруженные P0/P1 security/reliability gaps, повторяет полный
release matrix и оставляет stable publish закрытым до private dogfood, exact live-provider promotion, protected
landing gate и registry provenance.

`apps/landing/**` не входит в scope: каталог ведётся независимо и Q13 не меняет, не форматирует и не маскирует его
ошибки.

## 2. Review baseline

Две независимые оси review сравнивают текущий `main` с `v0.1.0-alpha.4`:

- **Standards:** repository instructions, deterministic-domain boundary, strict input, durable transactions,
  privacy/security и release discipline;
- **Spec:** approved product decisions, active plans, ADR и stable exit gates.

Каждый finding получает severity, доказательство в коде/тесте и disposition. P0/P1 нельзя переносить в stable.

## 3. Принятые решения по live usage

### D1 — Один финальный cumulative report на ProviderSession

Поддерживаемые adapters вызывают `onUsage` один раз на terminal provider event. SQLite сохраняет ровно один
`ProviderUsageReport` на `provider_session_id`; повтор другого command получает typed refusal, повтор того же
command replay-ится из receipt. Это исключает двойное списание при callback retry.

### D2 — Provider-neutral token quantity

`inputTokens` означает весь provider input. Codex уже сообщает total input и cached subdivision. Claude wire делит
ordinary input, cache creation и cache read, поэтому adapter складывает эти три класса в `inputTokens`, сохраняя
cache read отдельно как attribution. Бюджет считает только `inputTokens + outputTokens`; cached/reasoning detail не
прибавляется повторно.

### D3 — Detailed report и budget ledger имеют разные обязанности

Append-only `provider_usage_reports` хранит input/output/cache/reasoning/cost/quality, exact execution lineage и
SHA-256 нормализованного usage. Положительный token total атомарно проецируется в существующий append-only
`UsageRecord(kind = ESTIMATED_TOKENS)` для единого threshold/reporting/override пути. Нулевой отчёт остаётся durable
provenance без фиктивной положительной ledger row.

### D4 — Hard pause предшествует следующей сессии

В одной SQLite transaction записываются report, UsageRecord, Events и при исчерпании effective cap — BLOCKED
WorkItem, HARD_PAUSED PipelineRun/StageAttempt и withdrawn dispatch. Live ProviderSession/AgentRun и workspace lease
остаются authority до подтверждённой остановки process; только последующий `END_PROVIDER_SESSION` атомарно закрывает
session/run и освобождает lease. Cap равен более строгому из текущего pipeline budget и immutable AgentRun envelope.
Failed abort оставляет authority fenced для startup reconciliation, поэтому окно для следующего writer не возникает.

Budget pause не создаёт Human Request и сохраняет `failureCode = null`: продолжение возможно только через
существующий versioned owner Budget Override.

### D5 — Owner-visible attribution

Task Cockpit показывает для каждой сессии total/input/output, quality и reported USD cost, если он существует.
Общий budget progress продолжает читаться из единого UsageRecord ledger. Raw provider output не сохраняется.

### D6 — Stable bounded actual diff для REVIEW

Первый REVIEW session получает не только durable result-tree label и file stats. Daemon строит file list и
unified-diff fragments из одного временного Git index: recorded baseline загружается через `read-tree`, текущее
worktree-содержимое добавляется через `add -A`, а `write-tree`, status/numstat и patch reads используют этот же index.
Измеренный tree обязан совпасть с immutable result tree последнего IMPLEMENT; иначе provider session не стартует и
владелец получает blocking retry request.

Intrinsic bounds не зависят от provider window: не более 50 file records, тела не более первых 16 records, до
4096 patch bytes на файл и 32768 patch bytes суммарно, до 512 UTF-8 bytes на rendered path. Binary body, file/content
limit и truncation всегда обозначаются явно. Patch, status и numstat stdout ограничиваются во время drain Git
process: хвост подсчитывается и отбрасывается до накопления в daemon memory, а `omittedBytes` для patch остаётся
точным. Metadata parser получает не более `maxFiles + 1` bounded records, поэтому truncation определяется без
неограниченного массива. Context renderer
повторно применяет bounds и заключает все repository
paths/patches в untrusted-data frame, поэтому внутренний shape drift не снимает ограничение и repository text не
может закрыть delimiter. Это также даёт Claude REVIEW фактический diff без расширения его filesystem authority:
adapter по-прежнему работает в пустом temporary directory под `permission-mode plan`.

### D7 — BrowserDriver имеет закрытый async error boundary

Публичные `run`, `finalizeAttachments`, `confirmAttachments` и `dispose` отклоняют Promise только экспортируемым
`BrowserDriverError`. Его code принадлежит закрытому набору; summary фиксирован и не переносит filesystem path,
provider/browser message или callback secret. Обычные измеренные target/browser failures остаются typed
`QADriverResult`, а daemon всё равно fail-closed обрабатывает нарушающий контракт adapter.

Каждая нормализация создаёт новый error по закрытому code→message словарю: даже переданный callback-ом экземпляр
экспортируемого класса не сохраняет произвольный message. Публичное startup recovery также переводит scan failure
в `BrowserQAArtifactRecoveryError` с фиксированным кодом, а daemon логирует только этот код. Если платформа сообщает
`ENOENT` для дочернего пути под file-valued artifact root, recovery отдельно проверяет root и не принимает invalid
layout за допустимо отсутствующий `qa` directory. Recovery также запрещает symlinked `qa` и run roots, проверяет
canonical containment и повторно сверяет directory identity непосредственно перед unlink/rename.

### D8 — Post-start SquadAssignment revision не входит в stable scope

Pipeline start атомарно создаёт единственный immutable `SquadAssignment(revision = 1)`. В stable runtime нет команды,
HTTP/UI boundary или transition для замены состава, поэтому прежнее утверждение, будто такая замена уже создаёт новую
revision для будущих StageAttempt, снято. Revision остаётся частью точной snapshot identity. Будущая реализация
потребует отдельной команды, новой immutable assignment и нового AgentRun policy snapshot до provider spawn.

### D9 — Constitution и model tier привязаны к AgentRun

Новый AgentRun snapshot хранит exact `ProjectConstitution(id, version, contentDigest)` либо явный `null`. Context
для этого run читает именно сохранённую версию и проверяет digest, поэтому последующая owner activation другой
Constitution не меняет уже начатый run. Отсутствующее поле остаётся только migration-compatible поведением для
исторических snapshot и использует прежний current-active lookup.

Логический `FAST`/`STANDARD`/`DEEP` tier из того же immutable snapshot передаётся в каждую ProviderInvocation.
Adapter применяет schema-validated provider-local mapping и запускает Codex/Claude с явным `--model`; значения
mapping можно заменить только через trusted daemon construction, а repository/provider text не участвует в выборе.
Exact live-provider promotion по-прежнему требует отдельной проверенной compatibility matrix row.

Публичный `readReviewDiff` не принимает limits шире канонических D6, даже если внутренний caller попробует их
передать. Browser QA дополнительно проверяет всю цепочку managed directories, ограничивает recovery scan 10 000
entries и fail-closed отклоняет symlink/layout swap. Финальный syscall не объявляется sandbox от уже полностью
скомпрометированного same-user process согласно threat boundary.

Историческая RUNNING ProviderSession без `agent_run_id` при первом startup reconciliation сохраняется как
`ENDED/INTERRUPTED`, но её StageAttempt и dispatch также переходят в durable `INTERRUPTED` recovery state. Daemon не
создаёт для неё следующую session и не применяет nullable-policy fallback, текущие grants либо новую provider config.

`START_PROVIDER_SESSION` повторно проверяет RUNNING StageAttempt и активный AgentRun внутри той же SQLite transaction,
которая пишет session/recipe/event. Если concurrent cancel либо pre-claim Soft Pause завершил run после daemon read,
session start fail-closed отклоняется. После session claim owner cancel сначала durable-фиксирует validated
cancellation без освобождения live authority, затем синхронно отзывает daemon-owned signal: Codex/Claude проверяют
его после async scratch/MCP/workspace preparation прямо перед spawn без промежуточного await, а уже
зарегистрированный process получает `abortSession`. HTTP boundary ждёт подтверждённого выхода и только затем
`END_PROVIDER_SESSION` transaction закрывает ProviderSession/AgentRun и writer lease; отозванный loop не пишет
второй outcome.
Soft Pause signal не отзывает: он запрещает новый dispatch, позволяет текущему turn закончить session, а resume
открывает следующий AgentRun/session ordinal только после durable закрытия старого.

Provider-executed подготовка ACCEPTANCE также обязана иметь immutable AgentRun. Built-in Acceptance Manager получает
только `ARTIFACT_WRITE`, `workspace = NONE`, no network/MCP, собственный session/token envelope и exact model tier.
Его `READY_FOR_ACCEPTANCE` остаётся предложением: deterministic domain связывает claims с current evidence и только
затем открывает отдельный owner-only package gate. Исторический exact revision 1 Standard assignment без этой роли
получает одну additive immutable compatibility revision; arbitrary post-start composition editing не появляется.

## 4. Другие обязательные findings Q13

- untrusted repository/provider text не может закрыть собственную context section delimiter;
- CLI Doctor выводит supported Node floor из package manifest, а не из второй константы;
- provider diagnostics принадлежат adapter, не daemon;
- role playbook реально участвует в context recipe с exact profile revision;
- AgentRun хранит и применяет immutable effective capabilities, workspace/network, budget/session и MCP revisions;
- Browser QA policy остаётся read-only/offline, а MCP revision set очищается, если `MCP_READ` не вошёл в effective
  capabilities;
- provider-authored evidence заключён в ту же untrusted-data frame, что checkpoint/review output;
- REVIEW context получает bounded actual diff summary, а не только tree label (D6);
- REVIEW context получает exact Project Constitution version, привязанную к AgentRun, с owner-policy framing и
  provenance (D9);
- public async BrowserDriver errors имеют closed typed contract (D7);
- post-start SquadAssignment revision явно остаётся non-goal stable scope без overclaim (D8);
- model tier применяется к явному provider model, а публичные review limits и Browser QA managed layout нельзя
  расширить в обход канонической policy; pre-AgentRun session не возобновляется автоматически (D9).
- Acceptance Manager preparation не использует nullable-policy fallback и не подменяет final owner authority (D9).

## 5. Verification и exit

Q13 implementation завершается только когда:

1. focused contracts/domain/persistence/provider/daemon/web tests зелёные;
2. migration/restart/idempotency/append-only и budget-abort scenarios зелёные;
3. full non-landing lint, typecheck, tests, fault injection, production audit и clean tarball/install зелёные;
4. browser suite проверена в light/dark и keyboard/state, включая per-session usage;
5. macOS/Windows CI повторяет named gates;
6. final report содержит отдельные `Standards` и `Spec` sections без открытых P0/P1.

Это не разрешает stable npm publish само по себе. Publish остаётся отдельным последним действием после всех
Dogfood Alpha и Phase 8 exit gates.
