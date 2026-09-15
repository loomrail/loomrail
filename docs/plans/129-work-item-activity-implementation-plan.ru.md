# Лента активности по задаче: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`.
> Шаги отмечаются чекбоксами `- [ ]`.

**Goal:** действие, выполненное агентом на ранней стадии, остаётся видимым владельцу после того, как конвейер ушёл
дальше.

**Architecture:** единицей ленты становится WorkItem вместо AgentRun текущей попытки стадии. Обе таблицы уже несут
`work_item_id` собственной колонкой, поэтому меняются только запросы, сборка страницы, маршрут и привязка секции —
ни одной миграции.

**Tech Stack:** TypeScript strict, zod 4, vitest, `node:sqlite` через `@loomrail/persistence-sqlite`, Fastify,
React + TanStack Router, Playwright.

**Spec:** [`docs/plans/128-work-item-activity-spec.ru.md`](128-work-item-activity-spec.ru.md)

**Предшественник:** [ADR-0034](../adr/0034-diagnostic-provider-activity.md) и
[`docs/plans/126`](126-agent-run-activity-spec.ru.md) — читать их до начала. Всё, что они зафиксировали про
отсутствие authority, редактирование, раздельное хранение и безопасность рекордера, остаётся в силе.

## Global Constraints

- TypeScript strict; `any` запрещён в production-коде и публичных тестах; только named exports; `type` для форм
  данных; switch по union исчерпывающий.
- Prettier владеет форматированием, markdown включительно. Перед сдачей — `pnpm verify`.
- Lint обязателен и роняет сборку. Правила, о которые спотыкались раньше: `@typescript-eslint/no-deprecated`
  (`z.iso.datetime()`, не `z.string().datetime()`), `no-misused-spread` (никогда не раскрывать строку через
  `[...s]`, только `Array.from`), `restrict-template-expressions` (число в шаблонной строке требует `.toString()`),
  `no-unnecessary-condition`. Прогонять eslint по изменённым файлам и вкладывать вывод в отчёт.
- `node:sqlite` импортирует только `packages/persistence-sqlite`; импорт из `apps/*` в `packages/*` запрещён.
- Provider output — недоверенный вход: `safeParse`, границы длины, redaction. Ни одно из этих свойств не
  ослабляется этим планом.
- `@testing-library/react` не является зависимостью `apps/web` и не добавляется: чистый view-компонент
  экспортируется отдельно и рендерится через `renderToStaticMarkup`.
- Пакеты потребляются из `dist/`: после изменения `packages/*/src` выполнять `corepack pnpm build` перед прогоном
  тестов зависимого пакета.
- Коммиты только по явной просьбе владельца (AGENTS.md); владелец её дал для этой ветки.
- Доказательство мутацией — **одна мутация на одну защиту**. Мутация, снимающая несколько условий разом, доказывает
  их совокупность, а не каждое; на прошлой ветке это дважды пропустило непроверенную защиту.

## Тулчейн

Голый `pnpm` здесь неверной версии. Префикс в той же командной строке:

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"; corepack pnpm --filter @loomrail/daemon test
```

Известная базовая линия на этой машине: два теста в `apps/daemon/test/provider-selection.integration.test.ts`
падают из-за того, что `codex` и `claude` стоят под разными версиями Node. На CI они зелёные. Не чинить.

---

### Task 1: Контракт и чтения по задаче

**Files:**

- Modify: `packages/contracts/src/activity.ts`
- Modify: `packages/persistence-sqlite/src/index.ts`, `src/types.ts`
- Test: `packages/persistence-sqlite/test/agent-run-activity.integration.test.ts`

**Produces:** поля `agentRunId` и `stage` в `agentRunActivityEntrySchema`; запросы
`LIST_WORK_ITEM_ACTIVITY` и `LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM`.

- [ ] **Шаг 1: Расширить запись контракта**

Добавить рядом с существующими полями, сохранив их комментарии без изменений:

```ts
    // Which run produced this entry. The feed spans a WorkItem's runs, so the reader groups by
    // this and names the group with `stage`; without it a reader cannot tell one run's actions
    // from the next run's, and the two can be minutes apart or days.
    agentRunId: z.string().min(1),
    stage: workflowStageSchema,
