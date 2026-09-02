# Q3 — Criterion-bound Acceptance Package и release summary export

**Дата:** 2026-09-02

**Статус:** implemented; shared release gate pending

**Предшественники:** M6, R1, Q1, Q2

**Нормативные решения:** Evidence over confidence, final human gate, Q2-D6, T05, T08, T35, T38, T39

## 1. Outcome

Acceptance больше не создаёт одинаковую синтетическую строку для каждого acceptance criterion. Acceptance-stage
provider предлагает bounded `AcceptanceCriterionClaim`, а Loomrail проверяет полное взаимно-однозначное соответствие
критериям WorkItem и привязывает каждый claim к конкретной проверке текущего независимого Review artifact и
конкретной проверке current-tree measured QA artifact.

Владелец видит эту связь в Task Cockpit и может скачать детерминированный Markdown `ReleaseSummary` с матрицей,
lineage evidence и полным bounded audit trail. Экспорт ничего не публикует и не выдаёт право на Git, merge, deploy,
registry или filesystem mutation.

## 2. Текущий разрыв

M6 уже хранит `AcceptancePackage` и два artifact ID, но строит каждую строку матрицы одинаково: generic
implementation summary, один Review artifact, один QA artifact и позиционная fallback-инструкция. Provider не обязан
объяснять, какая именно Review/QA check доказывает criterion, а domain не проверяет полноту или точность mapping.

Task Cockpit показывает только criterion и одну verification-строку. Читаемого export с package, evidence lineage и
audit trail нет. Поэтому Phase 7 exit gate «у каждого criterion есть evidence» и stable-version checklist по export
ещё не доказаны.

## 3. Решения

### Q3-D1 — AcceptanceCriterionClaim является предложением, а не authority

`READY_FOR_ACCEPTANCE` содержит ordered `criteria`, по одному claim на каждый сохранённый criterion WorkItem:

- exact `criterion` text;
- `implementation` — что именно реализовано;
- `reviewCheck` — exact существующая check текущего Review artifact;
- `qaCheck` — exact существующая check текущего measured QA artifact;
- `ownerVerification` — короткий воспроизводимый шаг для владельца;
- nullable `knownRisk`.

Все строки и массивы используют существующие bounds. Provider не передаёт artifact/report/run IDs, status, tree или
attribution. Эти authority fields Loomrail получает только из durable current state.

### Q3-D2 — Матрица fail-closed и полна

При создании нового package domain требует:

1. у WorkItem есть хотя бы один acceptance criterion;
2. число claims равно числу criteria;
3. claims идут в том же порядке и содержат exact criterion text без duplicate/missing/extra строк;
4. `reviewCheck` является exact элементом current-tree Review artifact `checks`;
5. `qaCheck` является exact элементом current-tree measured QA artifact `checks`;
6. Review/QA artifacts уже прошли R1/Q2 authority-lineage gate;
7. top-level `verifyInstructions` остаются bounded общими инструкциями и не заменяют per-criterion evidence.

`AcceptanceCriterionEvidence` сохраняет selected `reviewCheck`, `qaCheck` и `ownerVerification` вместе с уже
существующими artifact IDs. Поля читаются optional только для совместимости с package, созданными до Q3; новый
package без них создать нельзя. Legacy package остаётся видимым, но UI и export явно маркируют его как legacy
unbound evidence и не приписывают ему Q3-гарантию.

### Q3-D3 — ReleaseSummary является чистой read model

ReleaseSummary не получает отдельный mutable lifecycle. Pure renderer принимает один согласованный read snapshot:

- WorkItem и AcceptancePackage;
- referenced Review/QA EvidenceArtifacts;
- measured QA bundle и безопасные attachment summaries;
- Decisions и Events exact WorkItem.

Результат — UTF-8 Markdown с устойчивым section order: identity/status, release note, criterion matrix, overall verify
instructions, evidence lineage, QA attachments, owner resolution и chronological audit trail. Любой provider/user text
экранируется как Markdown data; raw HTML не переносится. Storage key, absolute path, provider transcript, repository
contents, secrets и session data не включаются.

