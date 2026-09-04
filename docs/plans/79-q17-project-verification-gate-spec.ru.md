# Q17 — Project verification gate

**Дата:** 2026-09-05

**Статус:** approved product contract; implementation pending

**Основание:** QD-002, QD-003, T48 и Phase 8 Q17 в
[MASTER-PLAN.ru.md](../product/MASTER-PLAN.ru.md)

## 1. Outcome

Loomrail сам получает измеряемое evidence от owner-approved build/test/lint/integration/E2E recipes и связывает его
с точным implementation tree. Строка провайдера «тесты прошли» не создаёт `PASSED`. Если обязательная проверка
`FAILED | ERROR | INTERRUPTED | STALE`, Acceptance не открывается, а владелец видит точную проверку, статус,
длительность, platform и bounded redacted output.

Q17 реализует идеи из отдельной competitive/onboarding-сессии: автотесты становятся центральной частью Task Cockpit,
видны отдельно по типам, повторный запуск подтверждает исправление, а старое evidence автоматически помечается
`STALE`. Это не превращает Loomrail в CI-hosting и не даёт агенту новую authority.

## 2. Vocabulary и authority

- `VerificationProposal` — inert результат read-only scanner. Он может сказать, что в manifest существует script
  `test`, но не является разрешением его запустить.
- `VerificationPlan` — versioned owner-approved policy Project. Revision содержит ordered recipes и их exact
  executable/argv, cwd, timeout, output bound, environment/network policy и required flag.
- `VerificationRecipe` — одна команда типа `LINT | BUILD | UNIT | INTEGRATION | E2E | CUSTOM`, но не shell string.
- `VerificationRun` — daemon-owned попытка выполнить одну adopted Plan revision для одного WorkItem/PipelineRun и
  exact result tree.
- `VerificationCheckRun` — measured результат одной recipe внутри Run.
- `VerificationFailure` — durable typed причина correction; она не является `QADefect` и не подменяет Browser QA.
- `VerificationEvidence` — current-tree terminal summary, которую deterministic Acceptance gate может проверить.

Только authenticated owner принимает Plan revision и запускает/retries/cancels VerificationRun. Daemon резервирует
run, запускает trusted runner и выводит terminal status. Provider может предложить текст, но не принимает Plan, не
выбирает recipe, не создаёт pass и не снимает gate.

## 3. Подтверждённые test seams

QD-003 и текущий owner instruction «учитывай новые идеи и продолжай» фиксируют следующие публичные seams для TDD:

1. contract/domain seam — strict proposal/plan/run schemas и pure decisions для adoption, freshness и Acceptance;
2. scanner/publisher seam — read-only proposal из bounded manifest и marker-bound `.loomrail/verification-plan.json`;
3. persistence seam — versioned commands/queries, idempotency, transaction, restart reconciliation и append-only Events;
4. runner seam — adopted recipe + canonical workspace/tree snapshot -> closed measured result;
5. authenticated HTTP seam — preview/adopt/run/cancel/retry/read-output;
6. Task Cockpit seam — preview authority, grouped checks, current/stale status, output-on-demand и blocked Acceptance.

Тесты проверяют эти интерфейсы, а не private helper calls или произвольные SQL rows.

## 4. Proposal и безопасный scanner

Scanner читает только bounded regular files из закрытого списка: `package.json`, `pnpm-workspace.yaml`,
`pyproject.toml`, `Cargo.toml`, `go.mod` и уже принятый `.loomrail/verification-plan.json`. Первый implementation slice
предлагает только `package.json` scripts, потому что это нужно public dogfood и может быть проверено без новых parsers.

- JSON читается напрямую; scanner не запускает package manager, lifecycle hook, repository helper или executable.
- Symlink, файл вне canonical Project root, invalid JSON, unknown fields, oversized manifest или слишком много scripts
  дают closed proposal warning и ноль executable authority.
- Предлагаются только явно существующие script names из закрытого vocabulary (`lint`, `build`, `test`, `test:unit`,
  `test:integration`, `test:e2e`). `pre*`, `post*`, `install`, `prepare`, `publish`, deploy и произвольные names не
  добавляются автоматически.
- Proposal сохраняет provenance: manifest-relative path, content hash и точное script name. Script body показывается
  как untrusted bounded text, но не преобразуется в shell argv.
- Для package-manager recipe executable/argv означает, например, `pnpm` + `["run", "test"]`; script body остаётся
  внутри owner-reviewed manifest и никогда не конкатенируется Loomrail в command line.

## 5. Owner adoption и versioned file

Preview показывает для каждой recipe:

- type, label, required;
- executable и каждый argv item отдельно;
- cwd относительно Project root;
- timeout и stdout/stderr aggregate cap;
- effective environment profile;
- `INHERIT_HOST` network warning либо `DENIED_UNAVAILABLE` refusal;
- manifest provenance/hash и явное предупреждение, что repository test code выполняется с правами local user и
  worktree не является security sandbox.

