# I1 — Tracker round-trip: YouTrack import и acceptance write-back

**Дата:** 2026-09-05

**Статус:** proposed; ждёт owner review, затем implementation plan 82

**Основание:** PD-005, PD-006, раздел 14 «Отложенные решения» в
[PRODUCT-DECISIONS.ru.md](../product/PRODUCT-DECISIONS.ru.md), ADR-0002, ADR-0009, Q3, T46

**Предшественники:** Q3 (criterion-bound Acceptance/export), Q12 (reporting seam), Q17 (owner adoption pattern)

## 1. Outcome

Владелец берёт существующую задачу из YouTrack, она становится WorkItem в Loomrail и проходит все стадии, гейты,
independent Review, verification, Browser QA и финальный человеческий acceptance как любая другая. После `ACCEPT`
владелец одним явным действием отправляет в ту же YouTrack issue комментарий с детерминированным ReleaseSummary и,
опционально, переводит её состояние. Команда, живущая в трекере, видит доказательство результата там, где ведёт
работу, а Loomrail остаётся единственным источником правды о lifecycle.

Это round-trip, а не синхронизация. Трекер является точкой входа и точкой выхода. Он не меняет состояние WorkItem,
не открывает и не закрывает гейты, не создаёт acceptance и не получает ничего до финального owner gate.

I1 не добавляет Sprint, velocity или другие сущности трекера. Спринт остаётся у команды в YouTrack; Loomrail честно
отчитывается по каждой задаче.

## 2. Vocabulary и authority

- `TrackerConnection` — owner-owned настройка одного Project для одной внешней системы: `system = YOUTRACK`, exact
  HTTPS origin, YouTrack project short name, опциональное `doneStateName`. Токен не является полем connection.
- `TrackerSecret` — permanent token YouTrack, хранящийся вне SQLite, Event, config и provider context.
- `TrackerIssueSnapshot` — bounded read-only копия issue на момент import: readable id, summary, description,
  remote `updated`, content hash. Untrusted input.
- `TrackerLink` — durable связь WorkItem с exact issue: `connectionId`, `issueKey`, `issueUrl`, snapshot hash. Один
  link на WorkItem, одна issue на не более одного open WorkItem в Project.
- `TrackerWriteback` — daemon-owned попытка доставить один exact preview в трекер после acceptance.
- `TrackerWritebackPayload` — детерминированный текст комментария, построенный только из Q3 ReleaseSummary и
  фиксированного заголовка.

Authority:

- только authenticated owner создаёт/меняет connection, инициирует import, подтверждает write-back и retry;
- daemon читает issue, строит preview, отправляет подтверждённый payload и записывает typed outcome;
- provider не видит connection, secret, issueUrl или сам факт связи с трекером иначе как через уже принятый текст
  WorkItem; provider не может запросить import, write-back или изменение состояния issue;
- трекер не может изменить WorkItem: изменения issue после import не применяются автоматически, а становятся видимым
  `REMOTE_CHANGED` hint по явному owner refresh.

## 3. Подтверждённые test seams

1. contract/domain seam — strict schemas для connection, snapshot, link, writeback и pure decisions: допустим ли
   import, допустим ли write-back, какой payload и hash получаются из exact AcceptancePackage;
2. secret seam — `TrackerSecretStore` с `put | get | delete` для одной connection, без чтения из SQLite;
3. tracker client seam — closed интерфейс `readIssue | probeAuth | createComment | applyStateCommand` над bounded
   HTTPS, mock и recorded fixtures YouTrack;
4. persistence seam — versioned commands, idempotency, одна transaction на state + Event + follow-up, restart
   reconciliation;
5. authenticated HTTP seam — connection, probe, import preview/commit, writeback preview/commit/retry, read;
6. Task Cockpit/Kanban seam — link provenance, remote hint, writeback states, preview before send.

Тесты проверяют интерфейсы, а не private helpers или конкретные SQL rows.

## 4. TrackerConnection и secret

Connection v1:

- `system` — только `YOUTRACK`;
- `baseUrl` — exact `https://` origin без path/query/fragment/userinfo; `http://` допускается только для literal
  loopback в тестах и помечается `INSECURE_TEST_ONLY`;
- `projectShortName` — 1..32 символов `[A-Z0-9_]`;
- `doneStateName` — nullable, 1..64 символов, bounded text; используется только в write-back state command;
- `externalPublicationAcknowledged` — owner один раз подтверждает, что комментарий уйдёт во внешнюю систему,
  которую Loomrail не контролирует.

