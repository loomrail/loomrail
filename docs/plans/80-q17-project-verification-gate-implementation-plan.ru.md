# Q17 — План реализации Project verification gate

**Дата:** 2026-09-05

**Статус:** implementation and independent review complete; fresh fixed-commit CI in progress

**Спецификация:**
[79-q17-project-verification-gate-spec.ru.md](79-q17-project-verification-gate-spec.ru.md)

## Confirmed TDD seams

Product decision QD-003 и owner instruction подтверждают шесть public seams: contracts/domain,
scanner/publisher, persistence, runner, authenticated HTTP и Task Cockpit. Каждый vertical slice начинается с одного
failing behavior test на соответствующем seam и заканчивается narrow green run; bulk horizontal test scaffolding
запрещён.

## Q17.1 — Inert preview и owner adoption

- [x] Добавить strict proposal/plan/recipe contracts, canonical hash и deterministic adoption decisions.
- [x] Расширить read-only scanner только bounded `package.json` scripts без запуска package manager/lifecycle hooks.
- [x] Добавить marker-bound `.loomrail/verification-plan.json` publisher с symlink/path/hash conflict checks.
- [x] Добавить migration, Project plan commands/query, optimistic versioning, receipts и Events.
- [x] Добавить authenticated preview/adopt Settings UI с exact executable/argv/cwd/policy disclosure.

**Tracer:** malicious `package.json` остаётся inert; owner видит exact `pnpm run test`, принимает preview hash, reload
показывает ту же revision; без adoption ни один child не появляется.

## Q17.2 — Manual measured run

- [x] Добавить Run/check/evidence contracts и pure terminal/freshness projection.
- [x] Реализовать один daemon-owned runner: argv/no-shell, canonical cwd, scrubbed environment, output/deadline bounds,
      cross-platform process-tree termination и exact-tree before/after check.
- [x] Добавить transactional reservation/check completion/terminal Run commands и restart reconciliation без replay.
- [x] Добавить manual start/cancel/retry/read-output HTTP seams и Task Cockpit states.
- [x] Проверить output privacy, path/control-sequence redaction и artifact retention/recovery: bounded redacted text
      остаётся вне Events/export, missing artifact fail-closed даёт `OUTPUT_UNAVAILABLE`, а startup удаляет только
      плоские regular output-файлы старше 30 дней и атомарно фиксирует идемпотентный retention outcome.

**Tracer:** owner запускает adopted required fixture test, видит real non-zero `FAILED`, duration/platform и bounded
output; restart сохраняет failure, а crash во время process даёт `INTERRUPTED`, не второй spawn.

## Q17.3 — Workflow и Acceptance gate

- [x] Запускать active required Plan после fresh independent Review и до Browser QA: внутренний
      `verification-workflow` может зарезервировать только первый Run на стадии QA; Browser QA не получает AgentRun
      или browser authority до свежего current-tree pass, а terminal non-pass не ретраится скрыто.
