# Q20 — Безопасное provider-neutral выполнение workspace tools: спецификация

**Статус:** implemented; accepted private Recurkit Epic complete on macOS; Windows live evidence pending

## Цель

Разрешить локальным Codex CLI и Claude Code CLI реально выполнять IMPLEMENT и provider-authored часть QA, не
передавая provider output полномочия произвольного shell/filesystem и не ослабляя daemon-owned workflow, budget,
Review, measured Browser QA и owner Acceptance.

Архитектурное решение: [ADR-0014](../adr/0014-provider-neutral-workspace-executor.md).

## Контракт

Provider adapter переводит свой native tool call в единственный neutral executor contract. Доступны только:

1. `LIST_DIRECTORY(path)` — bounded names/types без secret paths;
2. `READ_FILE(path, offsetBytes, limitBytes)` — bounded UTF-8 fragment и SHA-256;
3. `WRITE_FILE(path, expectedSha256|null, content)` — IMPLEMENT-only CAS write;
4. `EDIT_FILE(path, expectedSha256, oldText, newText)` — IMPLEMENT-only atomic CAS replacement of one uniquely
   matching bounded UTF-8 fragment;
5. `DELETE_FILE(path, expectedSha256)` — IMPLEMENT-only non-recursive CAS delete;
6. `RUN_RECIPE(recipeId)` — exact active owner-approved Verification Plan recipe.

Любой другой operation/field отвергается runtime schema до I/O. Native call ID не сохраняется: idempotency key — его
session-bound SHA-256. File content и command output возвращаются только текущему provider turn, после redaction и
ограничения размера; в SQLite/Event остаются только digests, размеры, exit/status и typed code.

## Invariants

- executor существует только для RUNNING ProviderSession/AgentRun и leased `READY` WorkItem workspace;
- workspace root и каждый existing path component canonical; symlink, traversal, absolute/UNC/drive path,
  non-regular file и secret/meta path запрещены;
- QA — `READ_ONLY`, IMPLEMENT — `READ_WRITE`; отсутствие явного write authority не имеет default;
- command принимает только recipe ID, а executable/argv/cwd/env/network/time/output берёт из immutable Plan;
- disabled/changed Plan и `DENIED_UNAVAILABLE` network policy fail closed;
- no shell, arbitrary argv/env, recursive delete, `.git`, commit/push/merge/deploy/install authority;
- per-session не более 64 tool calls и 32 provider turns; file/request/output и process deadline имеют hard caps;
- cancellation проверяется до reserve, до I/O/process spawn и после него; child tree получает hard stop;
- provider session и StageAttempt не могут завершиться, пока все принятые gateway tool calls не получили terminal
  outcome; закрытие lease сначала запрещает новые calls, затем дожидается уже начатых direct calls;
- STARTED и terminal tool state + append-only Event фиксируются transactionally; provider call reuse с другим input
  запрещён;
- startup сначала доказывает stop command process, затем переводит незавершённый call в `UNKNOWN_OUTCOME`; replay
  side effect отсутствует;
- usage локальной CLI-сессии одним отчётом входит в AgentRun ledger; следующий dispatch блокируется при исчерпанном
  immutable remainder, а текущая сессия честно имеет `POST_SESSION`, не ложный hard token cap;
- live IMPLEMENT не завершается по одному provider JSON: domain требует успешный audited
  `WRITE_FILE`/`EDIT_FILE`/`DELETE_FILE`
  той же ProviderSession/StageAttempt, иначе даёт `IMPLEMENT_EFFECT_NOT_OBSERVED` и hard pause;
- untrusted file/process/provider text не интерпретируется как HTML, команда, путь или workflow decision.
- provider видит явное neutral объяснение, что native read-only sandbox относится только к scratch, а repository
  доступен через `loomrail_workspace`; renderer fail closed до spawn, если connector/tool allowlist не соответствует
  immutable access, и не раскрывает path/branch/capability;
- read-only MCP discovery не публикует write/delete tools; `READ_WRITE` публикует их только как closed shapes,
  остающиеся subject to executor validation.

## QA authority

Daemon-owned BrowserDriver и Project Verification выполняются первыми. Failed/error measurement использует текущий
correction/HumanRequest flow. Только PASSED measurement оставляет StageAttempt RUNNING для read-only provider
synthesis; domain принимает provider `QA_REPORT` только вместе с exact QARun/evidence/current tree. Provider prose не
может создать passing measured evidence.

## Acceptance

- [x] оба adapters объявляют IMPLEMENT/QA и выполняют multi-turn tool protocol без native payload вне adapter;
- [x] allowed list/read/write/delete/recipe проходят; traversal, symlink escape, secrets, QA writes, stale CAS,
      unknown recipe и unavailable network запрещены typed result/error;
- [x] paths с пробелами и Unicode проходят на macOS/Linux и моделируемой Windows path policy;
- [x] timeout, cancellation, output cap, POST_SESSION ledger и loop guard проверены;
- [x] audit reserve/finish idempotent; mismatch/refire запрещены; restart даёт UNKNOWN_OUTCOME без replay;
- [x] secret values, `.env`, API keys, raw provider payload/file/command output отсутствуют в state/events/logs;
- [x] UI различает approval-needed/blocked, provider/tool failure и running/succeeded audit state без color-only;
- [x] integration/E2E показывают real file diff, measured QA binding и recovery с test-only transports/doubles;
- [ ] normal provider exit и forced context handoff не оставляют in-flight recipe после завершения ProviderSession
      или StageAttempt и не передают workspace следующей session/Review/QA до terminal tool outcome;
- [x] production private-workflow выявил и закрыл mismatch между native scratch и provider-visible workspace
      authority; оба adapters используют общий renderer, а read-only discovery не показывает write tools;
- [x] финальный `pnpm verify`, 60/60 product E2E, 7/7 landing E2E и clean-install release-package gate прошли
      после последних live-runtime уточнений.

Owner-approved focused subscription dogfood на macOS arm64 прошёл для Codex CLI `0.153.4` и Claude Code `2.1.260`:
оба runtime выполнили реальные bounded IMPLEMENT read/write и QA read-only calls через Loomrail proxy/executor в
workspace с пробелами/Unicode. Позднее один private Recurkit WorkItem прошёл полный workflow и был принят владельцем;
формальный private Epic с durable dependency edge и тремя принятыми WorkItem завершён на macOS; реальный Windows host остаётся отдельным pending gate
Master Plan.

## Не входит

Полноценный OS/container sandbox, arbitrary shell, dynamic command approval из model output, secret injection,
network host sandbox, Git mutation, commit/push/merge/deploy, live quota spend и automatic retry unknown outcomes.
