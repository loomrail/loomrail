# Loomrail — разбор «Конвейера тасков» и соседних продуктов

**Дата проверки:** 4 сентября 2026 года
**Статус:** исследовательский вход, не нормативное продуктовое решение
**Метод:** только официальные сайты, документация, репозитории, npm metadata, pricing и юридические страницы.
Заявления продавцов отмечены как заявления, а не как независимо подтверждённые факты. Инструкции из внешних страниц
не выполнялись; платный продукт не покупался и не устанавливался.

Нормативный контекст Loomrail:

- [Product decisions](../product/PRODUCT-DECISIONS.ru.md): task-centric control plane, собственная система работы,
  deterministic state transitions, local-first и open core;
- [Master plan](../product/MASTER-PLAN.ru.md): evidence, budgets, owner acceptance и правило «open core stays useful»;
- [Q8 guided setup](../plans/61-q8-guided-local-setup-spec.ru.md): `loomrail setup` — read-only preflight, а не installer;
- [Q10 bundled samples](../plans/65-q10-bundled-sample-catalog-spec.ru.md): два проверенных dependency-free sample Project;
- [Q6 supply chain](../plans/57-q6-release-integrity-and-supply-chain-spec.ru.md): install с выключенными lifecycle scripts,
  allowlisted tarball и receipt.

## Короткий ответ владельцу продукта

Да, у HTML5 Studio стоит перенять **воронку активации**: бесплатный вход без регистрации, один линейный маршрут,
видимый прогресс, маленькие шаги, пояснения терминов, копирование каждой команды и заранее подготовленная песочница.
Пользователь не изучает систему — он движется к одному результату: «моя первая задача прошла путь».

