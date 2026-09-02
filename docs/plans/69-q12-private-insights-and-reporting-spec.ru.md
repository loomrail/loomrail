# Q12 — Private Insights и opt-in diagnostic reporting

**Дата:** 2026-09-03

**Статус:** implementation complete; macOS/Windows gate pending

**Предшественники:** Q4, Q5, Q7, Q11

**Нормативные решения:** PD-003, QD-002, SD-003, SD-004, ADR-0003, ADR-0009, T40, T46

## 1. Outcome

Владелец видит локальные aggregate product/quality/reliability metrics на отдельном экране Insights. Там же он
может полностью прочитать строгий anonymous aggregate payload и, если есть durable `DAEMON_RESTART` recovery,
отдельный crash payload. Только явное действие человека скачивает ровно показанный JSON; Loomrail не отправляет
его автоматически и не хранит постоянное согласие.

Для public alpha это реализация opt-in telemetry/crash reporting: report существует как previewed owner-initiated
export без remote collector. Прямой или фоновый transport остаётся закрыт ADR-0009 до появления owned endpoint,
retention/deletion contract и отдельного consent decision.

## 2. Reporting seam

`packages/domain/src/reporting.ts` — глубокий детерминированный модуль с одним интерфейсом построения snapshot. На
входе только числовые/enum facts из одного SQLite statement и runtime categories; на выходе:

- `localMetrics` — полные локальные counts и derived rates;
- `aggregateReport` — строгий публичный payload без raw data;
- `crashReport` — `null` или bounded payload только по доказанному recovery count.

Persistence не отдаёт модулю rows, IDs, names, paths, text или timestamps. Daemon не собирает payload вручную и не
имеет второго allowlist. Contracts используют `.strict()` на каждом публичном object, поэтому добавление поля требует
явного schema/test review.

## 3. Local metrics contract

Один `GET_REPORTING_FACTS` read считает в одном SQLite snapshot:

- WorkItems: total, accepted (`DONE`), cancelled, active (`READY|IN_PROGRESS|BLOCKED`);
- PipelineRuns: total, succeeded, failed, interrupted, cancelled;
- AgentRuns: total, succeeded, failed, interrupted;
- review reports: total и passed on round 1;
- QA runs: total, passed, failed, errored;
- QA defects: open, resolved, waived;
- HumanRequests: total и resolved;
- cumulative estimated tokens;
- daemon-restart RecoveryReports.

Domain добавляет integer percentage для accepted completion, first-pass review и terminal QA pass. Нулевой
denominator даёт `null`, а не invented 0%. Local metrics не содержат project/provider identifiers и доступны только
через authenticated loopback session.

## 4. Public report contract

Оба payload имеют `schemaVersion: 1`, закрытый `kind`, release version и категории runtime:
`MACOS|WINDOWS|LINUX|OTHER`, `X64|ARM64|OTHER`, Node major. Aggregate payload повторяет только allowlisted counts и
derived rates. Crash payload содержит только `DAEMON_RESTART`, `INTERRUPTED`, число восстановленных workflow и те же
runtime categories.

Запрещены даже после redaction:

- source code, prompts, provider responses и logs;
- IDs, names, repository/worktree paths и filenames;
- exact timestamps, host/user/install identifiers, IP/network data;
- artifacts, screenshots, traces, diffs, command arguments и environment variables;
- произвольные messages, error strings или stack traces.

## 5. UI contract

Global navigation получает `Insights`. Экран:

1. показывает локальные metrics и явно помечает их `Local only`;
2. объясняет, что automatic collection/network delivery отсутствуют;
3. раскрывает exact formatted JSON до появления enabled download action;
4. скачивает из того же in-memory parsed object `loomrail-aggregate-report.json` или
   `loomrail-crash-report.json`;
5. не показывает crash action, если recovery evidence отсутствует.

Preview использует `<pre>`, сохраняет порядок сериализации и не скрывает поля за summary. Export utility не читает
DOM и не делает fetch: bytes строятся из переданного payload.

## 6. Security delta

T46 фиксирует риск privacy-boundary regression: sensitive local state может попасть в report через удобный shared
diagnostics object или будущий UI refetch. Меры: numeric/enum-only facts, strict schemas, один domain seam, exact
preview/export object, authenticated loopback, отсутствие transport и negative schema/source-tree tests.

## 7. Acceptance criteria

1. Empty и populated SQLite state дают coherent typed facts одним statement.
2. Insights показывает local counts/rates без opt-in и без external request.
3. Aggregate preview проходит public schema и не допускает sensitive/free-text fields.
4. Crash preview отсутствует без RecoveryReport и появляется только по `DAEMON_RESTART` evidence.
5. Download serializes exact preview object и вызывается только явным user action.
6. Contract/domain/persistence/daemon/web tests, build, typecheck и relevant browser E2E зелёные на macOS/Windows.
7. Q12 не меняет `apps/landing/**`, provider execution, package publication или remote infrastructure.

## 8. Non-goals

- remote collector, account, installation ID, cookie, beacon, schedule или retry queue;
- automatic crash handler, core dump, stack/log/transcript attachment;
- metrics by repository, project name, path, model or arbitrary error code;
- public issue submission, support bundle upload или vulnerability ingestion;
- private dogfood, exact live-provider row, stable npm publish или registry provenance.
