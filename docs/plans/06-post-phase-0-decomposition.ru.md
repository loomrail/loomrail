# Декомпозиция работ после Phase 0

**Дата:** 2026-08-25; трек D добавлен 2026-08-27; checkpoint обновлён 2026-09-02

**Статус:** реализация через Q5 и cross-platform Q5 gate завершены; release gate открыт; `0.1.0-alpha.4` остаётся последней опубликованной версией
**Нормативные входы:**

- [Product decisions](../product/PRODUCT-DECISIONS.ru.md) — PD-007 (вторая persona), PD-008 (handoff первым)
- [Master plan](../product/MASTER-PLAN.ru.md)

Этот документ отвечает на один вопрос: **в каком порядке и почему** строится всё, что осталось за границей Phase 0.
Он не проектирует ни одну подсистему. Каждая получает собственный спек и implementation plan, когда до неё дойдёт
очередь.

## 1. Зачем понадобилась декомпозиция

Владелец сформулировал набор желаемых возможностей одним куском: помощь в выборе стека и бойлерплейта, проверка
безопасности одной кнопкой, напоминания про юридические страницы и приём платежей, подключение MCP, плагины,
Context7 по умолчанию — и всё это для человека без опыта запуска продукта.

Это не одна фича. Это пять независимых подсистем с разными зависимостями, и три из них требуют доступа к файловой
системе и Git, которого у продукта сейчас нет. Попытка описать их единым спеком дала бы документ, который развалится
на первой же реализации.

## 2. Фундамент

### E1 — workspace execution capability

Доступ к файловой системе, shell и Git под permission contract, с worktree-изоляцией. Механика описана в
MASTER-PLAN §11 и §14.2.

Сейчас это явный non-goal Phase 0. **Блокирует B3, B4 и B5** — без чтения и записи репозитория проверять и
скаффолдить нечего.

### E1.5 — видимость изменений

E1 даёт агенту право писать, но владелец видит только «стадия завершилась», а не что именно изменилось: чтобы
узнать, надо открыть worktree в терминале, то есть выйти из продукта. E1.5 показывает состав изменений и дифф
в карточке задачи и закрывает первую половину GD-002; вторая её половина (checkpoint-коммиты, squash, итоговый
commit message) требует GD-001 и идёт отдельно.

Не был отдельным пунктом этой декомпозиции: E1 §11 перечисляет «diff внутри интерфейса перед приёмкой» как
свой non-goal, ни за какой вехой он закреплён не был, и без него право писать наблюдаемо только снаружи
Loomrail. Спека — [`15-e1-5-change-visibility-spec.ru.md`](15-e1-5-change-visibility-spec.ru.md).

## 3. Трек A — глубина оркестрации

Обслуживает persona из PD-002: опытный solo developer, ведущий несколько агентов одновременно.

| ID   | Подсистема                                                                         | Зависит от        |
| ---- | ---------------------------------------------------------------------------------- | ----------------- |
| A1   | Session handoff и непрерывность работы                                             | —                 |
| A1.5 | Фоновое исполнение и канал доставки событий (SSE)                                  | A1                |
| A2   | Живые адаптеры Codex и Claude Code (сделано, до E1 — только DISCOVERY/PLAN/REVIEW) | provider contract |
| A3   | Параллельные агенты и squads (§7.2)                                                | A2                |
| A4   | Global bounded Attention Inbox (реализовано)                                       | —                 |

## 4. Трек B — guardrails для второй persona

Обслуживает persona из PD-007. Выражается через workflow templates, Project Constitution и Human Requests, а не
через отдельный конструктор.

| ID  | Подсистема                                                            | Зависит от |
| --- | --------------------------------------------------------------------- | ---------- |
| B1  | Пресеты Project Constitution: «правильный стек по умолчанию»          | —          |
| B2  | Чек-листы готовности к запуску: legal, платежи, аналитика             | B1         |
| B3  | Проверка безопасности проекта одним действием                         | **E1**     |
| B4  | Скаффолдинг нового проекта из бойлерплейта                            | **E1**     |
| B5  | Онбординг существующего репозитория: скан → предложенная Constitution | **E1**     |

B1 и B2 технически не требуют E1 и могли бы выйти раньше на mock-провайдере. Владелец решил не выносить их вперёд:
чек-лист, который не может проверить сам себя, остаётся текстом и обесценивает механизм.