- [x] Добавить отдельный `VerificationFailure` и связать его с correction IMPLEMENT/re-review/rerun lineage.
      Immutable failure identity и атомарная запись `FAILED | ERROR | INTERRUPTED` уже готовы; correction transition,
      отдельный bounded `VerificationCorrectionRun`, pure initial `QA gate → correction IMPLEMENT` decision и
      migration 0042 с раздельной lineage Stage/Review/QA/Verification готовы. Terminal `FAILED | ERROR` теперь в
      одной SQLite-транзакции завершает исходный QA gate, создаёт ровно одну active correction, переводит workflow в
      fresh `IMPLEMENT(1)`, сохраняет Event и после рестарта восстанавливает ту же lineage; replay команды не создаёт
      дубль. Propagation re-review/rerun identity реализована в domain/persistence records; после fresh independent
      re-review passing rerun exact Plan на новом tree атомарно закрывает correction как `PASSED`, не дублирует Event
      при replay и переживает restart. Failed rerun теперь supersede-ит active correction и запускает второй
      automatic cycle; после двух automatic failures workflow атомарно переходит в `WAITING_HUMAN` с bounded owner
      request, а после финального owner cycle предлагает только cancel. Семантическая owner action теперь атомарно
      разрешает единственную третью коррекцию либо отменяет delivery, защищена optimistic versions/receipts,
      доступна через authenticated+CSRF HTTP и отдельный Task Cockpit gate с историей коррекций; полный путь
      `2 automatic → owner authorization → final pass` переживает SQLite reopen. Forward mixed sequence теперь
      тоже bounded: после ранее занятых Project verification positions первый локальный QA failure использует
      следующую global position либо открывает owner gate без фиктивной QA CorrectionRun; semantic resolution,
      replay и restart для `verification positions 1+2 → QA owner position 3` покрыты. Обратная смена evaluator
      теперь тоже детерминирована: Project verification failure внутри active QA correction либо занимает следующую
      shared position, либо открывает owner gate; immutable QA-parent edge, dual evidence envelope и passing handback
      возвращают exact locked Browser QA retest без потери review текущего tree. Полная alternating sequence
      `Verification 1 → QA 2 → owner Verification 3 → QA retest`, replay, cancel и SQLite reopen покрыты. `STALE`
      materialization теперь сохраняет исходный terminal `PASSED` неизменным, добавляет один append-only
      `VerificationFailure(STALE)` и в той же SQLite-транзакции переводит pending QA gate в bounded correction;
      exact-version conflict, command replay, повторный daemon gate и SQLite reopen не создают дубль. Fresh passing
      rerun новой current Plan/tree authority закрывает эту correction. Если stale стал Run уже успешно закрытой
      correction, её исторический `PASSED` не переписывается и не отменяется: следующая позиция либо owner gate
      получают новую authority, а исчерпанный budget предлагает только cancel; domain/SQLite/UI и reopen покрыты.
      `RUN_INTERRUPTED` при `DAEMON_RESTART`
      теперь в той же транзакции переводит initial или subsequent QA gate в bounded correction, включая startup
      reconciliation, replay, owner resolution после исчерпания automatic positions и второй SQLite reopen;
      `OWNER_CANCELLED` остаётся окончательной owner action и никогда не создаёт скрытый correction run.
- [x] Применить общий bounded correction ceiling, не смешивая VerificationFailure и QADefect identities.
      Общие constants и pure decision `2 automatic + 1 owner` уже заменили QA-only policy; durable usage/lineage,
      объединяющие оба evaluator без объединения их failure entities, закреплены транзакционным подсчётом обеих
      correction-таблиц и общим порядковым budget position при создании VerificationCorrectionRun. Migration 0046
      теперь backfill-ит append-only `correction_budget_entries`; новые QA и Verification corrections резервируют
      одну последовательную position в той же транзакции, storage guard запрещает пропуск и position > 3, а QA
      сохраняет свой evaluator-local ordinal отдельно. QA owner gate умеет безопасно разрешить final shared position,
      даже если обе automatic positions принадлежали Verification. Обратный handoff active QA correction →
      Verification correction/gate сохраняет обе evaluator-specific identities, один reviewed current tree и общий
      абсолютный bound после restart.
- [x] Сделать required failed/error/interrupted/stale детерминированным Acceptance blocker; optional failure оставить
      advisory.
- [x] Показать criterion-to-verification evidence в Acceptance Package/export без raw output/path leakage.

**Tracer:** intentional failure блокирует Acceptance, fix меняет tree и делает старый Run stale, independent re-review
запускает exact rerun, только current-tree pass открывает Browser QA и затем owner Acceptance.

## Q17.4 — Security, restart и cross-platform exit

- [x] Закрыть T48 matrix: argv/path/env/network-policy/output/timeout/tree mutation/child orphan/duplicate completion.
      Q17 named macOS/Windows CI lane теперь запускает scanner/publisher/runner и shared process-supervision tests до
      общего lint gate. Реальный signal-resistant descendant подтверждает process-tree reap после output-bound stop;
      остальные угрозы связаны с узкими contract/domain/persistence/runner тестами без подмены subprocess mock-ом.
