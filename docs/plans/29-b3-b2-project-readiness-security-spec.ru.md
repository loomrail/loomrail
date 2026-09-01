# B3 + B2 — проверка безопасности и готовности проекта к запуску

**Статус:** implemented

**Дата:** 2026-08-30

**Зависимости:** E1, B1; нормативные решения RD-001, RD-002, AD-003, PD-007

## 1. Задача

После B5+B1 Loomrail умеет безопасно наблюдать зарегистрированный репозиторий и публиковать утверждённую
Project Constitution, но владельцу всё ещё приходится вручную собирать ответ на два разных вопроса:

1. есть ли в проекте видимые локально security-риски;
2. приняты ли обязательные перед запуском решения по legal, payments и analytics.

B3+B2 объединяет их в один проверяемый маршрут **Project → Readiness**. Кнопка `Run readiness check` создаёт
versioned снимок фактов. То, что Loomrail может доказать из ограниченного read-only наблюдения, проверяется
автоматически. То, что нельзя вывести из репозитория честно, остаётся явным owner attestation или обоснованным
`Not applicable`.

Результат не является security-аудитом, юридической консультацией или обещанием production safety. Это локальный
preflight с provenance и закрытым перечнем проверок.

## 2. Ubiquitous language

- **Project Readiness Run** — versioned снимок одного запуска readiness-проверки, привязанный к Project и
  конкретному состоянию репозитория.
- **Readiness Check** — один закрытый пункт каталога с категорией, режимом проверки, результатом и evidence.
- **Security Finding** — обнаруженный локальный факт риска с кодом, severity и безопасной ссылкой на путь.
- **Owner Attestation** — неизменяемое решение владельца `Confirmed` или `Not applicable` с обязательным rationale.

## 3. Принятые решения

### D1 — Один глубокий readiness module, два источника истины не появляются

`project-readiness` принимает repository path и наличие активной Constitution, выполняет только ограниченные
read-only наблюдения и возвращает runtime-validated draft. Домен отдельно создаёт `ProjectReadinessRun`,
`ReadinessCheck` и audit Event. SQLite остаётся operational truth; UI и Event stream — проекции.

Scanner не знает HTTP, SQLite и owner attestations. Домен не читает filesystem. Такая граница — публичный test
surface вехи.

### D2 — Снимок привязан к Git и устаревает честно

Run хранит:

- Git `HEAD` либо `null` для репозитория без commit;
- digest bounded observations;
- признак dirty working tree;
- время проверки.

Новый запуск создаёт новый Run; старые записи не переписываются и остаются audit history. `READY` означает только
«закрыты все пункты этого снимка», а не «текущее содержимое репозитория навсегда безопасно». UI всегда показывает
commit/dirty state и время запуска.

### D3 — Автоматически проверяется только доказуемое локально

Закрытый catalog B3+B2 v1:

| Key                            | Category  | Mode      | Что доказывается                                                      |
| ------------------------------ | --------- | --------- | --------------------------------------------------------------------- |
| `SECURITY_ACTIVE_CONSTITUTION` | SECURITY  | AUTOMATED | У Project есть активная явно утверждённая Constitution                |
| `SECURITY_SECRET_PATHS`        | SECURITY  | AUTOMATED | Git не отслеживает известные secret-like filenames                    |
| `SECURITY_ENV_IGNORED`         | SECURITY  | AUTOMATED | Git ignore rules покрывают `.env`, `.env.local` и `.npmrc`            |
| `SECURITY_CI_HARDENING`        | SECURITY  | AUTOMATED | Bounded CI scan не нашёл известных опасных триггеров/ссылок на action |
| `LEGAL_LICENSE`                | LEGAL     | AUTOMATED | В корне присутствует обычный LICENSE/COPYING marker                   |
| `LEGAL_OWNER_REVIEW`           | LEGAL     | OWNER     | Владелец проверил применимые legal/privacy/terms obligations          |
| `PAYMENTS_OWNER_REVIEW`        | PAYMENTS  | OWNER     | Владелец проверил payment/tax/refund obligations либо указал N/A      |
| `ANALYTICS_OWNER_REVIEW`       | ANALYTICS | OWNER     | Владелец проверил consent/retention/data obligations либо указал N/A  |