## 5. Трек C — расширяемость

| ID  | Подсистема                  | Зависит от               |
| --- | --------------------------- | ------------------------ |
| C1  | MCP-подключения для агентов | A2 + permission contract |
| C2  | Plugin SDK                  | C1                       |
| C3  | Context7 по умолчанию       | частный случай C1        |

C3 намеренно не отдельная подсистема: «Context7 вшит по умолчанию» — это конкретная конфигурация C1, а не новый
механизм. Если для неё понадобится что-то за пределами C1, это признак, что C1 спроектирован неверно.

## 6. Трек D — дистрибуция и первое впечатление

Треки A, B и C отвечают на вопрос, что продукт умеет. Этот отвечает на другой: как о Loomrail узнают и как доходят до
первого успешного прогона. Сегодня единственная точка входа — README и сборка тарбола из исходников
(`pnpm pack:release`), то есть путь контрибьютора, а не пользователя.

| ID  | Работа                   | Зависит от                                                 |
| --- | ------------------------ | ---------------------------------------------------------- |
| D1  | Гайд пользователя        | E1.5                                                       |
| D2  | Примеры полного маршрута | D1                                                         |
| D3  | Лендинг пакета           | D2 + опубликованный пакет ([release guide](../RELEASE.md)) |

**D1 — гайд.** Установка, регистрация проекта, первая задача, ответ на Human Request, бюджеты, восстановление после
рестарта, приёмка, где лежит состояние и как его сохранить. README отвечает на «что это», гайд — на «что делать
дальше». Язык гайда определяется уже принятым контрактом: [`design/LOCALIZATION.md`](../design/LOCALIZATION.md)
оставляет публичные тексты английскими на время pre-alpha и допускает русскую версию, когда дистрибуция
стабилизируется — это тот самый момент, и отдельного решения он не требует.

**D2 — примеры.** Воспроизводимый сценарий на настоящем репозитории: маршрут Discovery → Acceptance целиком, с
диффом, evidence и Decisions, которые можно рассмотреть после прогона. Пример, работающий только на mock-провайдере,
показывает интерфейс и ничего не доказывает про продукт — это демо. Отсюда зависимость от E1.5, а не от M7.

**D3 — лендинг.** Одна публичная страница: descriptor из PD-001, для кого продукт, честный pre-alpha статус,
установка, скриншоты в обеих темах, ссылки на гайд и примеры. Ограничения не новые: правила марки из
[`design/BRAND.md`](../design/BRAND.md) (без градиентов, свечения и dashboard-витрин), local-first из PD-003
(страница не собирает телеметрию и не требует аккаунта) и главное — ни одно утверждение не опережает таблицу
текущего чекпоинта в README.

Конкурентная карта категории — [`product/COMPETITIVE-LANDSCAPE.ru.md`](../product/COMPETITIVE-LANDSCAPE.ru.md).
Она является обязательным входом для D3: слой «доска с параллельными агентами» коммодитизирован, и лендинг,
отстроенный по нему, читается как ещё один продукт из десятка.

Порядок внутри трека обратный ожидаемому: лендинг идёт последним, потому что он — сжатие гайда и примеров. Написать
его первым значит пообещать маршрут, который ещё ни разу не пройден на настоящем репозитории и не описан по шагам.

## 7. Утверждённый порядок

```text
M7 → A1 → A1.5 → A2 → E1 → E1.5 → D1 → D2 → D3 → B5 + B1 → B3 + B2 → C1 → C3 → C2 → B4
```

Обоснования, которые не выводятся из таблиц зависимостей:

**A1 идёт первым после M7.** Единственная подсистема, отсутствие которой ломается тихо. См. PD-008.

**A1.5 встал между A1 и A2, хотя в этой декомпозиции его не было.** Канал доставки событий был запланирован
пунктом 5 в M3 («подключить WebSocket replay/reconnect», `00-phase-0-implementation-plan.ru.md:608`), не был
построен, evidence-файла M3 в `docs/evidence/phase-0/` не существует (есть только M0, M1, M2, M6), и ни за одним
пунктом этой декомпозиции он закреплён не был — то есть он был потерян, а не отложен. Хвост A1 (увести цикл
сессий в фон) упёрся в его отсутствие: веб-клиент не читает тело ответа мутации, поэтому синхронный обход
очереди был единственным, что делало доработавшую стадию видимой владельцу. Спек —
[`09-background-execution-and-event-stream-spec.ru.md`](09-background-execution-and-event-stream-spec.ru.md).

