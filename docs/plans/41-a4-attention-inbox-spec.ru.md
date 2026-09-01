# A4 — Global Attention Inbox

**Дата:** 2026-09-01
**Статус:** implemented and locally verified
**Основание:** HD-001, MASTER-PLAN §10.1–10.2 и §15.6, решение владельца после публикации `0.1.0-alpha.3`

## 1. Проблема

Loomrail уже хранит HumanRequest и Decision, атомарно выполняет `Answer & resume` и показывает blocking request в
выбранном Project и Task Cockpit. Но это не Attention Inbox: владелец должен сначала выбрать правильный Project,
затем найти заблокированную Task и только после этого понимает, что от него требуется. При нескольких проектах
sidebar badge также считает только текущий Project.

A4 должен отвечать на три вопроса без обхода досок:

1. что требует человека прямо сейчас;
2. какую Task и stage это блокирует;
3. какое действие безопасно продолжит workflow.

## 2. Граница среза

### Входит

- глобальная authenticated проекция открытых HumanRequest всех Project;
- closed grouping vocabulary: `BLOCKING_NOW`, `APPROVALS`, `QUESTIONS`, `MANUAL_ACTIONS`, `SOON`;
- bounded response до 200 items с явным `hasMore`;
- Project, WorkItem, current stage, priority, request category и affected stage в каждом item;
- отдельный маршрут `/attention`, глобальный sidebar badge и keyboard-first выбор item;
- inline `Answer & resume` для обычного HumanRequest;
- отдельный переход в Task Cockpit для final AcceptancePackage: generic answer не обходит acceptance authority;
- обновление через существующий event stream и query invalidation;
- RU/EN, light/dark, narrow viewport, visible focus и browser E2E.

### Не входит

- новая durable сущность Inbox или копия HumanRequest;
- OS/browser notifications и permission prompt;
- `CLAIMED`, `SNOOZED`, expiry и clarification rounds: в текущем продукте нет non-blocking producer, поэтому у этих
  состояний пока нет честного end-to-end маршрута;
- owner readiness attestations: они остаются отдельной project-level проекцией до собственного A4 follow-up;
- mobile/PWA, remote access, team assignment или messaging;
- изменение acceptance, budget, provider либо workflow authority.

## 3. Доменный контракт

Attention Inbox — вычисляемая проекция, а не источник истины. Deep module `buildAttentionInbox` получает bounded
набор связанных HumanRequest, Project, WorkItem, StageAttempt и optional AcceptancePackage identity. Он проверяет
referential invariants, классифицирует и сортирует items. Persistence adapter отвечает только за consistent local
read; daemon и UI не повторяют правила проекции.

Удаление module должно вернуть классификацию, bounds и ordering в persistence, daemon и web. Если после удаления
ничего не приходится переносить, module недостаточно глубокий.

### 3.1. Item

Каждый `AttentionItem` содержит:

- исходный HumanRequest целиком;
- `project: { id, name }`;
- `workItem: { id, title, priority, state }`;
- `stage: { id, name, status }`;
- category `APPROVAL | QUESTION | MANUAL_ACTION`;
- action `ANSWER_REQUEST | REVIEW_ACCEPTANCE`;
- section из closed vocabulary;
- `affectedStages` — в A4 ровно текущая stage.

### 3.2. Классификация

1. AcceptancePackage задаёт category `APPROVAL` и action `REVIEW_ACCEPTANCE`.
2. Session-loop HARD pause с известным failure code задаёт category `MANUAL_ACTION`.
3. Остальные запросы задают category `QUESTION` и action `ANSWER_REQUEST`.
4. Любой blocking request попадает в `BLOCKING_NOW` независимо от category.
5. Non-blocking approval, manual action и question попадают соответственно в `APPROVALS`, `MANUAL_ACTIONS` и
   `QUESTIONS`. `SOON` зарезервирован для будущего expiry contract и не выводится из текста или title.

Внутри section items сортируются по WorkItem priority (`URGENT → HIGH → MEDIUM → LOW`), затем от старого к новому и
по стабильному id. Title/context никогда не используются как неявный machine-readable discriminator.

## 4. Read и mutation paths

`GET /api/v1/attention` возвращает `{ schemaVersion, items, hasMore }`. Endpoint требует ту же loopback session, что
и остальные reads. Он не принимает project/path/status filters и не раскрывает raw provider output.

Обычный ответ использует существующий
`POST /api/v1/human-requests/:humanRequestId/answer` с `expectedVersion`. State, Decision, Event и resume
WorkflowDispatch остаются одной transaction; два browser tabs не применяют ответ дважды.

Final acceptance никогда не отправляется в generic answer endpoint. Inbox открывает exact Project/WorkItem в Task
Cockpit, где остаются versioned `Accept`, `Return to work` и `Reject`.

## 5. UI

- Sidebar `Attention` находится рядом с Current work и показывает глобальное число открытых items.
- Страница использует master/detail layout без dashboard cards: слева сгруппированный список, справа одно решение.
- Item показывает Project, Task, stage, priority и human-readable category без зависимости только от цвета.
- `ArrowDown`/`ArrowUp` меняют выбранный item; Tab проходит по обычным native controls; Enter активирует выбранный
  option/button.
- После успешного ответа item исчезает из projection, следующий item выбирается детерминированно, а workflow
  продолжает существующий worker.
- Empty, loading, offline, stale-version и bounded-overflow states объясняют, что произошло и что делать.

## 6. Security и privacy

- response ограничен 200 items; `hasMore` сообщает о неполной проекции;
- HTTP input и output валидируются closed schemas;
- endpoint session-authenticated, loopback-only и read-only; mutation сохраняет Origin/CSRF checks;
- Project name и Task title считаются untrusted text и выводятся только React text nodes;
- HumanRequest остаётся запрещённым secret channel;
- global read не добавляет telemetry, export или remote delivery.

## 7. Acceptance

1. Requests двух Project одновременно видны на `/attention`, а badge не зависит от selected Project.
2. Blocking items идут первыми и имеют стабильный priority/age ordering.
3. Обычный answer создаёт одну Decision, закрывает request и создаёт ровно один resume dispatch даже при replay.
4. Acceptance item не может вызвать generic answer и открывает exact Task Cockpit.
5. Missing relation, non-open input и response overflow fail closed либо отмечаются `hasMore`; текст request не влияет
   на category/action.
6. Restart сохраняет тот же Inbox, потому что projection строится из SQLite state.
7. RU/EN, light/dark, keyboard, 320 px и desktop browser scenarios зелёные.
