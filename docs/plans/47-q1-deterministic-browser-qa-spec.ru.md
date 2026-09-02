# Q1 — Deterministic Browser QA evidence baseline

**Дата:** 2026-09-02

**Статус:** approved implementation baseline

**Предшественники:** E1, E1.5, A2, A3, R1

**Нормативные решения:** QD-001, QD-002, SD-001, SD-003, SD-004, BD-003

## 1. Outcome

Стадия QA больше не проходит по тексту provider «всё работает». Loomrail запускает обязательный
deterministic Playwright baseline над точным implementation tree, сохраняет bounded шаги, assertions,
console/network observations и attachment metadata, и только measured `PASSED` может стать QA evidence
для Acceptance Package.

Q1 закрывает evidence baseline и fail-closed остановку. Автоматический defect -> correction run ->
scoped retest остаётся Q2: его нельзя добавить как ещё один `StageAttempt.attempt`, не сломав
bounded R1 review rounds.

## 2. Текущая ложная граница

Сейчас provider возвращает один `QA_REPORT` с title, summary и checks. Domain без измерений помечает
его `PASSED`, после чего Acceptance считает QA выполненным. Отчёт не фиксирует tested tree,
target origin, browser/runtime, viewport, locale/theme, scenario results, console/network failures, screenshots и
trace. Такой артефакт — typed provider claim, а не Browser QA evidence из QD-002.

## 3. Решения

### Q1-D1 — QARun является authority для QA verdict

`QARun` — durable запуск одного BrowserDriver для одного QA StageAttempt и exact tested tree. Его status:

- `RUNNING` — reservation и environment snapshot записаны до запуска browser process;
- `PASSED` — все required scenarios и assertions прошли, blocking observations/defects нет;
- `FAILED` — есть measured failed assertion, blocking console/network observation или defect;
- `ERROR` — baseline не смог доказать pass: target unhealthy, browser/driver crashed, origin не разрешён или
  evidence невалидно.

Provider narrative может дополнить QA, но не может создать `PASSED` или подменить driver result.

### Q1-D2 — Evidence привязано к tree и environment

До navigation QARun фиксирует:

1. latest successful IMPLEMENT result tree, уже прошедший R1;
2. loopback target origin и health result;
3. driver/browser name и version;
4. OS/runtime fingerprint без secrets и абсолютных путей;
5. ordered viewport, locale и theme matrix;
6. deterministic scenario manifest revision/content hash.

Завершение сравнивает tested tree с текущим stable tree. Mismatch даёт stale refusal и не создаёт
действующее QA evidence.

### Q1-D3 — PlaywrightDriver — обязательный isolated baseline

Первый driver — `PLAYWRIGHT`. Он получает только validated plan, isolated browser context и allowlisted
loopback origin. QA read-only: driver не получает shell/Git authority, provider credentials, signed-in Chrome profile и
произвольные external origins. Redirect вне allowlist, download, dialog и destructive/account/payment action
останавливают run fail-closed.

Codex/Claude browser capabilities и signed-in Chrome остаются будущими adapters. Они не заменяют
Playwright baseline.

### Q1-D4 — Bounded normalized evidence, heavy artifacts вне SQLite

SQLite хранит structured metadata:

- ordered scenarios, steps и assertions;
- viewport/locale/theme для каждого result;
- bounded console observations и failed/slow network observations;
- attachment refs с daemon-owned id, kind, content hash, byte size, retention class и relative storage key;
- durable QA Defects с reproduction и lifecycle.

Screenshot/trace файлы живут в Loomrail data directory, не в repository и не в SQLite. Абсолютный path
не попадает в API/event. Для unpinned evidence применяется SD-004: 30 дней после закрытия work.

### Q1-D5 — Failure не маскируется acceptance artifact

`FAILED` атомарно пишет QARun, evidence и OPEN Defects, переводит run в `WAITING_HUMAN` и не
создаёт `QA_REPORT`. `ERROR` делает то же без изобретения product defect, если ошибка принадлежит
environment/driver. Owner может повторить baseline или отменить run; provider prose не может advance в Acceptance.

Q2 добавит correction-run identity, scoped retest/regression subset и bounded automatic defect loop, не переиспользуя R1
review-round counter.

### Q1-D6 — Acceptance читает measured bundle

`QA_REPORT` для успешного QARun создаёт daemon из normalized evidence. Он ссылается на QARun,
tested tree и evidence bundle; provider не выбирает status. Acceptance отклоняет legacy/provider-only
`QA_REPORT`, stale tree, failed/error run и bundle без required scenario matrix.

## 4. Transaction boundary

Одно `COMPLETE_QA_RUN`:

1. проверяет command id/version, active BROWSER_QA AgentRun, QARun status, driver identity, target origin и stable tree;
2. завершает QARun и AgentRun;
3. пишет evidence bundle, observations, attachment metadata и Defects;
4. при `PASSED` создаёт daemon-owned QA evidence и следующий ACCEPTANCE dispatch;
5. при `FAILED|ERROR` создаёт HumanRequest без acceptance evidence;
6. пишет append-only events и command receipt;
7. commit; только затем SSE invalidation.

Attachment files сначала пишутся в quarantine temp directory и проверяются. Transaction сохраняет только
metadata; atomic rename в final evidence directory делается до commit с recovery marker, чтобы restart мог
довершить или quarantine orphan, но не выдать несуществующий file за evidence.

## 5. Acceptance criteria

1. Intentional deterministic browser failure создаёт durable `FAILED` QARun и OPEN Defect; Acceptance не стартует.
2. Green baseline даёт `PASSED`, daemon-owned `QA_REPORT` и только затем Acceptance.
3. QARun и evidence ссылаются на exact implementation tree; stale completion отклоняется.
4. Driver не может navigation вне allowlisted loopback origin и не получает provider/shell/Git/secrets authority.
5. Scenario/step/assertion/observation/attachment/defect counts и text bounded и runtime-validated.
6. Screenshot/trace API не раскрывает absolute path; hash/size mismatch отклоняется.
7. Restart сохраняет run/evidence/defects и не дублирует ACCEPTANCE dispatch или HumanRequest.
8. Task Cockpit показывает measured state, target matrix, scenarios, observations, attachments и Defects без raw JSON.
9. RU/EN, light/dark, keyboard, 320 px, reconnect и stale/conflict покрыты browser QA Loomrail UI.
10. macOS/Windows CI запускает один и тот же deterministic fixture baseline.

## 6. Non-goals

- automatic defect correction/retest loop (Q2);
- provider-native Codex/Claude browser adapters;
- signed-in Chrome/profile reuse;
- arbitrary external origins, production/payment/account/security actions;
- visual-diff approval и baseline authoring UI;
- launching an arbitrary user dev command without a separately approved trusted launch recipe;
- native/mobile/desktop QA;
- raw browser logs как primary Task Cockpit.
