# Q20.5 — Domain-owned WorkItem dependency DAG: спецификация

**Статус:** implemented; accepted private Recurkit Epic complete on macOS

**Основание:** PD-022, WD-001, WD-006, ADR-0019, Threat Model T65

## Outcome

Владелец создаёт Epic с 2–3 дочерними leaf WorkItem, задаёт между ними durable порядок `BLOCKS` и видит его после
restart. Workflow зависимой работы не стартует, пока каждый blocker не принят человеком и не находится в `DONE`.

## Архитектурная граница

Один глубокий domain operation принимает target WorkItem, expected version, новый полный набор входящих blocker ID и
bounded snapshot текущего Project DAG. Он либо возвращает canonical edge diff, новую версию WorkItem и audit intent,
либо typed error. HTTP, SQLite и React не реализуют собственные варианты cycle/readiness rules.

Hierarchy через `parentId` отвечает за состав Epic. Dependency отвечает только за порядок исполнения. Provider может
предложить декомпозицию в artifact, но не создаёт authoritative edges и не объявляет WorkItem готовым.

## Контракт

- единственный исполняемый relation kind v1 — `BLOCKS`;
- оба WorkItem принадлежат одному Project;
- self-edge, duplicate blocker, missing/foreign item и любой direct/transitive cycle запрещены;
- максимум 50 входящих blocker для одного WorkItem, 10 000 WorkItem и 50 000 edges на одну проверку mutation;
- mutation разрешена только без active PipelineRun и не для `DONE | CANCELLED` target;
- входной порядок не является семантикой: result и response имеют canonical deterministic order;
- edge diff, target version, Event и command receipt записываются одной `BEGIN IMMEDIATE` transaction;
- повтор того же command ID возвращает тот же result; другой input под тем же ID запрещён;
- `START_PIPELINE` внутри своей transaction читает актуальные incoming blockers; только `DONE` удовлетворяет edge;
- отменённый blocker не превращается в success и показывается как требующий решения владельца;
- read API возвращает только bounded relation metadata, без путей, provider payload, токенов или repository text.

## Интерфейс

- создание WorkItem позволяет выбрать тип и optional parent из того же Project;
- inspector показывает parent, children и incoming/outgoing dependencies;
- owner может заменить incoming blockers через keyboard-accessible control до старта;
- при незакрытых blockers start disabled с перечислением title/state; stale click возвращает понятный typed conflict;
- события создания/изменения графа появляются в Activity без raw request payload.

## Recovery и совместимость

- additive SQLite migration создаёт relation table и расширяет закрытый Event vocabulary;
- reopening базы восстанавливает exact graph; незавершённой side effect у edge mutation нет;
- existing WorkItem имеют пустой dependency set;
- macOS и Windows используют те же ID/state semantics; fixtures включают пробелы и Unicode, хотя dependency contract
  не переносит filesystem paths;
- удаление Project/WorkItem автоматически не добавляется; действующие `RESTRICT` boundaries сохраняются.

## Non-goals

- автоматический запуск следующего WorkItem;
- параллельный merge/integration workflow Epic;
- cross-Project dependencies;
- `relates to`, arbitrary relation labels или graph marketplace;
- provider-authorized graph mutation;
- изменение final human Acceptance.

## Acceptance

1. Разрешённый same-Project acyclic graph сохраняется и одинаково читается после restart.
2. Self, duplicate, foreign/missing, cyclic, oversized и active/terminal-target mutations возвращают typed errors без
   частичной записи.
3. Start зависимой READY leaf до `DONE` всех blockers отклоняется; после owner Acceptance blockers старт разрешён.
4. Command replay, version conflict и concurrent cycle attempts доказаны integration tests.
5. UI создаёт Epic/children, редактирует dependencies и различает ready, dependency-blocked и API failure без цвета.
6. API/security tests покрывают session, Origin/CSRF, чужой Project и hostile bounded text.
7. Private Recurkit Epic из 2–3 зависимых WorkItem проходит реальный local-CLI workflow и owner Acceptance.
8. Focused tests, product E2E и полный `pnpm verify` проходят; Windows live provider evidence остаётся отдельным gate.
