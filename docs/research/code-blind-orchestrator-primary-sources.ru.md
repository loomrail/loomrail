# Оркестратор без доступа к коду: первичные источники и проектная гипотеза

**Проверено:** 2026-09-19. **Статус:** исследование для следующей задачи; не реализация и не доказательство экономии.

Запрос владельца: включаемый режим, в котором сильная модель составляет план и распределяет работу, но не читает и
не пишет код. Чтение, реализация и проверка поручаются Luna/Sonnet. Требуется уменьшить суммарный расход токенов без
ухудшения результата. Проверены официальные документы, опубликованные авторами исходники и текущие контракты
Loomrail. Квотные provider sessions, API-запросы генерации и платные эксперименты при исследовании не запускались.

## 1. Вывод

Подход существует: **manager / orchestrator-workers**, в терминологии OpenAI — **agents as tools**. Менеджер оставляет
за собой планирование, вызывает ограниченных специалистов и получает их результаты. Это соответствует запросу лучше,
чем передача разговора специалисту через handoff. Документация рекомендует добавлять специалистов при реальной
необходимости разделить инструменты, ответственность или политику. [OpenAI: orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration).

Для Loomrail рекомендуемый вариант — собственная оркестрация поверх уже существующих local CLI adapters. Модель
предлагает план; детерминированный домен проверяет его и владеет исполнением. Это проектный вывод из требований
владельца и [TD-001—003](../product/PRODUCT-DECISIONS.ru.md), [MASTER-PLAN](../product/MASTER-PLAN.ru.md) и
[ADR-0015](../adr/0015-local-subscription-cli-runtimes.md), а не готовая возможность, автоматически возникающая от смены
model tier.