Audit читается страницами с закрытым общим лимитом 1000 Events. Если complete trail не помещается, export fail-closed
и не выдаёт усечённый файл за полный. Максимальный размер готового Markdown — 512 KiB.

### Q3-D4 — Export route только читает

Authenticated `GET /api/v1/work-items/:workItemId/acceptance/:acceptancePackageId/export`:

- проверяет exact WorkItem/package correlation;
- возвращает `text/markdown; charset=utf-8`, `Content-Disposition: attachment`, `Cache-Control: private, no-store` и
  `X-Content-Type-Options: nosniff`;
- использует portable filename, построенный только из opaque package ID;
- доступен для PENDING и resolved package, чтобы owner мог изучить evidence до решения и сохранить итог после него;
- не принимает mutation body, capability, target path или output filename.

Task Cockpit показывает download action рядом с owner gate. Browser получает файл через текущую HttpOnly session;
никакой bootstrap/session token не попадает в URL.

## 4. Transaction и consistency boundaries

Создание criterion-bound package остаётся частью существующей атомарной `APPLY_PROVIDER_OUTCOME` transaction:
StageAttempt/Run/WorkItem, blocking HumanRequest, AcceptancePackage, Event и receipt записываются вместе. Ошибка любого
claim отклоняет всю command до изменения state.

Export не открывает transaction и не меняет state. Endpoint сначала загружает package/snapshot и все referenced rows,
проверяет correlation и completeness, затем рендерит. Если concurrent acceptance resolution произошёл между чтениями,
version/status mismatch приводит к одному bounded retry; повторное расхождение возвращает typed conflict, а не
смешанный summary.

## 5. Threat delta

Новые риски: provider ссылается на удобную, но отсутствующую check; duplicate criterion скрывает omission; stale
artifact выглядит current; Markdown/filename injection превращает export в active content; export раскрывает storage
path или выдаёт incomplete audit как полный; cross-WorkItem IDOR скачивает чужой package.

Контроли: exact ordered total mapping; domain-owned artifact IDs и Q2 current-tree lineage; closed schemas и bounds;
escaped text-only Markdown; opaque portable filename; session и exact correlation; no-store/nosniff; allowlisted fields;
complete-or-error event pagination; byte ceiling; read-only route без path/body authority.

## 6. Acceptance criteria

1. READY_FOR_ACCEPTANCE без criterion claims, с reordered/duplicate/missing/extra criterion отклоняется без state change.
2. Claim с Review/QA check, которой нет в выбранном current evidence artifact, отклоняется.
3. Новый package сохраняет для каждого criterion implementation, exact Review/QA artifact IDs, selected checks,
   owner verification и known risk.
4. Legacy pre-Q3 package продолжает читаться и явно помечается как unbound, без ложной Q3-гарантии.
5. Task Cockpit показывает полную criterion matrix в RU/EN, light/dark, keyboard и 320 px.
6. Authenticated owner скачивает deterministic Markdown до и после решения; foreign session/correlation получает
   fail-closed ответ.
7. Export содержит readable artifacts, QA attachment metadata, resolution и полный chronological audit trail, но не
   содержит storage keys, absolute paths, raw HTML, cookies/tokens или provider transcripts.
8. Over-limit/inconsistent export не отдаётся частично; retry одного и того же stable snapshot byte-identical.
9. Existing Q2 fail → fix → review → scoped pass → acceptance E2E создаёт criterion-bound package и скачивает export.

## 7. Non-goals

- npm publish, Git tag/commit/push, merge, deploy или release orchestration;
- PDF/DOCX/ZIP export, cryptographic signing или remote sharing;
- semantic inference, что произвольный test действительно доказывает criterion;
- сохранение repository diff/source files внутри export;
- изменение Review/QA evaluator после выполнения;
- редактирование acceptance criteria внутри уже начатого PipelineRun;
- превращение legacy package в Q3-bound задним числом.