Owner принимает весь exact preview одним optimistic-versioned command. Publisher записывает schema-versioned plan в
`.loomrail/verification-plan.json` только через marker-bound temp-file + atomic rename внутри canonical Project root.
Unknown existing file, symlink, path escape или changed proposal hash требует нового preview; Loomrail ничего не
перезаписывает молча.

Plan revision — монотонный integer; `contentHash` вычисляется по canonical JSON без mutable timestamps. Новая adoption
не меняет старые Run и делает их неактуальными для Acceptance. Disable — отдельная owner command с новой revision, а
не удаление истории.

## 6. Recipe contract v1

Plan v1 содержит 1..12 recipes. Limits:

- executable — basename из `pnpm | npm | yarn | bun | node`, без separator/path traversal;
- argv — 1..16 items, каждый 1..256 UTF-8 bytes, без NUL; shell metacharacters остаются обычными argv bytes;
- cwd — `.` или нормализованный relative directory под Project root, без symlink escape;
- timeout — 1..900 seconds, default 300;
- output cap — 1 KiB..256 KiB aggregate stdout+stderr, default 64 KiB;
- required — boolean; хотя бы одна recipe required;
- network policy v1 — `INHERIT_HOST` или `DENIED_UNAVAILABLE`. Вторая policy никогда не запускает child до появления
  отдельно проверенного cross-platform sandbox; UI не называет inherited network «denied».
- environment profile v1 — только `VERIFICATION_BASELINE`: minimal system path/runtime variables, isolated temporary
  HOME/cache, `CI=1`, `NO_COLOR=1`, `LOOMRAIL_VERIFICATION=1`; provider credentials, `.env` values, GitHub tokens и
  owner shell extras не наследуются.

Recipe не может содержать shell command string, inline environment assignments, stdin, package install, Git mutation,
cleanup, commit/push/merge, deploy или secret profile. Если project требует dependency setup, это отдельное owner
действие вне VerificationRun и фиксируется как prerequisite, не скрывается в recipe.

## 7. Exact tree и execution lifecycle

- Run допустим только для Project с active Plan revision и WorkItem workspace в состоянии `READY` без live writer.
- Daemon получает exclusive verification reservation, фиксирует `projectId`, `workItemId`, `pipelineRunId`, Plan
  revision/content hash, canonical worktree и exact tracked Git tree до spawn.
- Recipes выполняются последовательно в recorded order через argv + `shell:false`. V1 fail-fast: первый required
  non-pass завершает Run и не выдаёт authority следующим commands.
- Runner закрывает stdin, задаёт isolated temporary HOME/cache, принимает bounded stdout/stderr, redacts canaries и
  absolute paths, применяет deadline и убивает process tree. macOS использует detached process group; Windows —
  `taskkill /T`, затем `/F` при необходимости.
- `PASSED` возможен только при exit code 0, полном observed exit, непревышенных bounds и совпадении exact tracked tree
  после команды с tree до spawn. Изменение tracked tree даёт `ERROR / TREE_MUTATED`, даже если exit code 0.
- Non-zero exit — `FAILED`; spawn/policy/path/output/timeout/tree mutation — typed `ERROR`; owner cancellation —
  `INTERRUPTED`. Signal/exit code хранятся структурно, без parsing error strings.
- После daemon crash startup помечает durable `RUNNING` как `INTERRUPTED / DAEMON_RESTART`; неизвестный внешний
  outcome никогда не replay автоматически. Явный owner retry создаёт новый ordinal.

## 8. Output и privacy

Raw stdout/stderr не входит в Event, provider context, export или telemetry. Runner хранит только bounded redacted
excerpt с channel markers, truncation flag, byte counters и SHA-256 уже redacted bytes. DB содержит closed summary и
artifact reference; файл находится в Loomrail-owned artifact root вне repository.

Read-output endpoint требует обычную session и exact Run/check id, возвращает inert text (`text/plain` или escaped UI),
не исполняет ANSI/HTML/terminal links. UI загружает excerpt только после owner action. Expired/missing artifact не
переписывает measured status, но показывает `OUTPUT_UNAVAILABLE`.

Redaction не заявляется универсальным secret detector. Основная защита — scrubbed environment и отсутствие secret
profiles; тестовые canaries проверяют токены, env values, absolute owner path и control sequences.

## 9. State machine и persistence

Commands:

- `ADOPT_VERIFICATION_PLAN` / `DISABLE_VERIFICATION_PLAN`;
- `START_VERIFICATION_RUN`;
- internal `START_VERIFICATION_CHECK`, `COMPLETE_VERIFICATION_CHECK`, `INTERRUPT_VERIFICATION_RUN`;
- owner `CANCEL_VERIFICATION_RUN` и `RETRY_VERIFICATION_RUN`.

Allowed Run transitions:

```text
QUEUED -> RUNNING -> PASSED | FAILED | ERROR | INTERRUPTED
QUEUED -> INTERRUPTED
```

