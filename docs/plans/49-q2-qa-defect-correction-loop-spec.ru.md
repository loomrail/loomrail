# Q2 — Durable QA Defect correction loop

**Дата:** 2026-09-02

**Статус:** approved implementation baseline; implementation starts after the full Q1 gate

**Предшественники:** R1, Q1

**Нормативные решения:** QD-001, QD-002, SD-001, SD-003, SD-004, ADR-0008

## 1. Outcome

Measured browser failure больше не заканчивается просьбой вручную сообщить «исправлено». Loomrail сам создаёт
bounded `CorrectionRun`, передаёт Developer точный набор OPEN QADefects, требует fresh independent review нового tree
и запускает daemon-derived scoped retest с regression subset. Только passing retest текущего tree закрывает defects и
открывает Acceptance.

Q2 не ослабляет Q1 BrowserDriver boundary и не смешивает свой лимит с R1 review rounds.

## 2. Текущая ложная граница

Q1 атомарно сохраняет FAILED QARun, evidence и OPEN QADefects, но затем создаёт generic FREE_TEXT HumanRequest и
паркует ту же QA StageAttempt. Ответ лишь ставит её в очередь повторно. Между failure и повтором нет durable fix
identity, отдельного implementation tree, обязательного review, locked retest scope или bounded correction counter.

Кроме того, текущие `review_reports` и `evidence_artifacts` предполагают только один evidence cycle на PipelineRun.
После correction это неверно: новый tree обязан получить новый ReviewReport и новый QARun, сохранив старую историю.

## 3. Решения

### Q2-D1 — CorrectionRun владеет отдельным QA correction budget

`CorrectionRun` — versioned current state одного fix → review → retest цикла со статусом:

- `ACTIVE` — создан и ведёт текущий IMPLEMENT/REVIEW/QA;
- `PASSED` — scoped retest прошёл и source defects закрыты;
- `SUPERSEDED` — retest снова FAILED и атомарно создан следующий CorrectionRun;
- `EXHAUSTED` — автоматический лимит достигнут, открыт owner gate;
- `CANCELLED` — PipelineRun остановлен без pass.

Он хранит immutable `pipelineRunId`, ordinal, immediate `sourceQARunId`, locked baseline QARun, source tested tree,
source evidence и snapshot defect IDs. Одновременно ACTIVE не более одного CorrectionRun на PipelineRun.

Разрешены два автоматических correction runs. FAILED retest второго создаёт HumanRequest; HUMAN может ровно один раз
разрешить третий или отменить PipelineRun. FAILED retest третьего снова создаёт owner gate, но уже только с cancel:
четвёртого CorrectionRun не существует. Generic answer, provider output и daemon restart лимит не сбрасывают.

`QARun.ERROR` означает отсутствие product evidence и повторяется на том же QA StageAttempt после owner recovery; он
не создаёт CorrectionRun и не увеличивает ordinal.

### Q2-D2 — R1 остаётся локальным внутри каждого correction

Каждая correction начинает новые IMPLEMENT(1) → REVIEW(1). Если review просит изменения, действует неизменный R1:
IMPLEMENT/REVIEW(2), затем его HumanRequest и максимум один owner-authorized round 3.

StageAttempt получает nullable `correctionRunId`. `attempt` остаётся номером retry/review round внутри initial delivery
или одного CorrectionRun и никогда не служит QA correction counter. ReviewReport и ReviewFinding получают ту же
lineage, поэтому round 1 разных corrections не конфликтуют.

Correction IMPLEMENT context содержит bounded source defects, reproduction, source/current tree и locked plan hash.
Correction REVIEW получает fresh context, actual diff, implementation handoff и OPEN review findings своего
CorrectionRun; transcript/checkpoint прежних agents не переносится.

### Q2-D3 — QARetestPlan выводится daemon и immutable

QARetestPlan сохраняется при создании CorrectionRun. Он ссылается на полный immutable baseline plan и содержит sparse
ordered cells `{targetId, scenarioId, reasons[]}`. Scope строится только из durable data:

1. все cells с failed step/assertion immediate source QARun;
2. все cells с blocking observation immediate source QARun;
3. все cells всех OPEN QADefects PipelineRun;
4. regression: для каждого affected target — первый unaffected scenario по baseline order;
5. regression: для каждого affected scenario — первый unaffected target по baseline order;
6. если вне affected scope остались cells, но предыдущие правила не добавили regression, — первая такая cell.

Cells дедуплицируются и сохраняются в baseline matrix order; reasons имеют закрытый порядок. Максимум равен уже
bounded Q1 matrix. Если affected cells покрывают всю matrix, scoped retest честно становится полным.

Automatic correction продолжает использовать baseline scenario/step/assertion definitions, revision, content hash и
target origin. Изменение `.loomrail/browser-qa.json` не меняет evaluator уже запущенного PipelineRun; для нового plan
нужен новый PipelineRun.

### Q2-D4 — QARun явно различает full baseline и retest

Initial QARun имеет `scope = FULL` и не относится к CorrectionRun. Retest QARun имеет `scope = RETEST`, exact
`correctionRunId` и `qaRetestPlanId`. Reservation разрешена только для active correction QA StageAttempt и её locked
plan. Completion требует ровно перечисленные cells с полным набором steps/assertions каждой cell; лишняя,
пропущенная или переставленная cell отклоняется.

Driver по-прежнему не сообщает aggregate verdict. Domain выводит PASSED/FAILED/ERROR по measured results. Ошибка
environment не превращается в Defect.