Автоматический пункт имеет `PASSED` либо `ACTION_REQUIRED`. Owner-пункт начинается с `ACTION_REQUIRED` и может
перейти только в `CONFIRMED` или `NOT_APPLICABLE`. Run имеет `READY`, только когда ни один пункт не остался
`ACTION_REQUIRED`.

### D4 — Security Finding сообщает факт, а не раскрывает секрет

Для `SECURITY_SECRET_PATHS` используются только имена tracked paths из доверенной внутренней команды
`git ls-files`; содержимое файлов не читается. Secret-like catalog включает `.env*` кроме example/template/sample,
`.npmrc`, private-key filenames и common credential files. Evidence хранит относительный path, code и безопасное
описание, но никогда value или file content.

Ignore coverage проверяет Git semantics на синтетических корневых путях. CI scan читает только bounded
`.github/workflows/*.yml|yaml`, не следует symlink, не превышает 32 файла, 256 KiB на файл и 1 MiB суммарно. V1
фиксирует как findings:

- `pull_request_target` workflow;
- `permissions: write-all`;
- GitHub Action ref, не закреплённый полным commit SHA.

Это эвристические локальные findings, не доказательство отсутствия других уязвимостей.

### D5 — Trusted internal Git не равен repository-discovered command

Модуль может вызвать только закрытые argv, определённые Loomrail: `rev-parse`, `status`, `ls-files` и
`check-ignore`. Shell не используется. Ни `package.json` scripts, ни текст README/AGENTS/CLAUDE/workflow, ни
provider output не становятся командой. Сеть, package manager, hooks и source build/test не запускаются.

### D6 — Owner attestation — versioned command, а не checkbox в браузере

`ATTEST_PROJECT_READINESS_CHECK` принимает run/check, expected run version, outcome и rationale. Домен разрешает
команду только для owner check последнего Run этого Project, отклоняет stale version, automated check, пустой
rationale и повтор результата. В одной SQLite transaction сохраняются immutable attestation, новая projection
check/run, Event и command receipt.

Attestation не передаёт секреты и не заменяет внешнюю юридическую, платёжную или privacy проверку. A4 позднее может
проецировать незакрытые owner checks в Attention Inbox; B2 не расширяет WorkItem-scoped HumanRequest искусственно.

### D7 — Ошибка наблюдения fail-closed

Недоступный/non-top-level repository, Git failure, symlink workflow, превышение bound или unreadable security input
не превращаются в `PASSED`. Repository-level failure даёт typed HTTP error без Run. Ограниченный конкретный input
даёт `ACTION_REQUIRED` с безопасным finding, чтобы владелец видел, что пункт не был проверен.

## 4. Контракты и HTTP

- `GET /api/v1/projects/:projectId/readiness` — latest Run, checks и attestations либо `null`;
- `POST /api/v1/projects/:projectId/readiness/run` — owner mutation с `commandId` и expected Project version;
- `POST /api/v1/projects/:projectId/readiness/attest` — owner mutation с run/check/outcome/rationale и optimistic
  version.

Mutation routes используют существующие session/Origin/CSRF/content-type gates. Repository path всегда берётся из
Project state, не из request body. Responses проходят Zod. Повтор одного command id возвращает тот же receipt.

## 5. Persistence и audit

Migration 0016 добавляет:

- `project_readiness_runs`;
- `project_readiness_checks`;
- `project_readiness_findings`;
- `project_readiness_attestations`.