Connection versioned как Plan в Q17: optimistic version, append-only history, disable вместо удаления истории. Смена
`baseUrl` или `projectShortName` создаёт новую revision и делает существующие links `CONNECTION_CHANGED`; они не
удаляются и не переезжают молча.

Secret:

- вводится только через отдельный `PUT .../tracker-connection/secret`, никогда не возвращается API, не логируется,
  не попадает в Event, snapshot, export, provider context, diagnostics или reporting;
- хранится через `TrackerSecretStore`. V1 требует OS credential store (macOS Keychain, Windows Credential Manager);
  реализация выбирается в implementation plan, spec фиксирует seam и fail-closed поведение;
- недоступный store или отсутствующий secret даёт connection status `SECRET_MISSING`; import и write-back
  недопустимы, UI объясняет причину словами;
- `probeAuth` — единственный read-only способ проверить токен: один bounded GET текущего пользователя; ответ
  сохраняется как closed status `OK | UNAUTHORIZED | UNREACHABLE | INVALID_RESPONSE`, без тела.

## 5. Tracker client и network policy

Это первый исходящий network client самого daemon вне provider CLI и BrowserDriver. Он ограничен так же жёстко:

- exact origin connection; redirect на другой origin, downgrade на `http://`, userinfo в URL или изменение host
  fail-closed без повторов;
- timeout 15 s на запрос, response cap 1 MiB, JSON только с declared `Content-Type`, unknown fields игнорируются
  только внутри strict `fields` projection, которую Loomrail сам запросил;
- `Authorization: Bearer <token>` добавляется только внутри client seam; заголовок никогда не логируется, не входит
  в error text и не попадает в диагностический payload;
- proxy environment variables не наследуются неявно; поддержка proxy — отдельное решение, а не побочный эффект;
- никаких webhooks, polling, background sync, listening sockets или scheduled requests. Каждый сетевой вызов
  происходит внутри exact owner-initiated command или явно созданной durable writeback;
- YouTrack v1 endpoints: read issue с exact `fields` projection, current user probe, create comment, optional
  command `State <doneStateName>` на одну issue. Другие endpoints не вызываются.

Все ошибки нормализуются в один exported typed error с closed code set. Raw response, raw URL с токеном или stack
не пересекают seam.

## 6. Import

### I1-D1 — Issue становится Draft WorkItem, а не наоборот

`POST .../tracker-imports/preview` принимает только `issueKey` вида `PROJ-123`, проверяет, что prefix совпадает с
connection `projectShortName`, читает issue и возвращает inert preview:

- readable id, url, summary (bounded до title limit), description как bounded untrusted text;
- proposal acceptance criteria из Markdown checklist строк `- [ ]` / `- [x]` в description, максимум 50, каждая до
  500 символов; отсутствие checklist даёт пустой proposal;
- proposed `type` — `TASK`, либо `BUG`, если YouTrack `Type` равен `Bug`; остальное `TASK`;
- snapshot hash и `REMOTE_UPDATED` время;
- предупреждение, что текст issue является untrusted input и попадёт в provider context как описание WorkItem.

Owner редактирует title, description, type, priority и criteria в той же форме и подтверждает import с exact preview
hash. Изменившийся snapshot требует нового preview. Import создаёт WorkItem через существующий `CREATE_WORK_ITEM` в
`BACKLOG` и в той же transaction записывает `TrackerLink` и Event `TRACKER_ISSUE_IMPORTED` с provenance без description.

### I1-D2 — Один open WorkItem на issue

Повторный import той же issue при существующем WorkItem не в `DONE | CANCELLED` отклоняется typed conflict с ссылкой
на существующий WorkItem. После `DONE | CANCELLED` новый import допустим и создаёт новый WorkItem с новым link; старый
link остаётся в истории.

### I1-D3 — Никакой автоматической authority из трекера

YouTrack поля `State`, `Assignee`, `Sprint`, `Priority`, `Estimation` не отображаются на workflow state, гейты или
бюджеты. Priority предлагается только как editable default в preview. Изменение issue после import не меняет WorkItem;
explicit owner `refresh` показывает `REMOTE_CHANGED` с новым snapshot hash и ничего не применяет.

## 7. Write-back

### I1-D4 — Только после ACCEPT и только по явному действию

Write-back допустим, когда:

1. у WorkItem есть active `TrackerLink` c connection status `OK`;
2. current `AcceptancePackage` разрешён `RESOLVE_ACCEPTANCE` с `action = ACCEPT` и WorkItem в `DONE`;
3. connection имеет `externalPublicationAcknowledged`;
4. для этого `acceptancePackageId` нет writeback в `QUEUED | SENDING | DELIVERED | UNKNOWN`.

