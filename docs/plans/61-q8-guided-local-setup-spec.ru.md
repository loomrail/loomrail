# Q8 — Guided local setup

**Дата:** 2026-09-02

**Статус:** implemented; local and clean macOS/Windows setup evidence complete

**Предшественники:** Q4, Q5, Q6, Q7

**Нормативные решения:** PD-003, PD-009, UXD-005, SD-003, T26, T40, T42

## 1. Outcome

Установленный launcher получает `loomrail setup`: короткий terminal wizard, который выбирает безопасный Mock или
live-provider маршрут, проверяет все prerequisites первого полного fixture flow и выдаёт точные следующие действия.
Для automation тот же контракт доступен как `loomrail setup --mode mock|live --json`.

Setup ничего не устанавливает и не сохраняет. Он переиспользует только Q4 read-only Git/provider status probes, но
не создаёт data directory/SQLite, не применяет migrations/recovery, не открывает browser, не запускает daemon, agent
session, provider login или package manager, не меняет Provider Preference и не принимает secrets. Тем самым команда
остаётся проверяемым preflight, а каждое действие с authority сохраняет существующую явную owner boundary.

## 2. Термины и authority

**Setup Route** — краткоживущий выбор `MOCK | LIVE`, определяющий только preflight gates и инструкции текущего CLI
вызова. Это не Project Provider Preference, не environment override и не разрешение на provider process/quota.

**Setup Readiness Report** — closed local projection, может ли выбранный Setup Route начать документированный full
fixture flow. Он выводится из Doctor Report, наличия Chromium и route-specific provider readiness; не является
installation receipt, durable state или обещанием совместимости будущей версии CLI.

Doctor Report остаётся единственным подробным diagnostic contract. Setup повторно не реализует runtime/Git/SQLite/
provider probes, а сворачивает его typed result в три bounded checks.

## 3. Command contract

Launcher принимает:

- `loomrail setup` — interactive human format; требует TTY и предлагает `Mock walkthrough` как безопасный default;
- `loomrail setup --mode mock|live` — non-interactive human format;
- `loomrail setup --mode mock|live --json` — deterministic machine-readable report;
- `--json` без explicit mode, unknown mode/flag и extra positional input отклоняются до probes.

Interactive input принимает только пустую строку/`1`/`mock` либо `2`/`live`, без free text, credentials или account
data. Empty input выбирает Mock. Non-TTY invocation без `--mode` fail closed с bounded instruction.

Exit code `0` означает `READY`, включая безопасные warnings новой установки; `1` означает `BLOCKED` или invalid
invocation.

## 4. Readiness contract

`SetupReadinessReport` schema v1 содержит только:

- `status: READY | BLOCKED`;
- выбранный `route: MOCK | LIVE`;
- `system`, `browser` и `route` checks с `PASS | WARN | FAIL` и closed product-authored codes;
- ordered `nextActions` из closed enum.

Он не содержит timestamp, cwd/home/data/browser executable path, environment value, provider account/profile,
command output, exception text или credentials.

`system` переиспользует Doctor Report:

- любой doctor `FAIL` блокирует setup;
- `STATE_UPGRADE_REQUIRED` отдельно блокирует запуск до stopped whole-directory backup;
- новая/отсутствующая state и отсутствие live provider остаются warning для Mock route;
- setup никогда не вызывает normal startup, чтобы «исправить» warning.

`browser` делает только local filesystem observation exact executable path, который сообщает installed Playwright
runtime. Chromium не запускается и path не выводится. Missing/unreadable/non-regular executable блокирует полный
fixture route и предлагает owner-run `npx playwright install chromium`.

`route`:

- любой `LOOMRAIL_PROVIDER` override должен быть снят перед guided setup: иначе transient route может расходиться с
  фактическим startup provider и Project Settings остаётся locked;
- Mock route не требует provider login и заканчивается инструкцией выбрать Mock в Settings до workflow start;
- Live route требует хотя бы один observed installed+authenticated live provider и заканчивается инструкцией явно
  выбрать его в Settings;
- setup не сохраняет выбор и не запускает login flow.

## 5. Next actions

Blocked report перечисляет только необходимые remediation actions в стабильном порядке:

1. `RUN_DOCTOR` для system failure;
2. `BACK_UP_DATA` для pending migration;
3. `INSTALL_CHROMIUM` для browser prerequisite;
4. `CLEAR_PROVIDER_OVERRIDE` для environment override;
5. `SIGN_IN_PROVIDER` для Live route без ready provider.

Ready report всегда выдаёт `RUN_START`, `INITIALIZE_DEMO_WORKSPACE` и затем `SELECT_MOCK` либо
`SELECT_LIVE_PROVIDER`. Эти actions — инструкции владельцу, не исполняемые commands.

## 6. Security delta

T42: setup может создать ложное впечатление, что установил dependency, выбрал provider или безопасно мигрировал
state; interactive prompt также может стать каналом для secret/path и raw error disclosure.

Контроли: zero-write/zero-launch semantics; exact closed choice; TTY gate; reuse T40 probes; stat-only browser
observation; no raw paths/output/errors; explicit non-persistence; no login/install/migration automation; deterministic
JSON и negative canaries.

## 7. Acceptance criteria

1. Parser и interactive selector принимают только documented matrix и default Mock.
2. Setup не создаёт data directory/SQLite/logs и не запускает daemon, browser, agent session, provider login или
   package manager; разрешены только существующие bounded read-only status probes.
3. Missing state/live login остаются READY для Mock; doctor failure, pending migration и missing Chromium блокируют.
4. Live route блокируется без ready live provider; любой environment override блокирует оба guided routes.
5. Human/JSON output детерминирован, bounded и не содержит path/env/account/raw error canaries.
6. Help и EN/RU quick start/operations объясняют, что setup только проверяет и направляет.
7. Clean tarball на macOS/Windows выполняет packaged setup после explicit Chromium installation, затем прежний
   doctor/start/log lifecycle smoke.
8. Q8 не меняет `apps/landing/**` и не публикует npm package.

Acceptance подтверждён локально и в clean macOS/Windows jobs
[CI run 33680374866](https://github.com/loomrail/loomrail/actions/runs/33680374866): CLI 33/33, explicit Chromium
installation, packaged setup/receipt/files/log lifecycle, consumer audit и browser smoke прошли на обеих платформах.
Оба source Verify прошли fault gate и остановились только на трёх protected landing lint diagnostics.

## 8. Non-goals

- dependency install/download, `npx` execution или browser launch;
- provider login, credential storage или account discovery за пределами existing output-free auth-status outcome;
- durable Provider Preference, Project creation или demo initialization;
- data-directory/SQLite creation, migration, repair, reset, import/export или deletion;
- desktop/graphical installer;
- provider version compatibility claims;
- telemetry/crash upload;
- npm publish, tag или dist-tag promotion.