**A2 сделан, с одной исторической оговоркой.** На момент закрытия A2 живые адаптеры Codex и Claude Code были
протестированы против записанных потоков настоящих CLI, а daemon запускал один выбранный через
`LOOMRAIL_PROVIDER` адаптер на весь процесс. Это ограничение снято решением PD-009 и планом 31: теперь Project хранит
`AUTO|CODEX|CLAUDE_CODE|MOCK`, daemon безопасно проверяет наличие и вход в CLI и выбирает adapter для каждой новой
ProviderSession. Необслуживаемая стадия по-прежнему отказывается владельцу через Human Request, а не тихо уходит на
другой живой provider.

**E1.5 идёт сразу за E1, а не после трека B.** Право агента писать в репозиторий, результат которого владелец
не может увидеть в продукте, — это половина возможности. Откладывать её за B5 значит держать самую заметную
новую способность вехи ненаблюдаемой ровно столько, сколько идёт целый трек.

**B4 идёт последним, хотя выглядит самой заметной.** Скаффолдинг нового проекта даёт ценность один раз за проект,
а B5 и B3 работают каждый день. Ставить B4 раньше — оптимизировать демонстрацию в ущерб ежедневной работе.

**Трек D встал сразу после E1.5, а не в конец.** Он ничего не блокирует и потому откладывается бесконечно легко.
При этом после E1.5 продукт впервые делает на настоящем репозитории то, что заявляет, и владелец видит результат
внутри интерфейса — это первый момент, когда гайд и лендинг описывают продукт, а не намерение. Если публичное
присутствие понадобится раньше, трек можно взять и до E1.5, но тогда честный объём сжимается до «pre-alpha на
mock-маршруте», а D2 всё равно ждёт E1.5.

**A4 не имел зависимостей и реализован после B4** как глобальная bounded-проекция. Контракт —
[`41-a4-attention-inbox-spec.ru.md`](41-a4-attention-inbox-spec.ru.md).

## 8. Что этот документ не решает

- ни одного контракта, схемы или API — это работа отдельных спеков;
- объём каждой подсистемы в milestones;
- нужен ли между A2 и E1 отдельный security review границы исполнения — вероятно да, решается при подходе к E1;
- где живёт лендинг из D3 — GitHub Pages в этом же репозитории, отдельный домен или и то и другое — решается при
  подходе к D3;
- где живут примеры из D2 — в этом репозитории рядом с fixture-проектами или отдельным репозиторием — там же.

