# R1 — Независимый review-loop

**Дата:** 2026-09-02

**Статус:** approved implementation baseline

**Предшественники:** E1, E1.5, A2, A3
**Нормативные решения:** TD-002, TD-003, AD-006, AD-007, WD-006, BD-003

## 1. Outcome

Изменение не может пройти REVIEW только потому, что автор сообщил «готово». Loomrail запускает отдельный
`CODE_REVIEWER` AgentRun над стабильным Git tree, передаёт ему fresh context без transcript автора, сохраняет
структурированные findings и либо продолжает в QA, либо возвращает работу Developer. Автоматический цикл ограничен.

## 2. Текущая ложная граница

Сегодня REVIEW уже отдельная StageAttempt и требует `REVIEW_REPORT`, но отчёт всегда получает статус `PASSED`.
Контракт не умеет выразить дефект, таблица evidence допускает только один REVIEW_REPORT на PipelineRun, а следующий
stage всегда QA. Кроме того, AUTO provider выбирается одинаково для всех стадий и review-контекст может получить
последний свободный checkpoint автора вместо review-ready handoff.

Это означает, что существующий REVIEW — typed summary, но ещё не независимый review-loop.

## 3. Решения

### R1-D1 — ReviewReport имеет вердикт

`ReviewReport` — append-only artifact со статусом:

- `PASSED`: findings пусты;
- `CHANGES_REQUESTED`: от одного до 20 findings.

Один StageAttempt создаёт не более одного отчёта. PipelineRun может иметь несколько отчётов — по одному на round.
Acceptance использует только последний `PASSED` REVIEW_REPORT, созданный после последнего IMPLEMENT tree.

### R1-D2 — Finding — отдельная durable сущность

Finding хранит severity, bounded title/description, optional portable file path и line range, reproduction,
acceptance-criterion reference, source ReviewReport, immutable creation identity и current lifecycle:

```text
OPEN -> RESOLVED | WAIVED | FALSE_POSITIVE
```

`RESOLVED` ставит только более поздний независимый review, который вернул `PASSED`. `WAIVED` и `FALSE_POSITIVE`
ставит только владелец с причиной. Provider не может назначить себе disposition через output.

### R1-D3 — Автор и reviewer различаются запуском

Независимость определяется не именем модели, а immutable AgentRun identity:

- REVIEW всегда получает новый AgentRun с ролью `CODE_REVIEWER`;
- он не может совпадать с AgentRun, завершившим последний IMPLEMENT;
- при `AUTO` и двух готовых live providers REVIEW предпочитает provider, отличный от автора;
- explicit Project preference или `LOOMRAIL_PROVIDER` остаётся lock: тогда используется отдельный AgentRun того же
  provider, а UI честно показывает `same provider`;
- если доступен один provider, отдельный AgentRun допустим по TD-002.

Exact provider фиксируется до spawn и повторно проверяется транзакцией `START_AGENT_RUN`.

### R1-D4 — Fresh context — отдельная политика

Первый session REVIEW получает только:

1. WorkItem brief и criteria;
2. authoritative Decisions;
3. stable result tree и bounded actual diff summary;
4. structured implementation handoff/test evidence;
5. OPEN findings предыдущего round, если это re-review;
6. Project Constitution/rules через уже существующую policy assembly.

Transcript, chain-of-thought и свободный `LATEST_CHECKPOINT` автора не включаются. Continuation внутри того же REVIEW
StageAttempt может получить собственный checkpoint для handoff; он не становится входом нового review round.

### R1-D5 — Bounded fix → re-review

Переходы принадлежат domain, а не provider prose:

```text
IMPLEMENT(n) -> REVIEW(n)
REVIEW(n, PASSED) -> QA
REVIEW(n, CHANGES_REQUESTED), n < 2 -> IMPLEMENT(n + 1)
REVIEW(2, CHANGES_REQUESTED) -> WAITING_HUMAN / REVIEW_LOOP_EXHAUSTED
```

На лимите Loomrail создаёт domain-owned HumanRequest. Автоматического третьего fix round нет. Владелец может ровно
один раз разрешить дополнительный bounded fix/re-review или отменить run; каждое действие versioned и попадает в
audit. Ручной takeover не симулируется переиспользованием reviewer-сессии: это отдельный будущий workflow с
reconciliation Git tree. `WAIVED`/`FALSE_POSITIVE` сохраняют решение по finding, но не подменяют обязательный
повторный review.

### R1-D6 — Stable checkpoint и stale review

ReviewReport и Finding фиксируют reviewed result tree. Перед записью outcome persistence сравнивает его с текущим
tree StageAttempt. Если tree изменился, отчёт отклоняется как stale и не закрывает findings. Новый IMPLEMENT tree
инвалидирует прежний PASSED report для acceptance без удаления истории.

### R1-D7 — UI — рабочая поверхность, не raw JSON

Task Cockpit показывает:

- review round, provider и relation `cross-provider | same-provider`;
- verdict и список findings с severity не только цветом;
- portable file/line location и reproduction;
- owner-only Waive / False positive с обязательной причиной;
- явный state `review loop needs decision`.

На 320 px finding превращается в последовательный блок без горизонтального скролла. Все действия доступны с
клавиатуры, RU/EN и в обеих темах.

## 4. Transaction boundary

Один `APPLY_PROVIDER_OUTCOME` для REVIEW атомарно:

1. проверяет command id/version, active AgentRun, роль reviewer и stable tree;
2. завершает ProviderSession, AgentRun и текущую StageAttempt;
3. пишет ReviewReport и Findings;
4. закрывает прежние OPEN findings только при новом `PASSED`;
5. создаёт следующую StageAttempt/dispatch либо HumanRequest;
6. пишет append-only events и command receipt;
7. commit; только потом SSE invalidation.

## 5. Threat delta

Новый High-риск: compromised reviewer может ложно закрыть собственную работу либо provider output может подменить
finding identity/disposition. Контроли: author/reviewer AgentRun relation из durable state; closed schemas; provider не
выбирает IDs/provider/status/disposition; owner actions требуют session + Origin + CSRF + expected version; all state,
event and follow-up in one transaction; React text rendering; bounded counts/text; portable paths никогда не читаются
как filesystem authority.

## 6. Acceptance criteria

1. Intentional defect даёт durable `CHANGES_REQUESTED` и OPEN Finding; QA не стартует.
2. Следующий Developer AgentRun исправляет работу, отдельный Reviewer AgentRun повторяет review.
3. `PASSED` re-review закрывает OPEN findings и только затем ставит QA в очередь.
4. Два подряд `CHANGES_REQUESTED` создают HumanRequest и не запускают третий round автоматически.
5. При AUTO + Codex + Claude reviewer использует другой provider; при одном provider UI показывает same-provider.
6. Reviewer first-session context не содержит checkpoint/transcript автора и содержит stable tree/handoff/findings.
7. Stale tree не может создать действующий PASSED report или закрыть findings.
8. Waive/False positive доступны только HUMAN и требуют reason/expected version.
9. Restart сохраняет reports/findings/loop limit и не дублирует следующий dispatch.
10. RU/EN, light/dark, keyboard, 320 px и reconnect покрыты browser QA.

## 7. Non-goals

- BrowserDriver и QA defect lifecycle (Phase 7);
- GitHub PR/merge/push;
- checkpoint commits и squash;
- semantic deduplication findings моделью;
- больше двух автоматических и одного owner-authorized fix round;
- автоматический owner waiver;
- raw provider transcript в review context или UI.
