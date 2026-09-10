# L3 — Environment, Release и Launch Evidence Package

**Дата:** 2026-09-10

**Статус:** Implemented and production-shaped dogfooded on macOS; Windows verification pending

**Основание:** PD-029, ADR-0028, L-track D1/D2/D12, L1, L2, Q17, R1, Q1–Q3

## 1. Outcome

Владелец создаёт именованное `PREVIEW` или `PRODUCTION` окружение, затем одним явным действием фиксирует
неизменяемый `Release` на текущем дереве Project. Loomrail связывает Release только с уже существующими durable
evidence и экспортирует bounded Launch Evidence Package. L3 ничего не запускает, не обращается к объявленному URL,
не читает значения переменных окружения и не выдаёт разрешение на deploy.

Каноническая формулировка результата: «на снимке `<tree>`, `<date>` пройдено N из M обязательных gates» с полным
перечнем `ACTION_REQUIRED | FAILED | STALE` и того, что не проверялось. Термин `production ready` не является
доменным verdict.

## 2. Граница глубокого модуля

Публичный доменный контракт L3 состоит из четырёх операций:

1. `saveEnvironment` — HUMAN-only create/update одного из максимум восьми Project environments;
2. `createRelease` — HUMAN-only immutable capture из exact durable sources;
3. `releaseFreshness` — чистое сравнение Release с текущими source identities;
4. `renderLaunchEvidencePackage` — чистый, bounded и redacted Markdown renderer.

HTTP, React и SQLite не вычисляют verdict самостоятельно. Provider adapters и provider context не импортируют L3
mutation contract. Infrastructure разрешает только IDs/versions/digests и передаёт домену уже проверенные records;
provider text, raw output, filesystem paths, environment values и HTTP bodies в Release не входят.

## 3. Environment v1

`LaunchEnvironment` содержит:

- стабильный `id`, Project, `PREVIEW | PRODUCTION`, отображаемое имя и optimistic `version`;
- builtin preset `WEB_APP_V1` revision `1`;
- owner-declared HTTPS origin без credentials/path/query/fragment;
- health path;
- до 32 portable имён требуемых environment variables, но никогда их значения;
- canonical `contentHash`, timestamps.

В v1 в одном Project существует не более одного активного environment каждого kind. Update сохраняет тот же id,
увеличивает version и пишет Event; уже созданные Release сохраняют полный immutable Environment snapshot. URL в L3
является только строкой декларации и не даёт network authority.

## 4. Release v1

`Release` неизменяем и включает:

- Project и точный Git tree текущего registered repository;
- признак dirty из выбранного readiness evidence и его source digest;
- exact Environment snapshot;
- exact IDs/versions accepted WorkItem packages, выбранных владельцем (0–50);
- exact current Project Readiness Run, Launch Measurement Plan/Run и Verification Plan identities, если они есть;
- закрытый каталог gate snapshots;
- canonical content hash и timestamp.

Create request содержит только expected Project/Environment versions и список WorkItem IDs. Persistence в одной
transaction перечитывает Project, Environment, latest readiness, current Plans/measurement и latest workflow каждого
WorkItem. Отсутствующий, foreign, duplicate или изменившийся source закрывается typed error. Filesystem tree снимается
daemon до команды только из Git repository без незавершённого merge/rebase/cherry-pick/bisect; после записи API
повторно читает tree и возвращает `STALE`, если repository изменился в окне.
Release не удаляется и не обновляется.

## 5. Gate catalog

Release содержит 24 закрытых gates:

- 14 `READINESS/*` — exact checks L1;
- `VERIFICATION/REQUIRED_RECIPES` — Q17 evidence каждого выбранного WorkItem;
- 6 `MEASURED/*` — L2 gate results;
- `REVIEW/SELECTED_WORK_ITEMS`, `QA/SELECTED_WORK_ITEMS`, `ACCEPTANCE/SELECTED_WORK_ITEMS` — lineage каждого
  выбранного WorkItem.

Статусы L3: `PASSED | ACTION_REQUIRED | FAILED | STALE`. Отсутствующее evidence никогда не становится `PASSED`.
Aggregate workflow gate требует непустой owner selection; каждый выбранный WorkItem должен принадлежать Project.
`PASSED` требует readiness, accepted package и authority-bound Review/QA/Verification evidence на Release tree.
Readiness с другим `repositoryHead` становится `STALE`; любая смесь Project/WorkItem/PipelineRun/tree даёт typed
refusal, а не частичный пакет.

