# Q14 — macOS live-provider compatibility rows

**Дата:** 2026-09-04

**Статус:** active

**Предшественники:** Q9, Q13

**Нормативные решения:** AD-004, AD-005, SD-001, SD-003, T16–T18, T26, T43

## 1. Outcome

Loomrail получает первые quota-bearing live-provider rows для установленных Codex и Claude Code на macOS arm64,
не заявляя совместимость тех же версий на Windows или другой архитектуре. Provider admission становится функцией
exact `(provider, version, platform, architecture)` target, а не только version.

После reviewed real-CLI capture соответствующий macOS target может стать `VERIFIED`; Windows остаётся
`UNVERIFIED` до отдельного совпадающего evidence run. Это platform-scoped продолжение Q9, а не ослабление exact
allowlist и не stable-release gate.

## 2. Module boundary

`@loomrail/provider-core` владеет deterministic exact-target matching. Provider adapter передаёт immutable rows и
не решает readiness. Daemon registry по-прежнему объединяет compatibility с executable presence и provider-owned
authentication; workflow не получает authority над install/login/update.

Строка допуска содержит:

- exact normalized SemVer;
- Node platform (`darwin` для этого slice);
- architecture (`arm64` для этого slice).

Install kind и invocation-contract revision остаются reviewable evidence metadata: Loomrail не может надёжно
установить provenance произвольного executable только по PATH и поэтому не изображает runtime attestation.

## 3. Evidence boundary

Promotion каждого provider требует:

1. exact version/auth probes на macOS arm64;
2. sanitized real-CLI success и controlled-failure streams;
3. для Codex — реальный workspace-write run;
4. для обоих providers — exact session-scoped MCP configuration path;
5. replay текущим parser, negative corpus и independent final-result schema validation;
6. зафиксированные model mapping и adapter invocation revision;
7. отсутствие credentials, personal paths, raw private transcripts и runtime state в Git.

Capture использует только public synthetic prompt/repository и минимальный достаточный budget. Failure capture не
должен специально тратить model quota, если provider может детерминированно отказать до inference.

## 4. Acceptance criteria

1. Exact recorded version имеет `VERIFIED` только на `darwin/arm64`; та же version на `win32`, `linux` или другой
   architecture остаётся `UNVERIFIED`.
2. Auth probe по-прежнему запускается только после platform-scoped `VERIFIED`.
3. Обе реальные CLI возвращают schema-valid terminal result через exact adapter argv и проходят replay.
4. Codex действительно изменяет throwaway worktree; Claude Code остаётся read-only в пустой temporary directory.
5. MCP capture доказывает только session-scoped invocation/config boundary; никакой user config не наследуется.
6. Public EN/RU matrix и T43 evidence явно отделяют macOS admission от pending Windows evidence.
7. Focused tests, public-tree checks и repository verification проходят, кроме уже известного protected
   `apps/landing/**` lint blocker, который этот slice не меняет и не исключает.
8. Slice не меняет `apps/landing/**`, не публикует package/release и не принимает owner-only workflow decisions.

## 5. Non-goals

- Windows live-provider promotion;
- semver ranges, `latest` или auto-promotion;
- binary provenance attestation;
- provider installation, update, downgrade или login;
- stable release claim;
- изменение provider session semantics вне обнаруженной compatibility correction.

## 6. Dogfood correction: run cost policy

Первый managed запуск обнаружил, что Task Cockpit не передаёт hard budget и logical model tier: daemon использует
демонстрационный лимит `100`, а новый AgentRun всегда наследует role default. В результате narrow public dogfood
стартовал на `STANDARD` и после реально измеренного usage предложил практически бесполезный override `used + 100`.

Q14 закрывает дефект до продолжения quota-bearing workflow:

- стартовый экран явно показывает и валидирует hard token budget и logical tier;
- новый `BudgetPolicy` сохраняет nullable model-tier override, оставляя `null` совместимым значением «role default»;
- owner budget override создаёт новую policy revision и может задать tier для только будущих AgentRun; уже сохранённые
  immutable snapshots не переписываются;
- effective tier нового AgentRun вычисляется детерминированно как policy override либо role default и сохраняется в
  существующем policy snapshot;
- Task Cockpit называет control «Model» и показывает exact model IDs из того же validated adapter mapping, который
  использует daemon; в `Auto` один tier честно показывает обе возможные provider-модели;
- daemon фиксирует resolved exact model ID в immutable AgentRun snapshot до запуска CLI, а adapter исполняет этот ID,
  не перечитывая изменившийся mapping; прежний snapshot без model ID использует совместимый fallback;
- budget override UI принимает осмысленный лимит больше прежнего и cumulative usage вместо вычисленного `used + 100`;
- тот же versioned cost policy может задать явный ceiling одного будущего AgentRun; owner может повысить именно его,
  не увеличивая уже достаточный pipeline cap;
- прежние command receipts/events и базы продолжают читаться как `modelTierOverride = null`;
- restart/recovery доказывает сохранение policy revision до возобновления dogfood.

Второй live Discovery run подтвердил необходимость этого разделения: при cumulative usage `284250` из pipeline cap
`700000` новый FAST AgentRun остановился на role envelope `80000` после фактического расхода `134231`. Повторное
увеличение pipeline cap не меняет этот envelope и создаёт quota loop. Рекомендуемый start preview поэтому показывает
два независимых лимита; regression test требует, чтобы повышение per-AgentRun ceiling было валидной новой revision
при неизменном, ещё не исчерпанном pipeline cap.

## 7. Dogfood correction: terminal usage and outcome atomicity

Три Implementation попытки показали более опасный quota loop: поддерживаемые adapters сообщают один cumulative usage
у терминальной границы, но daemon сначала применял `RECORD_PROVIDER_USAGE`. Пересечение AgentRun ceiling переводило
текущий StageAttempt в `HARD_PAUSED`, запускало abort и делало уже полученный schema-valid outcome неприменимым.
Следующий Budget Override повторял весь Implementation; измеренный расход вырос с `489257` до `617930`, затем до
`810317`, не продвигая workflow.

До следующего quota-bearing запуска обязательна следующая семантика:

- callback usage только валидируется и удерживается до возврата terminal outcome;
- ProviderSession end, ProviderUsageReport/UsageRecord, stage outcome, AgentRun finish и lease release фиксируются
  одной командой и одной SQLite transaction;
- cap crossing не меняет завершённый текущий этап обратно в pause: он остаётся `SUCCEEDED` с result tree;
- если outcome создаёт продолжение, новый StageAttempt сразу хранится `HARD_PAUSED`, а его dispatch — `FAILED`, поэтому
  worker не может начать следующий provider;
- Budget Override возобновляет этот никогда не стартовавший attempt с тем же id/номером; реальный начатый attempt,
  остановленный budget, по-прежнему получает новый retry;
- command replay, restart read, forbidden actor и no-pending-dispatch проверяются integration tests.