Экономия **не гарантируется самим делегированием**. Anthropic сообщает о 90,2% улучшении своего внутреннего research
eval для Opus 4 + Sonnet 4 относительно одного Opus 4, но также о примерно 15× токенов у multi-agent против обычного
чата; у одного агента — около 4× чата. Это разные базовые режимы, не «15× против одного агента», не coding benchmark
и не прогноз для современных моделей. Авторы отдельно предупреждают о тесно связанных coding tasks.
[Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

## 2. Модели и фактическая доступность

| Роль            | Точный кандидат    | Что подтверждено                                                                  | Что ещё не доказано                                                           |
| --------------- | ------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Менеджер Codex  | `gpt-6-astra`      | Официальный пример `codex -m gpt-6-astra`; локальный model cache содержит этот ID | Пригодность exact CLI runtime для нового режима и качество на наших задачах   |
| Worker Codex    | `gpt-5.6-luna`     | Официальный CLI ID; есть в локальном cache и нынешнем `FAST` mapping Loomrail     | Качество конкретных coding/review задач при выбранном effort                  |
| Менеджер Claude | `claude-fable-5-1` | Fable 5.1 поддерживается начиная с Claude Code 2.1.257                            | Доступ конкретной подписки, billing basis, полное соблюдение запрета fallback |
| Worker Claude   | `claude-sonnet-5`  | Официальный ID; Claude Code начиная с 2.1.197; нынешний `STANDARD` Loomrail       | Доступ аккаунта и метрики в ограниченном режиме Loomrail                      |

OpenAI прямо описывает Luna как модель для узких, ясных и повторяемых заданий; «лучшая» Astra — характеристика
вендора, не результат нашего сравнения с Fable. Доступ зависит от клиента, способа входа и rollout.
[OpenAI: models](https://learn.chatgpt.com/docs/models),
[OpenAI: Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra).

У Claude alias `best` может разрешиться в Opus, `fable` зависит от версии CLI и gateway. Для воспроизводимости нужны
точный ID и проверка реально исполненной модели. Fable иногда расходует **usage credits**, а не включённые лимиты;
в headless `-p` CLI может списать их без диалога. Fable/Opus также имеют автоматическое переключение после некоторых
отказов; `switchModelsOnFlag=false` документирован как отказ без переключения в headless. Эти свойства требуют
квалификации и отдельной политики до запуска; скрыто включать платный режим или обходить отказ нельзя.
[Claude Code: model configuration](https://code.claude.com/docs/en/model-config).

Локальная read-only проверка: `codex-cli 0.155.0-alpha.9`, Claude Code `2.1.260`. Model cache Codex от 2026-09-19
содержал Astra и Luna с default `medium`; чтение cache не подтверждает успешную генерацию. На момент проверки
[admission Codex](../../packages/provider-codex/src/diagnostics.ts) содержал macOS arm64 до отдельной версии
`0.154.0-alpha.6.2`. Не следует объявлять новую установленную версию поддержанной по одному `--version`.

Текущие mappings: [Codex](../../packages/provider-codex/src/index.ts) — Luna / Terra / Sol;
[Claude](../../packages/provider-claude-code/src/index.ts) — Haiku / Sonnet 5 / Opus 5. Следовательно, нынешний `DEEP`
не выбирает Astra или Fable. Менеджеру нужен отдельный immutable model selection, а не глобальная подмена всех DEEP.

В [каталоге встроенных ролей](../../packages/domain/src/agents.ts) уже есть `builtin.lead-pm`, но его
`allowedCapabilities` включают `REPOSITORY_READ` и `MCP_READ`. Поэтому существующий Lead PM не удовлетворяет
запрету владельца на чтение кода; переименования роли или выбора DEEP недостаточно. Нужны отдельные capability
и context projection, а не просто переключатель существующего профиля.

## 3. Сравнение схем

| Схема                                     | Соответствие требованию                                                                    | Решение для Loomrail                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Сильная модель на всех этапах             | Понятный baseline качества, но сильная модель видит код                                    | Только сравнительный baseline, не новый режим                 |
| Claude `opusplan`                         | Дорогая модель планирует, Sonnet исполняет; plan mode допускает исследование кода          | Не обеспечивает требуемый запрет                              |
| Native Codex subagents / Claude subagents | Есть отдельные модели, контексты и ограничения инструментов                                | Полезные первичные примеры; не передавать им domain authority |
| Claude agent teams                        | Независимые контексты и координация; значительный overhead, автоматический project context | Не брать за экономичный default                               |
| Loomrail manager + bounded worker runs    | Можно отделить code-free input, grants, budgets, durable work orders                       | Рекомендуемая гипотеза для следующего ADR и реализации        |

Claude Plan/Explore — read-only исследователи кода. С 2.1.198 Explore наследует модель с ограничениями, а не всегда
работает на Haiku: полагаться на имя встроенного агента для экономии нельзя. Custom subagents имеют собственные tools
и model, но часть project context может загружаться автоматически.
[Claude Code: subagents](https://code.claude.com/docs/en/sub-agents).

Codex позволяет явно задавать worker model и reasoning effort, иначе они могут наследоваться от родителя. Такие
настройки надо фиксировать на каждый run; родитель на Astra сам по себе не делает дочерние задачи дешёвыми.
[OpenAI: subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Claude agent teams особенно невыгодны для последовательных задач, правок одних файлов и тесных зависимостей; каждый
участник добавляет свой контекст. Это аргумент против запуска нескольких работников «на всякий случай».
[Claude Code: agent teams](https://code.claude.com/docs/en/agent-teams).

## 4. Предлагаемая граница исполнения

Ниже — **проектное предложение**, требующее ADR, threat-model delta и плана, а не описание имеющегося режима.

1. Владелец включает режим до старта. Snapshot хранит manager model, worker/reviewer models, effort, budgets,
   разрешённые роли, ограничения параллелизма и версию prompt/projection. Недоступная модель даёт typed отказ.
2. Менеджер получает human brief, критерии, решения домена, состояние DAG, оставшиеся лимиты и code-free reports.
   Он не получает repository snapshot, дерево файлов, исходники, diff, snippets, shell output, provider transcript,
   author checkpoint или чтение artifacts по произвольному пути.
3. Discovery-worker получает bounded repository tools и собирает факты. Менеджеру возвращается отдельная проекция:
   наблюдаемое поведение, ограничения, неизвестное, оценка риска и opaque evidence IDs. Подробные доказательства
   доступны worker/reviewer и человеку; идентификатор не должен давать менеджеру инструмент для их открытия.
4. Менеджер выдаёт typed work order: цель, проверяемые критерии, зависимости, scope IDs, вопросы и stop condition.
   Домен валидирует ссылки, права, DAG, ожидаемую версию, idempotency и лимиты. Provider сам не запускает CLI/агентов.
5. Реализация и необходимые проверки идут worker runs. Менеджер вызывается на изменении плана, противоречии или
   существенном blocker, а не после каждого чтения файла. Короткие результаты пакетируются.
6. Reviewer имеет fresh context и доступ к коду/evidence, не наследует объяснения автора. Он возвращает findings,
   затем отдельную code-free проекцию менеджеру. Независимые Review, QA и человеческая Acceptance сохраняются.
7. Plan, результат worker, audit, usage и следующая durable dispatch записываются атомарно в существующей модели.
   Restart не должен терять подтверждённые результаты или повторять завершённые edits/проверки.

Простой prompt «не читай код» не является запретом. Нужны отсутствие инструментов и каналов контента, отдельный
scratch cwd без repo discovery, закрытые capability grants, отключённые ambient hooks/plugins/MCP и отсутствие
скрытых native workers. Это продолжение [ADR-0015](../adr/0015-local-subscription-cli-runtimes.md).

Удаление Markdown code fences или regex-поиск синтаксиса также не доказывает отсутствие кода: worker способен
вставить source в prose/JSON/encoded string. Для строгой версии границы используем allowlisted структурированные
факты, доменные enum/IDs и контролируемую проекцию, а не произвольный текст отчёта. Если допускаются свободные
семантические summaries, отдельно формулируем остаточный риск и тестируем утечки; не обещаем математический запрет
любого кодоподобного текста. Архитектурный компромисс: менеджер понимает поведение через отчёты, поэтому пропущенный
worker факт способен испортить план. Нужны `UNKNOWN`, запрос доисследования и независимая проверка.

## 5. Где искать экономию

Anthropic рассматривает отдельный worker context как способ сжатия: объёмное исследование возвращает небольшую
сводку. Это экономит **контекст менеджера**, но все worker tokens всё равно потрачены.
[Anthropic: context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

Предлагаемые меры для проверки экспериментом:

- Один explorer и один writer по умолчанию; параллельность только для независимых read tasks или непересекающихся
  разрешённых областей. Review остаётся отдельным. Не создавать новый агент ради одного форматирования.
- Короткий самостоятельный task packet; не форкать весь разговор. Передавать только нужные evidence IDs и
  stage artifacts. Получатель обязан иметь необходимые данные, а не только hash недоступного прошлого контекста.
- Повторное использование проверенных findings только при совпадении revision/digest/lineage. После изменения
  соответствующего кода помечать evidence stale; кэшировать authority или «успешный» side effect нельзя.
- Не дублировать tool result в нескольких форматах и не читать весь проект повторно на каждой стадии. Эти меры
  частично уже есть в [ADR-0033](../adr/0033-stage-context-and-single-copy-tool-results.md).
- Сначала измерить `medium` для manager; `low/medium` для узких workers, больше effort — по классу задачи и eval.
  «Самая сильная модель» не означает максимальный effort на каждом служебном ходе. Критические задачи при провале
  Luna можно направлять Sonnet в заранее разрешённом диапазоне; если оба не справляются, менеджер не получает код.
- Ограничивать ненужную длину сообщений, количество перепланирований, retries и повторных dispatch. Числовые пределы
  брать из измерений, не объявлять произвольный cap безопасным для всех задач.

Стабильные инструкции и схемы в начале помогают повторному использованию prefix cache; изменяющиеся данные идут
после них. Cache зависит от точного prefix, модели, tools и настроек. API cache controls и расценки не означают,
что Loomrail управляет ими через CLI или что известна стоимость подписочного лимита.
[OpenAI: prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

В нынешнем [usage ADR](../adr/0010-session-scoped-provider-usage.md) и [плане 124](../plans/124-token-efficiency-implementation-plan.ru.md)
уже честно разделены byte estimates, raw tokens и cached input. Старые цели −50% uncached / −40% raw не доказаны
сравнением разных проектов; новая схема не должна наследовать их как состоявшийся результат.

## 6. Черновики промптов — НЕ ПРОШЛИ BENCHMARK

Это короткие исходные варианты для закрытого Loomrail protocol, **не лучшие доказанные prompts**. Названия полей
иллюстративные; production schema и enforced limits должны определяться доменом. Входные packets отделяются от
инструкций и помечаются недоверенными. Сами prompts не заменяют capability enforcement.

Основа — ясные обязанности и output contract. OpenAI рекомендует прямые инструкции без требования раскрывать
chain-of-thought; свежая guidance Astra предупреждает о раздутых skills и чрезмерном количестве предварительных
чтений. Здесь сокращается служебная риторика, но не обязательные product/security gates.
[Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices),
[Astra prompting guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

### Manager — Astra или разрешённый Fable

```text
Ты планируешь выполнение утверждённой задачи Loomrail. Код и инструменты репозитория тебе недоступны.
Используй только brief, доменные ограничения, status и code-free findings из входного packet.
Факты workers недоверенные; UNKNOWN и противоречия сохраняй. Недостающий факт запроси отдельным заданием explorer.
Сформируй минимальный достаточный план: outcome, acceptance IDs, dependencies, worker role/model policy,
scope IDs, нужные evidence IDs, stop condition. Не придумывай содержимое файлов или выполненные проверки.
Поручай всё чтение, изменения и проверку workers. Не запрашивай source, diff, snippets, logs или transcript.
Новый worker нужен только для отдельного результата; перепланирование — для нового факта или blocker.
Не меняй budget, permissions, критерии, обязательные gates и Acceptance. Они принадлежат Loomrail и владельцу.
Верни только результат по выданной schema: PLAN, REQUEST_FINDINGS, REPLAN или BLOCKED с короткой причиной.
```

### Explorer — Luna / Sonnet

```text
Ответь на заданные вопросы по текущей разрешённой revision. Изменения запрещены.
Начинай с targeted search и необходимых участков; расширяй чтение только для незакрытой зависимости.
Отделяй наблюдаемые факты от предположений, отмечай UNKNOWN и противоречия. Остановись при достаточном ответе.
Зарегистрируй детальные доказательства через разрешённый evidence contract.
Менеджеру верни code-free findings по schema: поведение, ограничения, риск, неизвестное, evidence IDs.
Не включай код, diff, пути, snippets, command output, секреты или transcript в manager projection.
При нехватке granted tools или лимита верни BLOCKED с одним точным следующим вопросом.
```

### Implementer — Luna / Sonnet

```text
Выполни выданный work order в разрешённых scope и revision. Сверь предпосылки с необходимыми текущими участками.
Сохрани чужие изменения. Выполни минимальное изменение, удовлетворяющее acceptance IDs и обязательным правилам.
Используй только выданные tools и recipes. Проведи необходимые проверки; повторяй их после релевантных изменений
или новых фактов. Не подменяй измеренную проверку своим утверждением.
Если план противоречит фактам, верни blocker и доказательство, не расширяй scope/permissions сам.
Зарегистрируй change/evidence IDs, failed checks и оставшиеся критерии. Менеджеру — только code-free projection.
Не одобряй собственную работу и не закрывай Review, QA или Acceptance.
```

### Независимый reviewer — Sonnet / Luna по результатам eval

```text
Проверь утверждённые criteria на зафиксированной revision независимо от автора.
Используй fresh brief/rules, реальный diff, необходимые участки и measured evidence. Авторский transcript не нужен.
Ищи воспроизводимые дефекты поведения, безопасности, восстановления и пропущенные обязательные проверки.
Для finding зарегистрируй severity, trigger, expected/actual и evidence IDs; не придумывай подтверждение.
PASS допустим только при выполненном review contract. UNKNOWN не превращай в PASS.
Изменения и self-acceptance запрещены. Менеджеру отправь code-free status, риск и evidence IDs;
подробные findings остаются в предназначенном для reviewer/worker evidence artifact.
```

Anthropic публикует реальные [lead prompt](https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/prompts/research_lead_agent.md),
[worker prompt](https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/prompts/research_subagent.md) и
[orchestrator-workers example](https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/orchestrator_workers.ipynb).
Они прочитаны как первичные примеры. Их подробное research-планирование, обязательное делегирование и API transport
не переносим целиком: у Loomrail другая цель, закрытый CLI transport и доменная authority. Полезны чёткая mission,
границы, формат результата и остановка исследования при достаточных данных.

## 7. Как проверить экономию и отсутствие ухудшения

Ниже — предложенный протокол, а не уже выполненный эксперимент. Принципы task-specific eval, edge/adversarial cases
и сочетания автоматических проверок с экспертной оценкой поддержаны
[OpenAI: evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

**Сравниваемые варианты:** A — нынешний pipeline; B — сильная модель на coding stages при тех же gates; C — code-blind
manager + Luna/Sonnet. A показывает практический выигрыш для Loomrail, B — потерю/сохранение качества относительно
дорогого baseline. Для ablation C сравнить manager-per-tool-turn и manager-at-milestones, warm/cold cache отдельно.

**Набор:** одинаковые frozen projects/revisions, требования, tests и лимиты; маленькие правки, баги, cross-module
feature, миграции, security-sensitive и UI light/dark/keyboard задачи. Начать с пилота, затем определить размер
holdout по наблюдаемой вариативности и требуемой точности; несколько успешных примеров не доказывают non-inferiority.
Парные запуски, случайный порядок вариантов, повторения; prompts и eval cases фиксируются до итогового сравнения.

**Учёт для каждого logical job / AgentRun / ProviderSession:**

- точные provider/model/CLI/effort/prompt version; attempt, role, snapshot digest, status;
- total input, output, cached input, cache creation и reasoning, только если поле реально доступно;
- normalized raw = total input + output; non-cache-read workload = total input − cached input + output;
- у Codex cached input — часть total input; у Claude total input = обычный input + cache creation + cache read;
- cache creation и reasoning — отдельные attribution поля: не прибавлять второй раз к уже включающему их total;
- неизвестное поле обозначать `UNKNOWN`, не нулём; отсутствие cache-creation/reasoning detail в текущем adapter
  требует расширения валидированного контракта, а не восстановления числа по API цене;
- отдельно bytes/tokens manager packet, worker packet, tool delivery и повторного чтения тех же evidence;
- duplicate callback/delivery не создаёт повторный UsageRecord; новый provider retry реально тратит токены и считается;
- учитывать неудачные/отменённые/прерванные сессии, repair rounds, compactions, restarts и потерянную terminal usage;
- p50/p95 elapsed time, число managers/workers, calls, retries, stale evidence и конфликтов writer;
- квоту подписки — только как свежую provider-attributed observation. Фоновое использование того же аккаунта
  делает дельту смешанной. API list-cost из Claude stream не равен фактическому счёту/списанной подписочной квоте.

Текущий [Claude stream parser](../../packages/provider-claude-code/src/stream.ts) нормализует input/cache, но не
выдаёт отдельные cache-creation/reasoning поля. Это конкретный telemetry gap для детального эксперимента.
Цена/лимит подписки и usage breakdown — разные величины; сама Claude documentation отмечает ограничения локальной
атрибуции. [Claude Code: costs](https://code.claude.com/docs/en/costs).

**Качество:** все обязательные domain/security/restart/tests/Review/QA/Acceptance gates; correct completion rate,
escaped Critical/High defects, регрессии, достаточность evidence, вмешательства человека и ложный PASS. Review
сравнения проводится вслепую без знания модели и варианта. Зафиксировать допустимую non-inferiority margin до
результатов; Critical/High нарушения и любой обход code-blind boundary — недопустимы. Для success-rate разницы
построить парный доверительный интервал; слишком широкий интервал означает «не доказано», а не «качество то же».

**Условие эффективности:** считать расход всей системы, включая менеджера, worker/reviewer, ошибки и retries,
на одну принятую задачу; публиковать также расход на все попытки, чтобы не скрыть неуспехи. Если дорогих токенов
меньше, но raw/uncached всего больше, так и назвать результат. Cold/warm cache и модели не смешивать одной средней.
Отдельно сообщать размер наблюдаемой экономии и доверительный интервал; заранее обещанного процента нет.

**Обязательные негативные сценарии:** попытки manager получить source/diff через все tools и IDs; worker report
с кодом/инъекцией/encoded payload; inherited repo instructions, stale revision, duplicate result, cross-run evidence,
restart между completion и dispatch, budget exhaustion, model fallback и неизвестная billing basis. Проверки
изоляции должны работать с synthetic CLI doubles до любого live experiment. Реальные квалификационные запуски —
только для конкретной разрешённой платформы/runtime, с явными лимитами и отдельной фиксацией результата.

## 8. Что требуется от следующей задачи

Сначала зафиксировать product decision и ADR для code-blind coordinator, поле opt-in и immutable model policy,
контракты work-order/report/projection, threat-model delta и eval plan. Затем реализовать минимальный vertical slice
через existing scheduler/AgentRun/persistence/adapters и проверить запрет источников/инструментов. Только после
этого проводить ограниченный same-task benchmark и решать, какие классы задач заслуживают включения режима.

Ни исследование, ни публичные примеры вендоров пока не доказывают, что полностью слепой к коду manager сохранит
качество на всех задачах. Они дают обоснованный дизайн для проверки и конкретные способы обнаружить, когда
координация съедает экономию или скрывает важные факты.