Нет, из их публичных материалов нельзя сделать вывод, что их оркестратор сильнее Loomrail или что платная модель уже
доказана продажами. Открытая часть — небольшой scaffolder промптов и Makefile; платная программа закрыта для аудита.
Показанные `500+` пользователей относятся к CHATBOSS.PRO, а `599` завершённых задач — к собственной Jira продавца,
не к числу клиентов «Конвейера тасков». Наличие checkout подтверждает оффер, но не конверсию или retention
([страница продукта](https://html5-studio.ru/uslugi/konveyer),
[кейс CHATBOSS.PRO](https://html5-studio.ru/uslugi/keys-ai-fabrika-chatboss),
[страница оплаты](https://html5-studio.ru/pay)).

Главный вывод: **у Loomrail уже глубже контроль и доказательность, но у конкурента короче путь к “ага-моменту”**.
Нам не нужен их provider-driven workflow; нам нужен их способ провести новичка через первый опыт.

## 1. Что именно продаёт HTML5 Studio

### 1.1. Три ступени одной воронки

На странице выбора показаны три варианта:

1. бесплатный курс без регистрации;
2. «коробка» раннего доступа за `9 900 ₽`;
3. внедрение под ключ после бесплатного аудита.

Бесплатная ступень обещает одну задачу за раз, платная — параллельные задачи, карточки, worktree и два AI-review,
а услуга — Docker, тестовый стенд, автотесты и deploy. Это хорошая продуктовая лестница: бесплатный маршрут не просто
рассказывает, а готовит Jira и Claude Code к следующей покупке
([выбор формата](https://html5-studio.ru/uslugi/konveyer#forks),
[внедрение под ключ](https://html5-studio.ru/uslugi/ai-konveyer-zadach)).

### 1.2. Бесплатный вход устроен лучше обычной документации

[Курс](https://html5-studio.ru/uslugi/kurs-ai-konvejer#steps) ведёт через четыре шага:

1. `npx konveyer init`;
2. создать Jira API token;
3. открыть Claude Code и передать готовый setup-текст;
4. создать Jira issue и назвать агенту её номер.

У каждого шага есть номер, кнопка «Готово», краткое пояснение и tooltip «зачем это нужно». Счётчик `0/4` даёт
прогресс, состояние сохраняется локально в браузере. Команды и два готовых текста копируются одной кнопкой; ссылка на
Atlassian ведёт сразу к созданию токена. Если своего проекта нет, предлагается
[готовая песочница `konveyer-starter`](https://github.com/ressh/konveyer-starter).

Почему это работает как onboarding:

- маршрут обещает наблюдаемый outcome, а не «изучение возможностей»;
- каждое действие достаточно мало, чтобы его завершить сразу;
- жаргон объясняется на месте, не в отдельной документации;
- первый опыт бесплатен и не требует аккаунта у продавца;
- после результата объясняется естественный предел бесплатной версии — одна задача за раз;
- этот предел напрямую связывается с платным upgrade на параллельный launcher.

Есть и редакционный долг: страница курса говорит о четырёх шагах, а карточка бесплатного формата — о трёх уроках.
Для Loomrail это полезное напоминание: одна canonical first-run sequence должна генерировать лендинг, README и guide,
иначе простота быстро превращается в расхождение.

### 1.3. Что реально делает `npx konveyer init`

На момент проверки npm публикует `konveyer@0.1.2`: Node.js `>=18`, MIT, без объявленных dependencies; package состоит
из CLI, четырёх prompts, templates, Makefile, README и license
([package manifest](https://github.com/ressh/konveyer-taskov/blob/master/package.json),
[npm](https://www.npmjs.com/package/konveyer)).

Это не установка полного оркестратора. Открытый CLI:

- проверяет Node, Git, наличие `claude` и `.env`;
- создаёт либо дописывает секцию Jira в `CLAUDE.md`;
- копирует `prompts/` и `Makefile`;
- создаёт `.env.example`, если такого файла нет;
- не перезаписывает одноимённые файлы, кроме осознанного append в существующий `CLAUDE.md`.

Это подтверждается самим
[`bin/cli.js`](https://github.com/ressh/konveyer-taskov/blob/master/bin/cli.js#L102-L176). Следовательно, фраза
«ставится одной командой» точна как описание короткого UX, но неточна как модель authority: команда сразу меняет
рабочий каталог без preview конкретного file plan.

Поставляемый [Makefile](https://github.com/ressh/konveyer-taskov/blob/master/Makefile) ещё важнее для сравнения. По
явной команде пользователя он делает `git fetch`, создаёт branch/worktree, копирует `.env`, запускает Claude, а
`make done` checkout/pull/merge/push в base branch, затем force-remove worktree. В `CLAUDE.md` агенту поручено самому
читать Jira, менять статусы, реализовывать, просить subagent-review и закрывать issue
([шаблон регламента](https://github.com/ressh/konveyer-taskov/blob/master/templates/CLAUDE-jira.md)).

Это простая и эффектная автоматизация, но не детерминированный control plane:

- provider и его prompt являются фактическим workflow engine;
- статус Jira меняется самим агентом;
- review — инструкция агенту, а не независимо связанный gate с evidence;
- merge/push/cleanup находятся в shell recipe, без Loomrail-подобных version conflicts, durable decisions и recovery;
- `.env` копируется в worktree, а ошибка копирования подавляется;
- изменяемые файлы не показываются пользователю до записи.

Именно это **не следует переносить** в Loomrail. Сильная сторона конкурента — UX-поверхность над маршрутом, не его
authority model.

### 1.4. Платный оффер: факты и предел проверки

На [основной странице](https://html5-studio.ru/uslugi/konveyer#preorder) заявлены:

- ранний доступ за `9 900 ₽`, после 20 сентября — `29 900 ₽`;
- одна оплата, бессрочный доступ и будущие обновления без доплат;
- Jira cards, запуск кнопкой, параллельные окружения и два AI-review;
- персональная ссылка после оплаты;
- macOS/Ubuntu, Windows «с оговорками»; 8 ГБ для 1–2 задач, 16–32 ГБ для волн;
- Git 2.30+, Node 18+, Claude Code, Jira Cloud token и отдельная подписка Claude (для волн рекомендуется Max).

[Оплата](https://html5-studio.ru/pay) действительно открывает checkout на `9 900 ₽`. Лицензия — простая
неисключительная, бессрочная, на два устройства; запрещены перепродажа, передача, публикация и SaaS, а ранним
покупателям обещаны обновления без доплат
([лицензия](https://html5-studio.ru/license), [оферта](https://html5-studio.ru/oferta)).

Однако публичные страницы не дают проверить само приложение, число покупок, retention или экономику поддержки.
Есть также существенная неоднозначность current/future:

- `/uslugi/konveyer` говорит, что ранний доступ и работающий в браузере продукт выдаются сразу, а desktop build придёт
  20 сентября;
- `/uslugi/manual-ai-konvejer` и checkout говорят, что после оплаты открывается ссылка, а само приложение с prompts
  «придёт по ней к релизу 20 сентября».

Корректный вывод: это **реальный коммерческий smoke test и предзаказ**, но не доказательство готовности или спроса.
Loomrail должен сохранить более строгую матрицу «доступно сейчас / запланировано / не обещаем».

## 2. Ближайшие прямые и смежные инструменты

| Продукт                                                             | Единица и маршрут работы                                                                                                                | Onboarding                                                                                                                                                                                                                                | Проверка и authority                                                                                                                                                                                                                                                                                                                             | Модель денег                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conductor](https://www.conductor.build/docs)                       | Workspace связывает task/issue/PR, branch, Git worktree, terminal, chats и review; поддерживаются Claude Code, Codex, Cursor и OpenCode | Desktop install, затем автоматические checks GitHub/provider login и первый workspace; сейчас только macOS ([install](https://www.conductor.build/docs/installation))                                                                     | Diff Viewer, inline comments, agent review, tests/app, GitHub checks и merge flow. Документация рекомендует блокировать merge при незакрытых checks, но не доказывает отдельную deterministic state machine ([workflow](https://www.conductor.build/docs/concepts/workflow), [review](https://www.conductor.build/docs/guides/review-and-merge)) | Free local; Pro `$50/month`, Teams `$60/user/month`, Enterprise custom; paid value находится в cloud, collaboration, API, mobile и enterprise controls ([pricing](https://www.conductor.build/pricing))                                                                                                                           |
| [Agent Orchestrator](https://aoagents.dev/docs/)                    | Project → session → isolated worktree/branch → PR/CI/review; 20+ harnesses, capability-gated Chat или native terminal                   | Canonical path — готовый desktop download, выбор repo и одного малого task; legacy npm заморожен и больше не рекомендуется ([installation](https://aoagents.dev/docs/installation/), [quickstart](https://aoagents.dev/docs/quickstart/)) | Status выводится из session и PR facts; есть review runs, follow-ups, notifications и browser preview. Фокус ближе к session/workspace supervision, чем к criterion-bound acceptance                                                                                                                                                             | Apache-2.0; публичного платного tier на проверенных страницах не найдено ([repository](https://github.com/Untrivial-ai/agent-orchestrator))                                                                                                                                                                                       |
| [Mission Control](https://github.com/builderz-labs/mission-control) | Self-hosted task/agent control plane с SQLite; task проходит inbox, assignment, execution, review, quality review и completion          | Source install script или Docker, затем локальный `/setup`, admin account и при необходимости API key                                                                                                                                     | Aegis approval record перед `done`, audit/security events, completion receipts, spend, schedules, OpenAPI/CLI/MCP. Это самый близкий сосед Loomrail по governance-языку, но публичный quickstart тяжелее                                                                                                                                         | MIT, self-hosted; отдельного публичного коммерческого pricing не найдено                                                                                                                                                                                                                                                          |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)               | Kanban issue → agent workspace с branch/terminal/dev server → diff/inline feedback → PR/merge; 10+ agents                               | Эталонно короткий вход: `npx vibe-kanban`; затем provider preferences и account ([getting started](https://vibekanban.com/docs/getting-started))                                                                                          | Хороший review UX и browser preview, но главный итог — reviewed PR/merge, не durable owner acceptance                                                                                                                                                                                                                                            | Пытался продавать Pro `$30/user/month` и Enterprise; 10 апреля 2026 компания объявила shutdown, возвраты и прекращение подписок, потому что большинство оставались free и бизнес-модель не сложилась ([официальное объявление](https://www.vibekanban.com/blog/shutdown), [pricing snapshot](https://www.vibekanban.com/pricing)) |

### Что эта карта говорит о категории

1. Worktree, параллельные агенты, dashboard и diff уже стали базовой категорией. Их наличие не создаёт moat.
2. Самый понятный onboarding либо начинается одной командой (`Vibe Kanban`), либо готовым desktop build с setup checks
   (`Conductor`, `AO`). Source install и account/API setup Mission Control заметно тяжелее.
3. Платёжеспособная поверхность чаще находится **над бесплатным local core**: cloud continuity, collaboration, API,
   admin/SSO, SLA и support. Conductor — наиболее ясный действующий пример.
4. Vibe Kanban — прямое предупреждение: большая бесплатная аудитория и сильный UX не гарантируют коммерческую модель.
5. Loomrail уже занимает более редкий слой: deterministic gates, criterion-bound evidence, budgets, recovery и
   owner-only acceptance. Эту глубину нужно сделать видимой в первые десять минут.

## 3. Где Loomrail уже сильнее, а где проигрывает

| Ось              | HTML5 Studio / `konveyer`                                           | Loomrail сейчас                                                                                   | Вывод                                                                         |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Первый вход      | Бесплатно, без регистрации, четыре маленьких шага, progress и copy  | Без аккаунта и с Mock, но canonical путь — несколько terminal-команд плюс шесть продуктовых шагов | Сжать и визуализировать путь, не ослабляя consent                             |
| “Ага-момент”     | Агент реально двигает Jira issue и пишет код                        | Полный mock route до Human Request, Review, QA и Acceptance                                       | У Loomrail содержательнее результат; его надо дать как готовый guided mission |
| Источник истины  | Jira + `CLAUDE.md` + provider instructions                          | WorkItem, validated transitions, Events и Decisions                                               | Не менять ради внешней Jira                                                   |
| Изоляция         | worktree через Makefile; paid app обещает waves                     | per-task worktree, writer leases, durable scheduler                                               | Loomrail глубже, но объясняет это тяжелее                                     |
| Review           | subagent по prompt; в paid claim — два reviewer                     | independent AgentRun, findings, bounded correction, deterministic QA                              | Показывать evidence package, а не только говорить «два ревьюера»              |
| Git authority    | user-triggered recipe может merge/push base и force-remove worktree | не commit/push/merge без владельца                                                                | Сохранить границу; превратить её в продающее преимущество                     |
| Recovery и audit | публично не показаны как domain contract                            | SQLite state, Event log, restart recovery, receipts                                               | Сделать restart demo частью free wow-moment                                   |
| Коммерция        | checkout, one-time license, services                                | open core; paid cloud отложен                                                                     | Тестировать paid onboarding/support, не закрывать local core                  |

### Исходный внутренний разрыв перед Q15

На момент исследовательского среза публичная поверхность Loomrail не была canonical:

- [landing install block](../../apps/landing/index.html#L317-L365) показывает `npm install loomrail@next` и
  `npx loomrail`, но не `--ignore-scripts`, Chromium, `setup` и `start`;
- [README](../../README.md#L37-L70) и
  [русский getting started](../guides/GETTING-STARTED.ru.md#L22-L60) требуют безопасный полный маршрут:
  `npm install --ignore-scripts`, явный Chromium install, `loomrail setup`, затем `loomrail start`;
- landing всё ещё маркирует capture и scope как `0.1.0-alpha.2`, а текущий release candidate —
  [alpha.5](../releases/0.1.0-alpha.5.md).

Q15 устраняет drift README и RU/EN guides через один validated contract и `loomrail try`; protected landing остаётся
отдельным незакрытым consumer-гейтом. До его авторизованного обновления новый marketing funnel всё ещё нельзя считать
canonical: копирование «одной удобной команды» там ухудшит безопасность и доверие вместо повышения activation.

## 4. Что добавить в Loomrail

### P0 — до расширения продукта

#### 1. Один canonical install contract

Сделать одну версионируемую install-модель, из которой получают текст landing, README, RU/EN guide и release note.
Сейчас важнее **одна кнопка копирования полного безопасного блока**, чем буквально одна shell-команда.

После публикации package и registry provenance можно дать один entry command, который открывает guided setup. Но
формулировка должна быть честной: «одна команда открывает onboarding», а не «сама всё устанавливает». Chromium,
provider login, запись проекта и любые authority-bearing действия должны остаться явными действиями владельца.

#### 2. Бесплатный guided mission вместо общего tour

Добавить на сайт отдельный маршрут «Пройти первую поставку бесплатно» и повторить его в приложении:

1. проверить среду через Q8;
2. инициализировать demo workspace;
3. выбрать Mock;
4. создать задачу из одной Q10 recipe;
5. ответить на Human Request и решить вопрос бюджета;
6. открыть Review/QA evidence и принять или вернуть поставку;
7. скачать Acceptance Package.

Каждый шаг должен иметь короткий outcome, статус, «зачем это нужно» и одну primary action. На marketing page прогресс
может жить только локально. Внутри приложения он должен выводиться из реального durable state, а не становиться второй
копией workflow truth.

#### 3. Seeded task, а не пустая форма

В demo workspace дать кнопку «Создать первую задачу из примера» с preview goal, non-goals и acceptance criteria.
Источником должны стать уже проверенные Q10 recipes. Это устраняет самый трудный шаг новичка — придумать хорошую
задачу — и не добавляет второй workflow engine.

#### 4. Сделать Acceptance Package главным wow-moment

Конкуренты заканчивают «агент написал код» или «PR готов». Loomrail должен заканчивать onboarding экраном:

> Поставка пережила остановку, прошла независимое Review и QA, связана с критериями, а окончательное решение приняли вы.

Рядом показать diff summary, findings, QA evidence, budget/usage, Decision и кнопку экспорта. Это продуктовая
демонстрация уникального слоя Loomrail, а не ещё одна Kanban-картинка.

#### 5. Полоса доступного лимита провайдера — отдельно от бюджета Loomrail

Показывать рядом с подключённым provider короткие окна вида `Codex · 5 ч: 96% осталось · сброс 01:27` и
`Claude · 7 д: 89% осталось`. Это не требует парсинга терминального текста:

- Codex App Server имеет `account/rateLimits/read`, notification `account/rateLimits/updated` и multi-bucket
  `rateLimitsByLimitId`; окно содержит `usedPercent`, `windowDurationMins` и `resetsAt`
  ([официальный App Server protocol](https://learn.chatgpt.com/docs/app-server#rate-limits-chatgpt));
- Claude Code передаёт в documented status-line JSON
  `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` и `resets_at`; поля доступны не
  для каждого auth/plan и могут отсутствовать
  ([официальная документация status line](https://code.claude.com/docs/en/statusline#available-data)).

Нужен optional provider capability, а не новый источник product truth. Адаптер нормализует provider, bucket,
`usedPercent`, вычисленный `remainingPercent`, reset time, `observedAt` и состояние `LIVE | STALE | UNAVAILABLE`.
Идентификаторы аккаунта и credentials не сохраняются. Для Codex это означает отдельную интеграцию с App Server рядом
с существующим CLI adapter; для Claude — явный безопасный bridge к structured status data. Перехватывать пользовательский
status-line script, переписывать его settings или scrape-ить ANSI-строку нельзя.

Особенно важно не смешать два разных ограничения:

- **Provider allowance** — внешний, изменяемый и иногда отсутствующий сигнал доступной мощности;
- **Loomrail budget** — внутренний authoritative hard limit задачи/проекта по tokens, cost estimate, времени, попыткам и
  concurrency.

На первом этапе provider allowance только информирует владельца и scheduler. Фактический rate-limit переводит run в
typed attention state с временем reset; низкий процент не должен самовольно отменять уже разрешённую работу. Loomrail не
выводит стоимость из процентов и не показывает stale estimate как live fact.

#### 6. Автотесты как измеряемый gate, а не зелёная подпись агента

У Loomrail это не greenfield: Q1 уже запускает обязательный deterministic Playwright baseline над exact implementation
tree, а Q2 создаёт durable defect → correction → independent review → scoped retest loop. Поэтому правильное действие —
сделать этот механизм заметным в первом маршруте и расширить его отдельным, owner-approved verification plan для
существующих unit/integration/E2E scripts.

В Task Cockpit стоит показывать:

- группы проверок, точную команду/recipe, status, число passed/failed, duration и platform;
- привязку к code snapshot и явное `STALE`, если после прогона дерево изменилось;
- bounded/redacted log excerpt, screenshots/trace для browser QA и ссылку на полный evidence;
- какой failure открыл Defect, какая correction его исправляла и какой fresh retest закрыл;
- блокировку Acceptance, пока обязательные проверки не current и не passing.

Onboarding scanner может предложить найденные команды, но не должен автоматически запускать произвольный
`package.json` script. Владелец сначала видит constructed argv и принимает versioned `.loomrail/` recipe. Не следует
добавлять автоматические push, merge или deploy: это отдельные authority decisions, а не часть «автотестов».

#### 7. Progressive disclosure для терминов

Перенять у курса маленькие `?` рядом с `Human Request`, `budget`, `checkpoint`, `worktree`, `Acceptance Package`.
Пояснение должно отвечать «почему это нужно владельцу» и ссылаться на подробный guide, не повторять документацию.

### P1 — после выравнивания first-run

#### 8. Три явных пути после бесплатного mission

- **Продолжить бесплатно:** local core + Mock + samples.
- **Подключить свой repo/provider:** readiness scan, preview constitution/rules, explicit owner confirmation.
- **Нужна помощь:** запрос платного guided onboarding.

Не добавлять Jira как обязательный шаг. По PD-005 Jira/YouTrack/Linear могут быть adapters/import/export, но Loomrail
остаётся владельцем workflow truth.

#### 9. Возобновляемый onboarding

На сайте достаточно local progress. В приложении после restart должна открываться ровно та же незавершённая mission,
с объяснением, какое состояние восстановлено. Для Loomrail это одновременно удобство и живое доказательство recovery.

#### 10. Proof ledger вместо маркетинговых счётчиков

Показывать release, exact shipped capabilities, macOS/Windows CI, package receipt, threat model, demo capture и
воспроизводимый acceptance export. Не заимствовать `500+ users`/`599 tasks`-стиль, пока нет независимо проверяемой
методики и согласия на публикацию.

## 5. Что можно продавать

### Ближайший безопасный оффер

Не закрывать функции local core. Продавать работу и уверенность вокруг него:

**Loomrail Guided Launch** — фиксированный onboarding-пакет:

- readiness/security audit проекта;
- предложение Project Constitution и workflow policy с preview;
- проверка provider compatibility;
- настройка первого реального task route;
- разбор первого Acceptance Package;
- ограниченный срок сопровождения, например 30 или 90 дней.

Такой оффер можно проверить ещё до cloud billing. Он согласуется с open core и не требует обещать, что неизвестная
экономика поддержки покрывается одной оплатой «навсегда».

### Возможная лестница позднее

| Уровень         | Что остаётся ценностью                                                           | Почему пользователь платит                                                        |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Community       | Полезный Apache-2.0 local core, Mock, samples, полный accountable workflow       | Доверие, adoption, переносимость                                                  |
| Supported Local | Guided launch, verified environment review, priority support, training           | Экономия времени и снижение риска, не искусственный feature lock                  |
| Team / Cloud    | Sync, collaboration, RBAC, remote/hosted workers, central policies, shared audit | Повторяющаяся операционная ценность; это будущий scope, не текущая alpha-обещание |
| Enterprise      | SSO/SCIM, DPA, SLA, policy packs, audit retention/export, deployment support     | Procurement, governance и ответственность                                         |

Conductor подтверждает, что free local + paid cloud/collaboration — понятная рынку упаковка. Vibe Kanban одновременно
предупреждает: нельзя считать её доказанной только потому, что у продукта много бесплатных пользователей.

### Чего не обещать

- «Все обновления навсегда» за разовый платёж до измерения support cost.
- Платный local fork, искусственно ослабляющий Apache core.
- SLA, provider compatibility или сроки desktop/cloud без закрытых evidence gates.
- Автоматический merge/deploy как premium value.
- «Экономию в X раз», число клиентов или задач без определённой и проверяемой методики.

## 6. Практический порядок действий

1. **Исправить landing drift**: версия, текущие возможности и install block должны совпасть с alpha.5 candidate и
   canonical safe quick start.
2. **Собрать `/try`-маршрут** из существующих Q8 + Q10 + Acceptance Package, не создавая новую domain model.
3. **Добавить один-click recipe** для первой задачи и resumable progress, derived from durable state.
4. **Показать provider allowance bar** для подключённого Codex/Claude: remaining percent, window, reset и freshness;
   рядом, но отдельно показать authoritative task/project budget Loomrail.
5. **Сделать автотесты видимым acceptance gate**: seeded demo проходит Browser QA, а live repo получает только
   owner-approved test recipes, snapshot-bound results и automatic correction/retest.
6. **Показать конечный receipt/evidence screen** крупнее board и Fleet.
7. **Проверить коммерческий спрос без feature gate**: после успешной mock acceptance дать необязательную ссылку
   «Помочь подключить реальный проект» на bounded paid onboarding. Никаких скрытых telemetry или background sender;
   интерес можно собирать только явным owner action.
8. После нескольких реальных запусков решить отдельно: fixed-price service, support subscription или будущий Team
   plan. Не принимать lifetime-pricing только потому, что его показывает один конкурент.

## Источники

### HTML5 Studio

- [Бесплатный курс](https://html5-studio.ru/uslugi/kurs-ai-konvejer)
- [«Конвейер тасков»: продукт, варианты, цена, требования](https://html5-studio.ru/uslugi/konveyer)
- [Отдельная страница предзаказа](https://html5-studio.ru/uslugi/manual-ai-konvejer)
- [Внедрение под ключ](https://html5-studio.ru/uslugi/ai-konveyer-zadach)
- [Кейс CHATBOSS.PRO](https://html5-studio.ru/uslugi/keys-ai-fabrika-chatboss)
- [Страница оплаты](https://html5-studio.ru/pay)
- [Лицензия](https://html5-studio.ru/license)
- [Оферта](https://html5-studio.ru/oferta)
- [`ressh/konveyer-taskov`](https://github.com/ressh/konveyer-taskov)
- [`ressh/konveyer-starter`](https://github.com/ressh/konveyer-starter)
- [`konveyer` на npm](https://www.npmjs.com/package/konveyer)

### Другие инструменты

- [Conductor docs](https://www.conductor.build/docs),
  [installation](https://www.conductor.build/docs/installation),
  [workflow](https://www.conductor.build/docs/concepts/workflow),
  [pricing](https://www.conductor.build/pricing)
- [Agent Orchestrator docs](https://aoagents.dev/docs/),
  [installation](https://aoagents.dev/docs/installation/),
  [quickstart](https://aoagents.dev/docs/quickstart/),
  [repository](https://github.com/Untrivial-ai/agent-orchestrator)
- [Mission Control repository](https://github.com/builderz-labs/mission-control)
- [Vibe Kanban repository](https://github.com/BloopAI/vibe-kanban),
  [getting started](https://vibekanban.com/docs/getting-started),
  [pricing snapshot](https://www.vibekanban.com/pricing),
  [shutdown announcement](https://www.vibekanban.com/blog/shutdown)

### Лимиты провайдеров

- [Codex App Server: ChatGPT rate limits](https://learn.chatgpt.com/docs/app-server#rate-limits-chatgpt)
- [Claude Code: structured status-line data](https://code.claude.com/docs/en/statusline#available-data)
- [Claude Code: usage-limit errors and `/usage`](https://code.claude.com/docs/en/errors#usage-limits)