`RETURN_TO_WORK` и `REJECT` в v1 ничего не отправляют. Automatic write-back для trusted projects не входит в I1 и
требует отдельного решения после dogfood.

### I1-D5 — Payload детерминирован и построен из allowlisted seam

`TrackerWritebackPayload` строится pure function из exact AcceptancePackage тем же модулем, что Q3 ReleaseSummary
export, плюс фиксированный заголовок: имя продукта, версия, WorkItem title, exact tree short hash, дата acceptance.
Дополнительная external-publication проверка запрещает в payload:

- absolute paths, machine/user names, local URLs и порты, Project root;
- raw provider output, transcripts, stdout/stderr excerpts, log lines;
- artifact storage refs, internal opaque IDs кроме WorkItem readable reference;
- secret-like canaries из существующего redaction test set.

Нарушение даёт `PAYLOAD_REJECTED` до любой сети. Payload ограничен 64 KiB; превышение усекает только audit trail
секцию с явным маркером, матрица критериев не усекается.

Preview показывает exact текст и его hash. Commit принимает только этот hash; изменение package или connection между
preview и commit требует нового preview.

### I1-D6 — Durable outbox без автоматического повторного публикования

Commit создаёт `TrackerWriteback(QUEUED)` в одной transaction с Event и durable follow-up по ADR-0002. Dispatcher:

1. durable переводит `QUEUED -> SENDING` до первого сетевого байта;
2. создаёт комментарий; при успехе сохраняет remote comment id;
3. если задан `doneStateName`, отдельно применяет state command; неудача state после успешного комментария даёт
   `DELIVERED / STATE_FAILED`, а не повтор комментария;
4. записывает terminal status в той же transaction с Event.

Создание комментария в YouTrack не идемпотентно, поэтому unknown outcome не replay. Restart при `SENDING` даёт
`UNKNOWN / DAEMON_RESTART`; UI просит владельца проверить issue и предлагает explicit retry, который создаёт новую
попытку с новым ordinal. Typed `FAILED` (`UNAUTHORIZED | UNREACHABLE | REJECTED_BY_TRACKER | PAYLOAD_REJECTED |
TIMEOUT`) до подтверждённой отправки допускает retry без ручной проверки.

```text
QUEUED -> SENDING -> DELIVERED | DELIVERED / STATE_FAILED | FAILED
SENDING -> UNKNOWN / DAEMON_RESTART
QUEUED -> CANCELLED (owner, до SENDING)
```

## 8. Persistence

- migration append-only: `tracker_connections`, `tracker_links`, `tracker_writebacks`; WorkItem таблица не меняется,
  link хранится отдельно;
- unique index на `(project_id, issue_key)` среди links, чьи WorkItem не terminal, реализуется через domain check в
  transaction, а не только через SQL, чтобы conflict был typed;
- secret никогда не в SQLite; таблица connection хранит `secret_ref` как opaque marker наличия, не значение;
- duplicate command id возвращает прежний result; expected-version conflict ничего не пишет; duplicate delivery
  completion не создаёт второй Event.

## 9. API и UI

Authenticated routes, Origin/CSRF на всех мутациях:

- `GET /api/v1/projects/:id/tracker-connection` — connection без secret, status, revision;
- `PUT /api/v1/projects/:id/tracker-connection` — create/update с expected version;
- `PUT /api/v1/projects/:id/tracker-connection/secret` — write-only; ответ не содержит secret;
- `DELETE /api/v1/projects/:id/tracker-connection/secret`;
- `POST /api/v1/projects/:id/tracker-connection/probe` — read-only auth probe;
- `POST /api/v1/projects/:id/tracker-imports/preview` — inert preview по `issueKey`;
- `POST /api/v1/projects/:id/tracker-imports` — commit с preview hash и owner edits;
- `POST /api/v1/work-items/:id/tracker-link/refresh` — remote hint без применения;
- `GET /api/v1/work-items/:id/tracker-writeback/preview` — exact payload и hash;
- `POST /api/v1/work-items/:id/tracker-writebacks` — commit с payload hash;
- `POST /api/v1/tracker-writebacks/:id/retry` и `/cancel`;
- `GET /api/v1/work-items/:id/tracker-writebacks` — paged summaries.

API не принимает URL с path, произвольные headers, secret в теле connection, raw comment text от клиента или список
issues для массового import.