`STALE` — query/Acceptance projection, не destructive rewrite terminal history. Она возникает, если current Plan
revision/content hash или current implementation tree не совпадает с Run evidence.

Reservation, state, current check, terminal result, Event, durable follow-up и command receipt коммитятся по ADR-0002.
Duplicate command id возвращает прежний result; expected-version conflict ничего не пишет; duplicate child completion
не создаёт второй Event/correction. Migration append-only и сохраняет старые базы.

## 10. Workflow, correction и Acceptance

- После successful current-tree independent Review daemon запускает adopted required VerificationPlan до Browser QA.
- `PASSED` required recipes разрешают следующий QA gate. Optional failure виден, но не блокирует.
- Required `FAILED | ERROR | INTERRUPTED | STALE` создаёт один `VerificationFailure`, возвращает workflow в
  correction IMPLEMENT и связывает следующую independent Review с failed Run/tree.
- После fix/re-review запускается та же active exact Plan revision на новом exact tree. Proposal/provider не может
  убрать failed recipe; изменение Plan требует отдельной owner adoption и остаётся видимым в history.
- Bounds correction совпадают с ADR-0008: два automatic cycles и один final owner-authorized cycle. Verification и
  Browser QA имеют разные failure identities, но используют общий верхний correction bound, чтобы два evaluator не
  умножали число скрытых fix loops.
- AcceptancePackage выбирает только latest `PASSED` evidence active Plan revision на current implementation tree.
  Отсутствующая Plan не ломает legacy Project, но показывает `Verification not configured`; для Project с adopted
  required Plan pass обязателен.

## 11. API и Task Cockpit

Authenticated routes:

- `GET /api/v1/projects/:id/verification-plan` — active plan + inert proposal/preview;
- `POST /api/v1/projects/:id/verification-plan/adopt` — Origin/CSRF + exact preview hash + expected version;
- `POST /api/v1/work-items/:id/verification-runs` — owner start/retry;
- `POST /api/v1/verification-runs/:id/cancel` — owner cancellation;
- `GET /api/v1/work-items/:id/verification-runs` — paged summaries;
- `GET /api/v1/verification-checks/:id/output` — bounded output on demand.

Task Cockpit показывает одну секцию `Project verification`:

- active plan revision и exact tree short hash;
- ordered groups Unit / Integration / E2E / Build / Lint / Custom;
- `Queued | Running | Passed | Failed | Error | Interrupted | Stale`, counts, duration и platform text/icon;
- required/optional словами, без badge carpet и без цвета как единственного сигнала;
- `View output`, `Run checks`, `Run again`, `Cancel` только когда соответствующая command допустима;
- failed check, correction link и fresh rerun lineage;
- explicit Acceptance blocker; loading/empty/error/restart states, RU/EN, keyboard, focus, narrow/light/dark.

Settings показывает proposal/adoption отдельно от Task execution. Скрипт нельзя «выбрать» одним неочевидным checkbox:
owner видит exact argv и risk disclosure до подтверждения.

## 12. Required verification

- contracts/domain: unknown fields, bounds, duplicate ids, canonical hash, every allowed/forbidden transition,
  idempotency input and stale projection;
- scanner/publisher: malicious manifest/script body, lifecycle names, oversized input, symlink/path escape, changed hash,
  unknown existing `.loomrail` file and atomic publish recovery;
- runner: argv injection, cwd escape, scrubbed env/secret canaries, unsupported denied-network policy, stdout/stderr cap,
  ANSI/HTML, timeout, stubborn descendants, cancel, spawn failure, tree mutation and exact close;
- persistence: migration, transactional reservation/completion, duplicate completion, rollback, restart interruption,
  output reference and current-tree query;
- workflow: required failure blocks QA/Acceptance, optional failure does not, correction/re-review/fresh rerun opens the
  next gate, stale/foreign/old-plan pass rejected, bounds cannot reset on restart;
- HTTP/UI: auth/Origin/CSRF, inert preview/output, Settings adoption, Task Cockpit states, keyboard, RU/EN,
  light/dark/narrow and daemon restart;
- macOS/Windows: paths with spaces/non-ASCII, package-manager executable resolution, process-tree kill, exit/signal
  normalization and identical fixture semantics.

## 13. Exit и non-goals

Q17 закрыт, когда intentional required test failure в fixture Project создаёт durable failed evidence, не открывает
Acceptance, проходит bounded correction + fresh independent review и закрывается только fresh passing rerun той же
owner-approved recipe на current tree. Scanner до adoption ничего не запускает; crash не replay unknown execution;
fixture gate проходит macOS/Windows.

Не входят: dependency install, arbitrary shell, container/sandbox, remote CI import, secret profiles, automatic network
denial без verified sandbox, deploy, commit/push/merge, flaky-test retries, test authoring моделью, Browser QADefect
слияние, native/mobile QA и cloud artifact storage.
