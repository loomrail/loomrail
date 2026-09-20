# 133 — Координатор без доступа к репозиторию

**Дата:** 2026-09-19. **Статус:** экспериментальный локальный срез реализован и проверен; live qualification pending.

**Обновлено 2026-09-20:** замечания независимых Standards/Spec reviews исправлены; допуск нового native CLI и
реальный сквозной прогон пока не завершены. Опубликованный 0.1.3 не содержит этот режим.

Владелец дополнительно разрешил commit/push/PR и минимальные реальные Codex пробы, исключив Sonnet.
Три standalone smoke вызова завершены; это не разрешение менять compatibility admission или выпускать новый режим
через approved source 0.1.3. [Очищенные результаты](../evidence/phase-8/CODE-BLIND-COORDINATOR-EVIDENCE.md).

## Граница

Отдельный opt-in перед START_PIPELINE. Шесть этапов остаются: дешёвый Discovery, code-blind PLAN,
дешёвые Implement / независимый Review / QA / Acceptance preparation, затем human Acceptance.
Координатор не становится scheduler и не создаёт permissions. Его bounded work orders — план для исполнителя,
а не выполненная работа. Technical discovery и уточнение технического плана принадлежат исполнителям.

Первый срез фиксирует менеджера `gpt-6-astra` / CODEX; исполнители — `gpt-5.6-luna` / CODEX или
`claude-sonnet-5` / CLAUDE_CODE по прежнему provider selection. Нет наследования дорогой модели от manager,
смены обычного DEEP mapping, скрытого fallback или повышения compatibility admission. Fable не запускается:
его отдельная billing/fallback qualification и согласие на возможные usage credits ещё не получены.

## Контракт

Immutable SquadAssignment хранит режим на каждом назначенном этапе; PLAN получает отдельный профиль и
отдельную написанную владельцем краткую цель без кода. Не импортировать обычный brief, criteria strings,
Constitution, Decisions, checkpoint prose, paths, diff, tool logs, MCP/plugin data или agent transcripts в
manager context. Рабочие reports проецируются только в закрытые enum/count facts, не свободный пересказ.
Краткая цель — явный owner input, не автоматический semantic sanitizer: UI просит не вставлять исходники.

Manager policy: только ARTIFACT_WRITE, workspace NONE, network false, MCP [], Constitution null.
Отдельный prompt и runtime-validated projection; malformed authority отказывает до spawn. Реальный CLI
по-прежнему работает в пустом scratch с отключёнными built-ins/ambient instructions и ephemeral sessions.
Сжатый typed plan привязывается к текущему attempt и попадает исполнителю обычным durable checkpoint handoff.
Повтор, restart, budget и выходы этапа используют существующие транзакции, без отдельного фонового цикла.

## Последовательность и проверки

1. Закрытые контракты opt-in / policy / projection / work orders, PD/ADR/threat delta.
2. Immutable assignment и exact model binding; все forbidden capability/model mutations отклоняются.
3. Scheduler/provider selection, session assembly и обе adapter boundaries; отсутствие code canaries.
4. Переключатель до запуска, RU/EN объяснение ограничений и закреплённые model labels.
5. Contracts/domain/context/provider/persistence/daemon tests: hostile text, stale/cross-run lineage,
   idempotency, restart, failed model, budget, unchanged default и все обязательные quality gates.
6. Полный pnpm verify; browser light/dark/keyboard. Commit/push/PR разрешены отдельно; npm publication требует
   отдельного approved source. Реальные пробы ограничены явно разрешённой Codex-only smoke-проверкой.

## Данные и выпуск

Additive optional fields в immutable stage-assignment JSON; старые записи читаются без изменения.
Новые записи не предназначены для старого binary: rollback только через stopped whole-directory backup.
Разработка изолирована от approved release 0.1.3. Экономия токенов и равенство качества пока не измерены;
same-task live benchmark требует отдельного бюджета. Локальные синтетические проверки не являются live admission.

## Как включить

В карточке Ready-задачи, до запуска Workflow, включить «Координатор без доступа к коду» и отдельно
написать продуктовый результат (10–2000 символов, без исходников, путей и секретов). Поле не копирует
описание задачи. Оно предназначено для цели вроде «Показывать актуальный прогресс и причины блокировки».
Интерфейс показывает закреплённую цепочку Astra → Luna / Sonnet; обычный переключатель модели недоступен.
После запуска режим не меняется, сохраняется при перезапуске и отображается в карточке процесса.

Это координатор одной точки PLAN, не постоянный чат-менеджер и не произвольный новый scheduler.
Discovery сначала читает проект; Astra получает только его статус и число вопросов. Typed orders передаются
исполнителю, который сам проверяет технические предположения по исходной задаче и правилам проекта.
Independent Review, Project verification, Browser QA и принятие владельцем остаются обязательными.

Лимит координатора — не более 12 000 estimated tokens и двух сессий на AgentRun, дополнительно ограниченный
остатком общего бюджета. Это post-session accounting, а не обещание остановить генерацию ровно на границе.
Недоступный или несовместимый Codex не заменяется Claude/Fable. Отдельная live qualification, проверка доступа
аккаунта к Astra и измерение стоимости/качества ещё нужны; этот срез их не подменяет.

## Локальные проверки

- Общий браузерный набор: 69/69. После уточнения подписей моделей и ширины полей повторены два новых сценария.
- Новый opt-in: EN/RU, light/dark, клавиатура, 375/1280 px, пустая цель блокирует запуск, reload сохраняет режим.
  Снимки проверены визуально; исходное описание задачи с code canary не копируется в отдельную цель.
- Crash-recovery drill: один interrupted run, без replay, один durable report.
- Сквозной synthetic CODEX workflow проходит через все шесть этапов до owner Acceptance; тест не запускает CLI.
- Валидация closed packet/plan DAG, запрет authority/model substitution, immutable policy, повтор команды и reopen.
- `pnpm verify` завершён успешно: formatting, public readiness, lint, typecheck и полный набор workspace tests.
  В том числе persistence: 213/213, daemon: 369/369, CLI: 33/33.
- После последних правок повторены web typecheck / lint / оба browser opt-in сценария; provider-core и Codex
  typecheck/lint, декодирование максимально длинных work orders (3/3), Codex adapter (6/6) и сквозной новый режим.
  CLI fixture явно synthetic: она проверяет успешный PLAN и argv, но не выдаётся за live recording.
- Public-tree/toolchain/activation и formatting повторно прошли; `git diff --check` чистый.
  Raw logs и снимки остаются вне Git. npm publication и admission changes не выполнялись.

## Закрытие review, 2026-09-20

- Обычный model mapping Astra больше не включает coordinator authority по имени модели: режим задаётся явно.
- Менеджер читает отдельные закрытые факты Discovery, а не обычный context graph с последующей фильтрацией.
- Служебные чтения session loop также сужены до metadata/counts; HumanRequest prose, checkpoint/recipe и activity
  payloads не загружаются для сборки/исполнения manager session. Scheduler/domain по-прежнему владеют полным state.
- Добавлены проверки capped count (2 и 50→20), точного checkpoint provenance, изоляции другого pipeline, запрета
  широких queries и handoff→reopen→session 2 с сохранением расхода. Ordinary full workflow остаётся покрытым.
- Оба reviewer повторно проверили исправления и SQL-семантику one-human-gate; открытых замечаний к diff не осталось.
  Результаты финальных проверок записываются в [evidence](../evidence/phase-8/CODE-BLIND-COORDINATOR-EVIDENCE.md).