### Q2-D5 — Defect lifecycle закрывается evidence, не prose

QADefect identity append-only; current disposition versioned:

```text
OPEN -> RESOLVED | WAIVED
```

`RESOLVED` ставит SYSTEM только когда QARun для CorrectionRun вернул PASSED на полном locked retest scope и в
PipelineRun нет OPEN defect вне snapshot. Resolution хранит retest QARun identity. FAILED retest не закрывает старые
defects частично: он создаёт новые OPEN defects, а следующий CorrectionRun получает snapshot всех OPEN defects. Это
консервативно сохраняет failing cells до единого доказанного pass.

`WAIVED` доступен только HUMAN с reason и expected version. Waiver исключает defect из следующего active-fix set, но
не меняет FAILED QARun, не создаёт PASSED и не пропускает review/retest. Повторное обнаружение создаёт новый Defect,
а не переоткрывает старую identity.

### Q2-D6 — Acceptance проверяет evidence lineage текущего tree

Passing review и QA artifacts больше не unique по kind на весь PipelineRun. Они append-only и unique по owning
StageAttempt/authority row. Review artifact ссылается на ReviewReport и reviewed tree; QA artifact — на QARun,
QAEvidenceBundle и tested tree.

Acceptance после correction требует:

1. current implementation tree совпадает с latest PASSED correction ReviewReport и retest QARun;
2. retest QARun относится к последнему PASSED CorrectionRun и его exact immutable QARetestPlan;
3. lineage ведёт к одному full baseline QARun того же PipelineRun;
4. все CorrectionRuns последовательны без gap/branch и последний имеет статус PASSED;
5. в PipelineRun нет OPEN QADefect;
6. daemon-owned compact artifacts ссылаются на эти exact authority rows.

Поиск произвольного «последнего PASSED» или старого initial artifact не является gate.

## 4. Transaction boundaries

`COMPLETE_QA_RUN` при measured FAILED атомарно:

1. завершает QARun/AgentRun/QA StageAttempt и пишет evidence + новые OPEN Defects;
2. блокирует stale tree, duplicate command и параллельный ACTIVE CorrectionRun;
3. при доступном лимите создаёт CorrectionRun, QARetestPlan, IMPLEMENT(1) и dispatch;
4. при исчерпанном лимите помечает текущую correction EXHAUSTED и создаёт domain-owned HumanRequest;
5. пишет events/receipt; commit предшествует invalidation.

`COMPLETE_QA_RUN` при passing RETEST атомарно:

1. проверяет exact scope, stable tree, current review и correction lineage;
2. завершает QARun, QA StageAttempt и CorrectionRun;
3. закрывает snapshot OPEN defects с retest provenance;
4. создаёт daemon-owned QA artifact и ACCEPTANCE dispatch;
5. пишет events/receipt.

Owner disposition и ответ exhausted gate — отдельные optimistic commands. Авторизация final correction создаёт exact
CorrectionRun(3), immutable retest plan и IMPLEMENT dispatch одной транзакцией; cancel терминально закрывает pipeline
и active correction.

## 5. Threat delta

Новые High-риски: compromised Developer/driver удаляет failing scenario из manifest; provider выбирает удобный retest
scope или закрывает Defect; stale evidence ошибочно прикрепляется к новому tree; restart/duplicate создаёт
параллельные corrections; вложенные review/correction loops неограниченно умножают work.

Контроли: locked baseline plan/hash; daemon-derived sparse scope; closed schemas и exact IDs; SYSTEM-only resolution;
HUMAN-only waiver/final-cycle action; stable-tree and lineage checks inside transaction; unique active correction;
2 automatic + 1 owner correction, при этом R1 отдельно остаётся 2 + 1; bounded context/text/counts; append-only events;
UI рендерит text, а не HTML/provider payload.

## 6. Acceptance criteria

1. Initial FAILED QARun автоматически создаёт CorrectionRun(1), RetestPlan и IMPLEMENT(1), не generic HumanRequest.
2. Fix → fresh review → scoped retest PASSED закрывает source defects и только затем ставит Acceptance в очередь.
3. Initial REVIEW(3) не расходует correction budget; CorrectionRun(1) начинает свой REVIEW(1).
4. Scope включает все failed/blocking/open-defect cells и детерминированный regression subset, независимо от
   изменённого provider/config output.
5. FAILED retest создаёт новые defects и следующий correction; FAILED retest второго открывает HumanRequest, а
   owner может создать только CorrectionRun(3) или cancel; failure третьего не допускает CorrectionRun(4).
6. ERROR/retry не создаёт Defect, correction или новый ordinal.
7. Stale tree, missing current review, incomplete scope, duplicate completion, waiver-only и unrelated passed QARun
   не могут открыть Acceptance.
8. Restart сохраняет exact active correction, counters, scope, defect dispositions и не дублирует dispatch.
9. Task Cockpit показывает correction timeline, affected/regression scope, current/open/resolved/waived defects и
   owner gate в RU/EN, light/dark, keyboard и 320 px.
10. Browser E2E проходит intentional fail → fix → review → scoped pass и exhausted/cancel routes.

## 7. Non-goals

- semantic deduplication QADefects между runs;
- partial auto-resolution при FAILED retest;
- provider-authored scope/evaluator или изменение locked plan внутри PipelineRun;
- visual-diff baseline approval;
- signed-in/native browser adapters и external production origins;
- параллельные CorrectionRuns одного PipelineRun;
- обход measured retest через waiver, prose или owner «force pass»;
- автоматический новый PipelineRun после изменения QA plan.