Project Settings: одна секция `Tracker`, где owner видит exact origin, project short name, состояние secret словами,
probe result и явное предупреждение о внешней публикации перед `externalPublicationAcknowledged`.

Kanban: карточка WorkItem с link показывает readable key текстом, без цвета как единственного сигнала.

Task Cockpit: секция `Tracker`:

- link, snapshot время, `REMOTE_CHANGED` hint и `Refresh`;
- `Report to YouTrack` только когда I1-D4 допускает; кнопка открывает preview с полным текстом;
- writeback list: `Queued | Sending | Delivered | Delivered, state not changed | Failed | Unknown, check issue |
Cancelled`, время, ordinal, remote comment link при наличии;
- loading/empty/error/restart states, RU/EN, keyboard, focus, narrow/light/dark.

Import из Kanban: действие `Import from YouTrack` открывает форму с `issueKey`, затем editable preview.

## 10. Security и privacy deltas

Implementation plan обязан добавить в `docs/security/THREAT-MODEL.md`:

- **T50** — tracker credential или payload утекает через логи, Event, export, provider context или off-origin
  redirect. Mitigation: secret seam вне SQLite, bearer только внутри client, exact origin, typed errors без raw
  response, no proxy inheritance, no background sender.
- **T51** — imported issue text используется как prompt injection или как источник authority. Mitigation: text
  помечен untrusted, owner редактирует до создания WorkItem, никакие поля трекера не отображаются на workflow state,
  provider не знает про connection.
- **T52** — write-back публикует чувствительные локальные данные или дублирует комментарии. Mitigation: allowlisted
  payload builder, external-publication check, exact preview hash, SENDING-before-network, no replay of unknown
  outcome, explicit owner retry.

Раздел 8 «Secret classification» получает строку `Tracker token | YouTrack permanent token | OS credential store
only; write-only API; never in SQLite/Event/context`. Раздел 9 фиксирует, что write-back является единственной
исходящей публикацией и каждая попытка durable audited.

PRODUCT-DECISIONS раздел 14 обновляется: пункт «bidirectional GitHub/Jira/YouTrack adapters» заменяется на
«tracker round-trip реализуется как import + acceptance write-back по I1; bidirectional sync остаётся отложенным».

## 11. Required verification

- contracts/domain: unknown fields, bounds, origin validation, issueKey grammar, checklist extraction, one-open-link
  rule, payload determinism и hash, external-publication rejections, every allowed/forbidden writeback transition,
  idempotency;
- secret store: put/get/delete, missing store fail-closed, secret absent from SQLite dump, Event stream, logs,
  diagnostics и reporting payload (canary test);
- tracker client: recorded YouTrack Cloud и self-hosted fixtures, off-origin redirect, http downgrade, oversized
  response, wrong content type, timeout, 401/403/404/5xx normalization, bearer absent from any error/log output;
- persistence: migration на старых базах, transaction import + link + Event, duplicate command, conflict, restart
  reconciliation `SENDING -> UNKNOWN`, no automatic resend;
- workflow: write-back недопустим до ACCEPT, после RETURN/REJECT, при `SECRET_MISSING`, при stale package, при
  существующем DELIVERED/UNKNOWN для того же package; state failure после comment не повторяет comment;
- HTTP/UI: auth/Origin/CSRF, write-only secret, inert preview, exact hash commit, Settings/Kanban/Task Cockpit
  states, RU/EN, keyboard, light/dark/narrow, daemon restart;
- macOS/Windows: credential store на обеих платформах, одинаковая fixture semantics;
- dogfood exit: одна реальная задача из YouTrack проекта владельца проходит полный маршрут и получает комментарий с
  ReleaseSummary; скриншоты санитизированы по правилам репозитория.

## 12. Exit и non-goals

I1 закрыт, когда fixture Project с recorded YouTrack fixture импортирует issue, проходит полный маршрут до `ACCEPT`,
доставляет один комментарий с проверенным payload, корректно переживает restart в `SENDING` без второго комментария,
а real dogfood подтверждает то же на живом YouTrack. Secret canary ни разу не появляется вне store.

Не входят: bidirectional sync, webhooks, polling, автоматический write-back, создание issue из Loomrail, upload
attachments/screenshots, произвольные custom fields, mapping спринтов/assignee/estimation, массовый import, Jira,
GitHub Issues и Linear adapters (они идут за тем же client/link/writeback seam отдельными спеками), OAuth, proxy
support, комментарии на промежуточных стадиях, комментарии при RETURN/REJECT, Sprint как сущность Loomrail.