AcceptancePackage является authority для выбора артефактов внутри истории PipelineRun: Release использует только
точные `artifactIds`, записанные в выбранном пакете. Более ранние correction-артефакты того же run считаются
superseded и не входят в Release; ссылка пакета на отсутствующий или cross-boundary артефакт закрывается typed
refusal. Review/QA gate принимает только артефакт с соответствующей measured authority и `testedTree`; legacy prose
без authority остаётся `ACTION_REQUIRED`. Review, QA и Verification должны называть один tree даже когда один из
трёх источников отсутствует.

Неотключаемые future-deploy gates уже помечены `waivable: false`:
`READINESS/SECURITY_SECRET_PATHS`, `READINESS/ENV_PROD_SEPARATION`,
`MEASURED/SEC_CLIENT_BUNDLE_SECRETS`. L3 не реализует waiver вообще.

## 6. Freshness

Release является историческим фактом и не меняется. Read model отдельно возвращает:

- `CURRENT`, если current tree, Environment version/hash, readiness source, active Verification/Measurement Plans,
  latest measurement Run и выбранные AcceptancePackage versions совпадают;
- `STALE` с закрытыми причинами `TREE_CHANGED | ENVIRONMENT_CHANGED | READINESS_CHANGED |
VERIFICATION_PLAN_CHANGED | MEASUREMENT_CHANGED | ACCEPTANCE_CHANGED`.

Изменение любого source не переписывает gate snapshots и не удаляет старый export.

## 7. Launch Evidence Package

Renderer принимает только validated Release и выдаёт UTF-8 Markdown не более 512 KiB. Он показывает snapshot,
environment declaration, counts, все gates, evidence refs, выбранные WorkItems и limitations. Untrusted display text
экранируется как Markdown/HTML, абсолютные macOS/Windows paths и credential-like URL fragments редактируются.
Environment values, repository path, provider payload/output, headers/bodies, cookies и tokens отсутствуют в input
schema, поэтому не могут попасть в export.

## 8. Persistence и audit

Migration добавляет `launch_environments` и append-only `launch_releases`. Каждая mutation вместе с Project version,
Event и command receipt сохраняется одной `BEGIN IMMEDIATE` transaction. Command replay возвращает исходный result;
reuse command ID с другим payload закрывается existing `COMMAND_ID_REUSED`. Restart ничего не replay-ит: L3 не имеет
внешнего side effect или pending state.

## 9. UI

`Project Settings → Launch` показывает Environment editor, действие «Create evidence snapshot», свежесть последнего
Release, N/M обязательных gates и таблицу непрошедших gates. Создание явно подписано как evidence snapshot, а не
deploy. Все состояния имеют текст, keyboard focus, RU/EN и не зависят только от цвета. Export скачивается только по
authenticated same-origin read route.

## 10. Security verification

- HUMAN-only + session/Origin/CSRF mutations;
- foreign/duplicate/stale IDs, expected-version conflict и command replay;
- cross-Project/WorkItem/PipelineRun/tree evidence mixing;
- missing evidence and dirty/current tree behavior;
- refusal while a Git operation is in progress;
- URL credentials, non-HTTPS, path/query/fragment and control-character rejection;
- Markdown/HTML injection, absolute macOS/Windows paths, `.env`, token and provider-payload canaries;
- 50 WorkItems, 24 gates and 512 KiB export bounds;
- spaces/Unicode names and Windows path redaction;
- restart read and immutable rows/triggers.

## 11. Non-goals

- deploy command, hosting API/CLI, external probe, secrets or OS credential store;
- waiver, Deployment Approval, status resolution, rollback or automatic retry;
- L4/L5 authority;
- claim that a Release with all current gates is safe or ready for production.

## 12. Exit gate

На production-shaped Recurkit state владелец может создать Environment и Release, увидеть честные target gaps из L1,
L2 и accepted workflow evidence, скачать sanitized package и после repository/evidence change увидеть `STALE`.
Focused tests, full `pnpm verify`, E2E, fault/restart, release pack/install и macOS/Windows CI проходят.