- [x] Проверить every allowed/forbidden transition, rollback, idempotency, expected-version conflict и restart.
      Initial verification correction уже покрыта allowed/forbidden domain cases, replay idempotency и SQLite reopen;
      fresh reviewed passing rerun, второй automatic cycle и owner-authorized final cycle покрыты сквозным public
      workflow, command replay и SQLite reopen; cancel покрыт pure allowed transition, а stale versions, foreign
      lineage и non-owner actor запрещены domain-переходом. Daemon interruption отдельно покрыта для initial и
      subsequent correction, direct stop, startup reconciliation и exhausted owner resolution; owner cancellation
      остаётся forbidden source. Stale после уже `PASSED` correction сохраняет terminal history, продолжает общий
      budget либо открывает owner gate и переживает reopen. Light/dark/keyboard/narrow UI и восстановление после
      daemon restart закрыты отдельным Playwright case.
- [x] Не освобождать verification workspace до доказанной остановки process tree. Owner cancel теперь durable проходит
      `RUNNING -> CANCELLING -> INTERRUPTED`; launch intent создаётся до state transition, trusted supervisor пишет
      ACTIVE/STOPPED proof и убивает resistant descendants при потере daemon control pipe. Startup сверяет PID/start
      time и передаёт storage только exact released Run IDs; missing/mismatched identity при active Check fail-closed.
      Windows startup не выводит descendant authority из уже исчезнувшего числового root PID. Reconcile идёт batches
      по 1000 и удаляет proof только после commit; manual terminal rerun будит parked QA, а non-terminal exit — нет.
- [x] Выполнить RU/EN, keyboard/focus, light/dark, 320 px и daemon-restart Browser QA. Q17 Playwright case
      детерминированно фиксирует English/light, keyboard-only Run/output focus, Russian/dark на 320 px, затем
      перезапускает daemon с той же SQLite-базой и повторно проверяет восстановленный measured result без overflow.
- [x] Выполнить focused lint/typecheck/unit/integration, full non-landing gates, fault injection и clean release.
      Full source typecheck, все package tests, 58/58 Playwright, fault injection и clean packed release прошли;
      repository-wide lint прошёл. Format check остаётся заблокирован только двумя unrelated untracked research
      files, которые не изменялись и не входят в Q17.
- [x] Выполнить independent Standards/Spec review и исправить все P0–P2. Два независимых reviewer после correction
      rounds не нашли оставшихся P0–P2; отдельно закрыты packaged supervisor, descendant races, Windows PID-reuse,
      terminal-only workflow wake и commit-before-proof-removal.
- [x] Зафиксировать macOS/Windows fixed-commit fixture CI evidence; не заявлять live Windows provider evidence.
      На `05cab6279e0cf9f772cafbd32caba9558474d3fb` clean install, 58/58 Browser smoke, Q17 workflow gate и fault
      recovery прошли на обеих платформах; Windows process-tree lifecycle отдельно зелёный. Оба Verify остановились
      только на тех же трёх protected landing lint findings; общий CI conclusion честно остаётся `failure`.
- [x] Обновить threat model, architecture, master plan и sanitized Q17 evidence.
      Evidence: `docs/evidence/phase-8/Q17-PROJECT-VERIFICATION-EVIDENCE.md`.

## Implementation order

1. contracts + pure domain red/green;
2. scanner preview + publisher red/green;
3. persistence adoption/restart red/green;
4. runner + manual API red/green;
5. Task Cockpit manual evidence red/green;
6. workflow/correction/Acceptance red/green;
7. security/fault/browser/cross-platform gates;
8. independent review, evidence, atomic commits and push.

Новый internal package допустим только если runner/process-tree logic нельзя разместить одним глубоким daemon module
без импорта `apps/*` в `packages/*` или дублирования существующей portable boundary. Запрещено переиспользовать
provider output, Browser QADefect или shell string как shortcut.
