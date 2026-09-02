# Q5 — Crash и fault-injection release gate

**Дата:** 2026-09-02

**Статус:** implemented locally; cross-platform CI evidence pending

**Предшественники:** M5, A1.5, A2, E1, C1, B4, Q1, Q4

**Нормативные решения:** deterministic state owns recovery, no automatic risky replay, T09, T17, T30, T31

## 1. Outcome

Одна команда `pnpm test:fault-injection` становится явным Phase 8 gate. Она собирает repository, запускает
существующие focused fault suites для persistence, provider processes, MCP, scaffolding, Browser QA и daemon, затем
выполняет новый black-box drill: отдельный реальный daemon process получает `SIGKILL` во время активной
ProviderSession, перезапускается на тех же WAL/state files и доказывает ровно один durable recovery outcome без
automatic provider replay.

Gate выполняется отдельным CI step на macOS и Windows до repository-wide lint. Поэтому независимое failure вроде
защищённого landing lint больше не скрывает отсутствие crash evidence.

## 2. Текущий разрыв

Компонентные tests уже покрывают transaction rollback, migration failure, orphan process, provider termination,
MCP unknown outcome, marker recovery и daemon reopen. Но они запускаются как часть общего `pnpm test`, до которого CI
не доходит при более раннем lint failure. Ни один gate не убивает сам daemon OS process после durable session start и
не проверяет сохранённую SQLite/WAL state через новый process и новый authenticated session.

Такое покрытие доказывает отдельные функции, но не Phase 8 claim «private dogfood стабильно восстанавливается после
restart/crash» на process boundary.

## 3. Black-box drill

Test-owned launcher выполняет только над synthetic fixture и temporary directory:

1. parent создаёт exact temporary data root и запускает Node child с test fixture composition root;
2. child открывает loopback daemon с file-backed SQLite, deterministic blocking Mock adapter и известным только test
   process bootstrap token;
3. parent проходит настоящий session exchange, регистрирует bundled `web-app-a`, создаёт/перемещает WorkItem и
   запускает стандартный PipelineRun через HTTP command API;
4. adapter сообщает parent только после того, как ProviderSession/AgentRun/dispatch уже durable и `start()` вошёл в
   незавершённую работу;
5. parent посылает `SIGKILL` exact spawned child и ждёт OS exit;
6. новый child открывает те же state/data paths; startup reconciliation должен завершиться до readiness;
7. новый authenticated read показывает PipelineRun и StageAttempt `INTERRUPTED`, failure `DAEMON_RESTART`, отсутствие
   RUNNING ProviderSession/AgentRun и один RecoveryReport;
8. второй restart после graceful stop показывает тот же единственный RecoveryReport и не запускает adapter снова.

Parent никогда не принимает PID/path/provider command извне. Он сигналит только сохранённый ChildProcess handle.
Timeout каждого ожидания закрыт; cleanup убивает только ещё живые test children и удаляет только exact `mkdtemp`
directory.

## 4. Test-only composition

Fixture живёт под daemon tests и импортирует уже собранный `dist/server.js`. Она не попадает в npm tarball и не
добавляет production env flag, HTTP route, failpoint или crash command.

Blocking adapter:

- объявляет Mock capabilities и все стандартные stages;
- не запускает shell/process/network/provider;
- возвращает незавершающийся Promise только после machine-readable `PROVIDER_STARTED` test signal;
- не публикует outcome/checkpoint/usage;
- при первом `SIGKILL` не получает cleanup, что и моделирует crash.

ProviderRegistry также test-owned и не выполняет реальные Codex/Claude auth probes. Обычный production composition и
provider selection не меняются.

## 5. Fault matrix

Named gate последовательно запускает:

- `persistence-sqlite`: atomic rollback, migrations/backups/drift, reopen, orphan PID/workspace, recovery reports;
- `provider-core`, Codex и Claude adapters: argv/no-shell, malformed streams, deadline, TERM→KILL, process exit;
- `mcp-gateway`: orphan process records, bounded shutdown, unknown outcome and no retry;
- `project-scaffolding`: marker-bound partial publication and safe retry/refusal;
- `browser-qa`: origin/resource/artifact failure and bounded cleanup;
- `daemon`: worker/provider/scaffold/MCP/QA failures, startup reconciliation, idempotency and HTTP fail-closed paths;
- process drill: real daemon `SIGKILL` → new process → durable exactly-once interruption.

Это не новый parallel test runner: suites идут последовательно, чтобы shared OS process/SQLite timing не превращал
reliability gate в flaky resource race.

## 6. Security and recovery boundaries

- только bundled synthetic repository; owner repository path не принимается;
- test bootstrap/CSRF/session проходят normal API, но не печатаются;
- child stdout принимает только closed `READY` и `PROVIDER_STARTED`, stderr bounded и выводится только при failure;
- no real provider CLI, MCP server, BrowserDriver или remote network;
- `SIGKILL` моделирует abrupt loss, но recovery не replay-ит provider/tool action;
- test не считает graceful `close()` crash evidence;
- failure сохраняет enough bounded diagnostic, но report не включает temporary absolute path/token/cookie.

## 7. Acceptance criteria

1. Gate запускается одной root command и одинаково работает на macOS/Windows без shell-string composition.
2. Drill не может сигналить owner/ambient PID и не трогает repository checkout.
3. `PROVIDER_STARTED` наблюдается до kill; иначе test не выдаёт idle restart за mid-session crash.
4. После `SIGKILL` новый daemon ready и authenticated snapshot содержит exact interrupted run/stage, один
   `DAEMON_RESTART` RecoveryReport и ни одной active session/run.
5. Второй restart не добавляет report/Event и не вызывает provider adapter.
6. Transaction/migration/provider/MCP/scaffold/Browser QA/daemon fault suites входят в named gate.
7. CI запускает named gate отдельно на macOS/Windows до полного verify.
8. Production launcher/API/provider contract и release tarball не получают test failpoint или fixture.

## 8. Non-goals

- product crash-reporting/telemetry, watchdog или automatic restart service;
- power-loss/filesystem corruption certification;
- real provider/MCP/browser fault injection;
- automatic resume/retry interrupted work;
- chaos testing owner repositories;
- исправление или изменение `apps/landing/**`;
- npm publish.
