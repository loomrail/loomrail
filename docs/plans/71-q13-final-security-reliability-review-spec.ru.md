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
WorkItem, HARD_PAUSED PipelineRun/StageAttempt, completed dispatch и finished AgentRun с release workspace lease.
Cap равен более строгому из текущего pipeline budget и immutable AgentRun envelope. Session loop затем abort-ит
живой process и закрывает ProviderSession как INTERRUPTED; restart не создаёт окно для следующей сессии.

Budget pause не создаёт Human Request и сохраняет `failureCode = null`: продолжение возможно только через
существующий versioned owner Budget Override.

### D5 — Owner-visible attribution

Task Cockpit показывает для каждой сессии total/input/output, quality и reported USD cost, если он существует.
Общий budget progress продолжает читаться из единого UsageRecord ledger. Raw provider output не сохраняется.

## 4. Другие обязательные findings Q13

- untrusted repository/provider text не может закрыть собственную context section delimiter;
- CLI Doctor выводит supported Node floor из package manifest, а не из второй константы;
- provider diagnostics принадлежат adapter, не daemon;
- role playbook реально участвует в context recipe с exact profile revision;
- AgentRun хранит и применяет immutable effective capabilities, workspace/network, budget/session и MCP revisions;
- REVIEW context получает bounded actual diff summary, а не только tree label;
- public async BrowserDriver errors имеют closed typed contract;
- post-start SquadAssignment revision либо реализована с новым AgentRun snapshot, либо явно остаётся non-goal stable
  scope без overclaim.

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
