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
- budget override UI принимает осмысленный лимит больше прежнего и cumulative usage вместо вычисленного `used + 100`;
- прежние command receipts/events и базы продолжают читаться как `modelTierOverride = null`;
- restart/recovery доказывает сохранение policy revision до возобновления dogfood.