Один Project может иметь много Run, но latest определяется детерминированно по `created_at, id`. Check catalog
закрыт CHECK constraints. Finding и attestation append-only. Run/check projection меняется только доменной
командой. Event types: `PROJECT_READINESS_ASSESSED` и `PROJECT_READINESS_ATTESTED`.

## 6. UI

Settings → Projects получает отдельный раздел **Readiness** рядом с Constitution:

- `Run readiness check` и честное состояние empty/running/error;
- aggregate `Ready` или `Action required` текстом и icon, не одним цветом;
- checked time, short HEAD и dirty/clean label;
- четыре категории и восемь фиксированных checks;
- раскрываемое evidence без raw JSON и file contents;
- для owner checks — `Confirm` / `Not applicable`, rationale и явная отправка;
- пояснение границ: local preflight, не полный audit/legal advice.

Клавиатура, visible focus, narrow dialog, EN/RU, light/dark входят в первый implementation. Ленд и публичный
marketing route в эту веху не входят и не меняются.

## 7. Security delta

Новая угроза T25: malicious repository пытается использовать one-action check для исполнения команд, чтения
секретов, symlink escape, resource exhaustion или ложного `READY`. Controls: closed internal argv, no shell/hooks,
path-only tracked-secret scan, allowlist/bounds/symlink refusal, fail-closed outcomes, runtime schemas, owner-only
attestations, optimistic versions, authenticated mutations и audit Events. Critical/High verification входит в
эту веху.

## 8. Non-goals

- запуск project build/test/lint/package scripts;
- SAST, dependency CVE scan, secret-value scan или network lookup;
- проверка remote branch protection, hosting, DNS, payment dashboard или privacy vendor console;
- автоматические legal conclusions и готовые Terms/Privacy documents;
- provider-generated checklist items или редактируемый catalog;
- A4 Attention Inbox integration, notifications и remote scheduling;
- исправление найденных проблем одним кликом;
- любые изменения лендинга, package release или Git commit/push.

## 9. Acceptance

B3+B2 завершены, когда:

1. clean fixture и fixtures с tracked secret path, missing ignore, risky CI, symlink/oversize получают
   детерминированные разные результаты без чтения secret values;
2. никакой repository-discovered command не запускается, hooks выключены для внутренних Git reads;
3. Run/Check/Finding contracts strict; command transitions, idempotency и stale version покрыты;
4. Run + checks + findings + Event + receipt и attestation + projections + Event + receipt атомарны;
5. latest snapshot и все attestations переживают restart, старые Run остаются доступны для audit через Events;
6. HTTP закрывает auth, Origin, CSRF, project mismatch и unavailable repository;
7. UI проходит empty/action-required/ready/error, EN/RU, keyboard, light/dark и narrow review;
8. threat model, domain context и decomposition checkpoint обновлены;
9. `pnpm verify`, production audit и relevant E2E зелёные.

## 10. Результат реализации

Контур B3+B2 реализован 2026-08-31 без изменений `apps/landing`:

- закрытый catalog из восьми checks проходит через contracts → scanner → domain → SQLite → daemon → web;
- assessment и owner attestation сохраняются командами с receipts, optimistic versions и audit Events;
- scanner использует только bounded internal Git argv, не исполняет repository scripts, не читает secret values и
  fail-closed обрабатывает symlink/непроверяемый CI input;
- Project Settings показывает aggregate state, evidence и owner decisions на EN/RU, в light/dark и на узком экране;
- T25 и доменный словарь обновлены, а основной UI-сценарий закреплён Playwright E2E.

Readiness-owned lint, typecheck и suites зелёные; production audit не нашёл известных уязвимостей. Общий
`pnpm verify` на момент закрытия readiness-работы доходит до ESLint и останавливается на одном файле последнего
отдельного landing-коммита (`apps/landing/src/main.test.ts`). Лендинг принадлежит сессии Claude и намеренно не
изменялся в рамках B3+B2; repo-wide gate следует повторить после исправления в его контуре.