```

- [ ] **Шаг 2: Написать падающие тесты чтений**

Тесты по идиоме файла (`mkdtemp` + `openLocalState` + `beforeEach`/`afterEach`, фикстуры через настоящую
командную поверхность). Покрыть: записи двух разных прогонов одной задачи приходят одним чтением в порядке
`(observed_at, id)`; записи чужой задачи не приходят; `limit` соблюдается.

- [ ] **Шаг 3: Реализовать чтения**

Обе таблицы фильтруются по `work_item_id` напрямую — ни одного join. Prepared statements, короткие транзакции.
`LIST_WORK_ITEM_ACTIVITY` возвращает записи вместе с их `agent_run_id`, а также по прогонам суммированный
`omittedCount` и признак `degraded` (истинен, если деградировал хотя бы один прогон задачи) из
`agent_run_activity_state`.

- [ ] **Шаг 4: Прогнать и зафиксировать**

---

### Task 2: Лента задачи и маршрут

**Files:**

- Modify: `apps/daemon/src/agent-run-activity.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/test/agent-run-activity.unit.test.ts`

- [ ] **Шаг 1: Написать падающие тесты**

Покрыть отдельно, по одной защите на тест: детерминированный порядок через границу прогона; страница на стыке
прогонов не теряет и не дублирует записи; `omittedCount` суммируется; `degraded` истинен при деградации одного
прогона из нескольких; `stage` и `agentRunId` соответствуют источнику записи.

- [ ] **Шаг 2: Перевести сборку страницы на задачу**

`mergeRunActivity` не меняется — порядок `(at, origin, id)` сквозной через прогоны, поэтому граница прогона не
является особым случаем. Меняется вход: оба источника читаются по задаче, и каждая запись получает `agentRunId` и
`stage` своего прогона. `origin` по-прежнему проставляется читателем по таблице-источнику.

- [ ] **Шаг 3: Заменить маршрут**

`GET /api/v1/work-items/:workItemId/activity` вместо `GET /api/v1/agent-runs/:runId/activity`. Обвес копируется
без изменений: `requireSession`, `requestCorrelationId`, `cache-control: no-store`, `x-content-type-options:
nosniff`, 404 на несуществующую задачу, 400 `INVALID_ACTIVITY_CURSOR` на нечитаемый курсор. Прежний маршрут
удалить целиком.

- [ ] **Шаг 4: Прогнать и зафиксировать**

---

### Task 3: Секция, привязанная к задаче

**Files:**

- Modify: `apps/web/src/api.ts`, `src/workspace.tsx`
- Modify: `apps/web/src/components/RunActivitySection.tsx`, `RunActivitySection.test.tsx`
- Modify: `apps/web/src/views/WorkbenchPage.tsx`
- Modify: `apps/web/src/i18n.tsx` (обе локали)

- [ ] **Шаг 1: Написать падающие тесты**

Покрыть: записи сгруппированы по прогону и каждая группа названа стадией; свёрнутая сводка показывает последнее
действие по задаче; недоверенный текст по-прежнему экранируется во всех четырёх приёмниках; происхождение читается
текстом. Каждое свойство — своим тестом, чтобы мутация одного не проходила мимо остальных.

- [ ] **Шаг 2: Перевести секцию на задачу**

Ключ запроса становится `["work-items", workItemId, "activity"]` — он и так под скоупом, который инвалидирует
сигнал канала, так что живое обновление сохраняется без изменений. Секция больше не пересоздаётся при смене
стадии, и раскрытие владельца переживает переход. Свёрнутая сводка берёт последнее действие по задаче.

Группировка по прогону: соседние записи с одним `agentRunId` образуют группу, заголовок — стадия и порядковый
номер прогона. Заголовок не является интерактивным элементом; фокус и клавиатура остаются на одном `<summary>`
секции.

- [ ] **Шаг 3: Прогнать, проверить темы и клавиатуру, зафиксировать**

---

### Task 4: Переезд тестов и новое покрытие

**Files:**

- Modify: `apps/daemon/test/agent-run-activity-http.integration.test.ts`
- Modify: `apps/daemon/test/agent-run-activity-leak.integration.test.ts`
- Modify: `e2e/run-activity.spec.ts`

- [ ] **Шаг 1: Перевести существующие проверки на новый маршрут**

Ни одна проверка не ослабляется и не удаляется: меняется только адрес. Канарейки утечек продолжают утверждать
отсутствие канареечной строки в ответе, в SQLite, в логах, в acceptance package, в evidence package, в insights и
в crash payload.

- [ ] **Шаг 2: Добавить E2E на исчезновение**

Это главный тест этого плана: прогон делает аудированную запись на IMPLEMENT, конвейер уходит на следующую стадию,
и действие **по-прежнему видно** в Run Activity. До этой ветки оно исчезало.

Доказать, что тест кусает: временно вернуть привязку к попытке стадии, убедиться, что тест падает, восстановить,
убедиться, что проходит. Вложить обе стороны в отчёт.

- [ ] **Шаг 3: Прогнать полный E2E и зафиксировать**

---

### Task 5: Документы

**Files:**

- Modify: `docs/adr/0034-diagnostic-provider-activity.md`
- Modify: `docs/plans/126-agent-run-activity-spec.ru.md`
- Modify: `docs/plans/128-work-item-activity-spec.ru.md`

- [ ] **Шаг 1: Снять зафиксированное ограничение**

ADR-0034 описывает границу «Run Activity показывает прогон текущей попытки стадии, и действие перестаёт быть
видимым, когда конвейер уходит дальше». Ограничение снято — сказать это, назвав, чем именно, и не переписывая
остального решения ADR. То же в разделе spec 126, где та же граница описана.

Каждое утверждение проверять против кода, а не против текста спецификации: на прошлой ветке ревью четырежды ловило
ложные утверждения в комментариях и документах, одно из них в файле безопасности.

- [ ] **Шаг 2: Статус spec 128 и `pnpm verify`**