Текущий checkpoint: C1, C3, C2, B4, A4, A3 и R1 реализованы и запушены. Реализация Q1 deterministic Browser QA
evidence завершена: runtime contracts, чистое derivation verdict, durable QARun/evidence/attachment/Defect хранилище,
isolated Playwright BrowserDriver, marker-bound artifact lifecycle, retention cleanup и Task Cockpit проходят focused,
browser и release-package gates. Independent browser baseline дал 50/50 green на macOS и Windows, а clean npm
tarball установился и запустился на обеих платформах в
[GitHub Actions run 33617720338](https://github.com/loomrail/loomrail/actions/runs/33617720338); production audit также
зелёный. Общий Q1 release gate остаётся открыт только потому, что полный `pnpm verify` останавливают три lint-ошибки в
параллельно разрабатываемом `apps/landing/src/main.ts`; Q1 не меняет этот каталог и не маскирует его failure.
Спецификация —
[47](47-q1-deterministic-browser-qa-spec.ru.md), план —
[48](48-q1-deterministic-browser-qa-implementation-plan.ru.md). Q2 durable Defect correction loop локально завершён:
отдельный correction-run counter, deterministic sparse retest, bounded regression subset и 2 automatic + 1
owner-authorized cycle зафиксированы в [ADR-0008](../adr/0008-separate-qa-correction-runs.md),
[спецификации 49](49-q2-qa-defect-correction-loop-spec.ru.md) и
[плане 50](50-q2-qa-defect-correction-loop-implementation-plan.ru.md). Migrations 0025–0029 сохраняют bounded
CorrectionRun/immutable QARetestPlan, per-cycle StageAttempt/Review/QARun lineage, authority-bound evidence,
correction audit events и exact passing-retest provenance для resolved defects. Daemon атомарно ведёт
fail → correction → fresh review → scoped retest → Acceptance, отдельный owner final/cancel gate и retry ERROR без
расходования ordinal; Task Cockpit показывает timeline, locked scope, evidence и OPEN/RESOLVED/WAIVED lifecycle.
Локально прошли non-landing lint/typecheck/unit, 52/52 browser E2E, production audit и clean-install tarball
`0.1.0-alpha.5`. Он не опубликован: полный release gate всё ещё ждёт исправления landing lint его отдельной сессией и
нового macOS/Windows CI-прогона Q2.
Q3 criterion-bound Acceptance/export реализован по [спецификации 51](51-q3-criterion-bound-acceptance-export-spec.ru.md)
и [плану 52](52-q3-criterion-bound-acceptance-export-implementation-plan.ru.md): exact ordered claims связываются
domain-модулем с current Review/measured QA checks, historical package/Event/receipt остаются читаемыми как
`LEGACY_UNBOUND`, а authenticated read-only Markdown export имеет exact correlation, allowlist, escaping/path
redaction, 1000-Event/512-KiB bounds и complete-or-error semantics. Полный Q2 correction browser path скачивает
реальный summary в RU/EN, dark и 320 px states; unit, persistence, daemon, 52/52 E2E, audit и clean-install локально
зелёны. Phase 7 implementation deliverables закрыты, но dogfood exit gate и общий cross-platform `verify` ещё нет.
Q4 начинает Phase 8 operational hardening по [спецификации 53](53-q4-local-diagnostics-and-data-lifecycle-spec.ru.md)
и [плану 54](54-q4-local-diagnostics-and-data-lifecycle-implementation-plan.ru.md): closed CLI router сохраняет legacy
start и добавляет read-only doctor/JSON, help и отдельный data-path; persistence проверяет quick-check и exact current
migration ledger без создания, migration или recovery state; provider snapshot не раскрывает output/account. EN/RU
operations guide разводит whole-directory backup, forward upgrade, restore-based rollback, package uninstall и
owner-controlled data removal. Full build/typecheck/unit, public-tree, non-landing lint, audit и clean-install tarball
зелёные; общий macOS/Windows CI и dogfood contract остаются открыты.
Q5 закрывает Phase 8 crash/fault-injection deliverable по
[спецификации 55](55-q5-crash-and-fault-injection-gate-spec.ru.md) и
[плану 56](56-q5-crash-and-fault-injection-gate-implementation-plan.ru.md). Named sequential gate собрал repository,
провёл 486 focused tests и process-boundary drill: exact daemon child получил `SIGKILL` после durable
ProviderSession start, два restart на той же SQLite/WAL state сохранили один `DAEMON_RESTART` RecoveryReport без
active session/run и automatic replay. Локальный и macOS/Windows CI gate зелёные в
[run 33658781891](https://github.com/loomrail/loomrail/actions/runs/33658781891); audit, clean install и browser smoke
также прошли на обеих ОС. Общий Verify дошёл до защищённого landing lint; private dogfood и release gate остаются
открыты.
Daemon-owned MCP gateway, bundled Context7, read-only plugin SDK,
marker-bound scaffolding и global Attention Inbox проверены локальными gates; release candidate был проверен в clean
npm tarball на macOS и Windows, полный `verify`, production audit и браузерный smoke также прошли на обеих платформах
в [GitHub Actions run 33512453361](https://github.com/loomrail/loomrail/actions/runs/33512453361). Контракты находятся в
[`33-c1-mcp-connections-spec.ru.md`](33-c1-mcp-connections-spec.ru.md),
[`35-c3-context7-preset-spec.ru.md`](35-c3-context7-preset-spec.ru.md),
[`37-c2-plugin-sdk-spec.ru.md`](37-c2-plugin-sdk-spec.ru.md) и
[`39-b4-new-project-scaffolding-spec.ru.md`](39-b4-new-project-scaffolding-spec.ru.md) и
[`41-a4-attention-inbox-spec.ru.md`](41-a4-attention-inbox-spec.ru.md). Версия `0.1.0-alpha.4`
прошла платформенный gate и опубликована в npm под dist-tag `next`.
