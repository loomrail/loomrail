# D2 — Воспроизводимый live-маршрут: спецификация

**Дата:** 2026-08-29

**Статус:** завершено; настоящий маршрут достиг pending owner Acceptance

**Предшественник:** D1 — установка, provider selection, Human Requests, budgets, Changes и acceptance уже описаны
пользовательским маршрутом.

**Нормативные входы:**

- [`PRODUCT-DECISIONS.ru.md`](../product/PRODUCT-DECISIONS.ru.md) — PD-001, PD-003, PD-007, SD-001 и GD-002;
- [`MASTER-PLAN.ru.md`](../product/MASTER-PLAN.ru.md) — evidence over confidence и human-only acceptance;
- [`06-post-phase-0-decomposition.ru.md`](06-post-phase-0-decomposition.ru.md) — место и объём D2;
- [`11-a2-live-provider-adapters-spec.ru.md`](11-a2-live-provider-adapters-spec.ru.md) — граница live CLI;
- [`13-e1-workspace-execution-spec.ru.md`](13-e1-workspace-execution-spec.ru.md) — доступ стадий к worktree;
- [`THREAT-MODEL.md`](../security/THREAT-MODEL.md) — provider output недоверен, worktree не является sandbox.

---

## 1. Проблема

D1 честно описывает live-маршрут, но не доказывает его одним воспроизводимым запуском. Проверка перед D2 обнаружила
три разрыва, из-за которых пример нельзя получить без ложного результата:

1. Codex и Claude Code ограничивают финальный ответ только `checkpointDraftSchema` и всегда переводят его в общий
   `COMPLETED`. Review и QA поэтому не могут создать обязательные `REVIEW_REPORT` и `QA_REPORT`.
2. Persisted `EvidenceArtifact.provider` и SQLite допускают только `MOCK`; даже принятый live artifact был бы ложно
   атрибутирован mock-провайдеру.
3. Общий `COMPLETED` на последней стадии сейчас завершает PipelineRun, минуя `READY_FOR_ACCEPTANCE`, durable package и
   решение владельца.

Mock-маршрут эти дефекты не показывает: его scripted adapter уже возвращает typed evidence и
`READY_FOR_ACCEPTANCE`. Поэтому он остаётся demo, но не является доказательством D2.

---

## 2. Результат D2

D2 даёт два связанных результата:

- runtime-контракт, по которому live provider может завершить каждую из шести стадий честным stage-specific
  результатом;
- небольшой воспроизводимый Git fixture и отчёт одного настоящего маршрута Discovery → Acceptance с Decisions,
  diff, Review evidence, QA evidence и pending owner acceptance.

Настоящий provider invocation расходует пользовательскую квоту и запускается только после явного разрешения
владельца. До него весь контракт проверяется локальными doubles и integration-тестами.

---

## 3. Решения

### D1 — Финальный output contract зависит от стадии

Общий модуль `provider-core` владеет единственным отображением `WorkflowStage -> JSON Schema -> ProviderOutcome`.
Codex и Claude Code используют его одинаково; каждый адаптер отвечает только за envelope своего CLI.

- Discovery, Plan и Implement: `COMPLETED` с checkpoint-полями либо `NEEDS_HUMAN`.
- Review: то же, но успешный результат обязан нести один `REVIEW_REPORT`.
- QA: то же, но успешный результат обязан нести один `QA_REPORT`.
- Acceptance: `READY_FOR_ACCEPTANCE` либо `NEEDS_HUMAN`; обычный `COMPLETED` не является допустимым результатом этой
  стадии.

Схемы строгие, имеют закрытый discriminant `type` и stage-specific literal для evidence kind. Невалидный успешный
ответ не превращается в prose fallback: сессия считается непродуктивной и приводит к уже существующему безопасному
pause/request пути.

CLI получает совместимый со Structured Outputs envelope `{ "result": <stage result> }`: корень каждой схемы —
`object` с одним обязательным полем, а допустимые stage outcomes представлены вложенным `anyOf`. Это важно не только
для типизации: корневой union, который Zod генерирует из `discriminatedUnion`, не принимается ограниченным JSON Schema
реального Codex. Unit-тест строит все шесть CLI schemas и запрещает корневой union, `oneOf`, необязательные object
fields и открытые `additionalProperties`.

### D2 — Provider identity приходит рядом с outcome, но не из outcome

`APPLY_PROVIDER_OUTCOME.payload.provider` передаёт `capabilities().provider` из daemon. Поле находится рядом с
недоверенным `outcome`, как измеренный daemon-ом `resultTree`: модель не выбирает собственную атрибуцию.

Для совместимости с уже записанными command receipts поле опционально только на parse boundary; отсутствие означает
исторический `MOCK`. Все новые production-вызовы обязаны его передавать. `ProviderId` живёт в `contracts`, чтобы
EvidenceArtifact, command и provider-core ссылались на один закрытый enum без обратной зависимости.

SQLite получает новую migration, которая сохраняет существующие строки и расширяет CHECK до `MOCK`, `CODEX` и
`CLAUDE_CODE`. Старая migration не редактируется.

### D3 — Acceptance нельзя завершить общим success

Domain отклоняет `COMPLETED` на стадии Acceptance до вычисления `nextStage === null`. Единственный happy-path:

```text
READY_FOR_ACCEPTANCE
  -> durable AcceptancePackage + blocking HumanRequest
  -> HUMAN ACCEPT / RETURN / REJECT
```

Это инвариант домена и проверяется отдельным forbidden-transition тестом, независимо от адаптеров.

### D4 — Typed evidence остаётся утверждением провайдера, не автоматическим тестовым фактом

Review/QA artifact содержит provider-authored title, summary и checks и помечается фактическим provider id. Loomrail
валидирует форму, стадию и kind, но не переименовывает этот текст в independently measured browser evidence. В Phase 0
`PASSED` означает принятый stage contract; автоматическое исполнение команд и BrowserDriver остаются вне текущего
scope.

### D5 — Repro fixture безопасен и мал

Fixture хранится как обычные synthetic source files без `.git`. Инструкция копирует его во временную директорию,
инициализирует новый локальный Git repository и регистрирует только этот путь. Пример не запускает агента на самом
репозитории Loomrail и не содержит абсолютных пользовательских путей, credentials или сырого transcript.

Задача bounded: одно небольшое изменение с детерминированной проверкой стандартной библиотекой/существующим runtime;
никаких установок dependencies, сети, push, merge или commit от имени агента.

### D6 — Отчёт отделяет повторяемую инструкцию от одного наблюдения

`docs/examples/full-route/README.md` содержит повторяемую процедуру и ожидаемые gates. Отдельный sanitized report
фиксирует дату, версии CLI, выбранный provider, Decisions, итоговый diff summary, evidence и состояние acceptance.
Он не включает token/bootstrap/CSRF, provider transcript, data directory или персональный absolute path.

До разрешённого настоящего запуска report остаётся явно помеченным как pending, а D2 — незавершённым. Разрешённый
запуск 2026-08-29 достиг pending owner Acceptance; финальное принятие намеренно не выполнялось как часть проверки.

### D7 — Один provider owner gate до явного retry

Настоящий маршрут показал, что prompt-инструкции не ограничивают повторный `NEEDS_HUMAN`: после сохранённого
Decision Codex семь раз выбирал ту же structurally available ветку. Поэтому daemon выводит политику из durable
HumanRequests текущего StageAttempt и передаёт `humanRequests: ALLOWED | DISALLOWED` в ProviderInvocation.

После первого HumanRequest оба live adapters исключают эту ветку из CLI schema не только для resumed session, но и
для первых попыток автоматически следующих стадий. Общий decoder повторно проверяет политику и отвергает
provider-authored request даже если CLI проигнорировал schema. `RESUME` сам по себе не используется как признак: он
также обслуживает soft pause и interrupted recovery без owner gate. Явный retry (`StageAttempt.attempt > 1`) получает
один новый gate для действительно новой бизнес-развилки. Отдельный domain-owned AcceptancePackage этим правилом не
ослабляется.

---

## 4. Проверка

- contracts/provider-core unit: каждая стадия принимает только свой typed result; неизвестные поля и неверный kind
  отклоняются;
- Codex/Claude adapter unit: в CLI передаётся stage schema, envelope переводится в точный outcome, невалидный terminal
  result не становится `COMPLETED`;
- domain unit: Review/QA требуют evidence; live provider сохраняется; Acceptance `COMPLETED` запрещён;
- persistence integration: migration сохраняет старый MOCK artifact, принимает CODEX/CLAUDE_CODE и отклоняет
  неизвестный provider;
- daemon integration: live-shaped adapter проходит шесть стадий на временном настоящем Git repository, сохраняет
  Decision, переключает policy с `ALLOWED` на `DISALLOWED`, сохраняет diff/evidence и останавливается на owner
  acceptance;
- `pnpm verify`, узкий Playwright/HTTP путь примера и `git diff --check`;
- после явного разрешения — один настоящий Codex route и sanitized evidence report.

---

## 5. Критерии приёмки

1. Codex может пройти Discovery, Plan, Implement, Review и QA и открыть pending AcceptancePackage, не используя mock
   outcomes.
2. Review/QA evidence хранит `provider: "CODEX"` (или фактический другой live provider), а не `MOCK`.
3. Никакой provider не может завершить WorkItem или PipelineRun обычным `COMPLETED` на Acceptance.
4. Невалидный/свободный provider result fail-closed и не превращается в успешную стадию.
5. Повторяемая инструкция работает на synthetic repository вне Loomrail checkout и показывает Decisions, Changes,
   evidence и owner gate.
6. Репозиторий не содержит secrets, raw transcript, runtime SQLite, worktree или персональные absolute paths.
7. После первого HumanRequest автоматический first-attempt путь не может открыть ещё один provider-authored owner
   gate; явный retry получает один новый gate, а Acceptance остаётся отдельным обязательным решением владельца.

---

## 6. Не входит в D2

- реальный BrowserDriver и автоматически измеренные screenshots/traces — D5/Phase 7;
- shell/test command runner как новое полномочие;
- Claude Code write path, пока он не подтверждён отдельной reconnaissance;
- автоматический commit, push, merge или публикация;
- использование provider quota без прямого разрешения владельца;
- маркетинговые скриншоты — D3.
