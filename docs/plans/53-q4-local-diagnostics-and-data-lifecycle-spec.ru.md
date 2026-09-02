# Q4 — Local diagnostics и data lifecycle contract

**Дата:** 2026-09-02

**Статус:** approved for implementation

**Предшественники:** D1, A2, Q3

**Нормативные решения:** local-first, provider-owned credentials, migration backup is not export, T05, T09, T40

## 1. Outcome

Установленный launcher получает безопасные команды `loomrail doctor`, `loomrail doctor --json` и
`loomrail data-path`. Владелец может до запуска daemon проверить совместимость Node, наличие Git, доступность data
directory, целостность и migration compatibility существующей SQLite state, а также installation/authentication
состояние поддерживаемых provider CLI.

Диагностика read-only: она не создаёт каталог или SQLite-файл, не выполняет migrations/recovery, не запускает daemon
или браузер, не меняет provider authentication и не печатает account, credential, repository или абсолютные пути.
Точный data directory раскрывает только отдельная явно запрошенная команда `data-path`.

Одновременно EN/RU operations guide фиксирует install check, upgrade/rollback, backup/restore, uninstall и retention
границы первой public alpha без обещания portable workspace import или автоматического удаления внешних данных.

## 2. Текущий разрыв

Launcher умеет только запускать daemon. Ошибка Node, Git, permissions, SQLite integrity/migration drift или provider
authentication проявляется в разных местах и часто только после частичного startup. Документация описывает backup,
но не собирает upgrade, rollback и uninstall в один проверяемый operational contract. Это блокирует Phase 8 clean
machine gate и делает support-отчёт либо неполным, либо склонным раскрывать локальные пути.

## 3. Командный контракт

Launcher принимает закрытое discriminated множество:

- `loomrail` и legacy `loomrail --no-open [--port N]` — прежний start;
- `loomrail start [--no-open] [--port N]` — явный start;
- `loomrail doctor [--json]` — read-only диагностика;
- `loomrail data-path` — печать одного exact resolved data directory;
- `loomrail help`, `loomrail --help`, `loomrail -h` — bounded usage без startup.

Флаги одной команды не принимаются другой; unknown command/flag и лишний positional аргумент завершаются до любых
side effects. `doctor` возвращает exit code 0 для `PASS` и `WARN`, 1 для `FAIL`. Это позволяет новой установке без
созданной state DB или live-provider login пройти диагностический запуск с явными warnings, но не маскирует
неподдерживаемый runtime, отсутствующий Git, недоступный data path или неисправную DB.

## 4. Diagnostic report

`DoctorReport` имеет `schemaVersion: 1`, общий `PASS | WARN | FAIL` и фиксированный порядок checks:

1. Node runtime: поддержан только объявленный repository/release диапазон Node 24.19+ <25;
2. Git executable: bounded `git --version` через argv без shell и с минимальным launch environment, stdout/stderr не
   сохраняются;
3. data directory: `READY`, `NOT_CREATED` или `UNAVAILABLE`, плюс только `DEFAULT | ENVIRONMENT_OVERRIDE`;
4. state database: `MISSING`, `UNINITIALIZED`, `READY`, `UPGRADE_REQUIRED`, `CORRUPT`, `MIGRATION_DRIFT`,
   `INCOMPATIBLE` или `UNAVAILABLE`;
5. provider availability: `MOCK`, `CODEX`, `CLAUDE_CODE` с уже существующими closed fields installed,
   authentication, ready и supported stages.

`--json` печатает один стабильный JSON object без timestamp, cwd, home, data path, repository path, raw command output,
exception message, environment map, provider account/profile или credentials. Human format использует те же codes и
bounded product-authored hints. Provider status probe переиспользует official read-only status commands и их
минимальный allowlisted environment; output остаётся проигнорированным.

Общий status вычисляется детерминированно из check severity, а не из текста. Отсутствующая DB и недоступный live
provider — `WARN`: Mock и первый запуск остаются рабочими. Invalid provider environment override также `WARN` и
виден только как boolean/code, без повторения raw value.

## 5. SQLite read-only inspection

Только `packages/persistence-sqlite` открывает `state.sqlite` через `node:sqlite`, с `readOnly: true` и без WAL pragma,
migration или recovery writes. Inspector:

- сначала различает отсутствующий path, regular file и unavailable path; valid SQLite с чужими tables, но без
  Loomrail migration ledger, считается `INCOMPATIBLE`, а не пустой базой;
- выполняет `PRAGMA quick_check` и принимает только единственную строку `ok`;
- читает только version/name/checksum из `schema_migrations`;
- сравнивает строки с current immutable migration sources;
- помечает missing current tail как `UPGRADE_REQUIRED`, altered checksum/name как `MIGRATION_DRIFT`, unknown future
  version как `INCOMPATIBLE`;
- закрывает connection на всех путях и возвращает closed typed result вместо raw SQLite error.

`doctor` никогда не заменяет normal startup: migration и startup reconciliation выполняются только `start` после
того, как владелец решил запустить продукт. Проверка live WAL-consistent read разрешена SQLite; если DB недоступна,
diagnostic fail-closed не советует копировать один основной файл.

## 6. Data lifecycle contract

Operations guide является нормативной инструкцией первой alpha:

- `data-path` показывает, какой каталог нужно сохранить или удалить;
- backup выполняется только после остановки Loomrail и охватывает весь data directory плюс отдельно user repositories;
- automatic `backups/` — migration safety, не регулярный backup и не portable export;
- upgrade сначала требует backup, затем exact pre-alpha version и `doctor`; normal start может применить forward
  migrations;
- rollback приложения не обещает down-migration: сначала останавливается более новая версия, затем одновременно
  восстанавливаются прежняя exact версия и pre-upgrade backup;
- uninstall package не удаляет state автоматически; очистка data directory — отдельное явное действие владельца
  после backup и проверки displayed path;
- source repositories, provider credentials/config и Git worktree metadata не удаляются Loomrail uninstall;
- browser QA files с `STANDARD_30_DAYS` сохраняют существующую audited cleanup policy, а durable state/events/decisions
  живут до явного удаления всей локальной installation data; telemetry/crash upload отсутствуют.

Инструкция не добавляет delete command: рекурсивное удаление path через launcher требует отдельного exact-confirmation
design и не нужно для диагностического slice.

## 7. Threat delta

Новые риски: support JSON раскрывает username/path/account; status command наследует secrets или shell semantics;
doctor повреждает/migrates production DB; hostile `LOOMRAIL_DATA_DIR` заставляет диагностику создать или удалить
путь; rollback/uninstall docs ведут к потере WAL, repository или newer-schema state.

Контроли: allowlisted typed report; no raw paths/output/errors/env; argv + no shell + bounded deadline; provider-owned
credentials; read-only SQLite inspector; no mkdir/migration/recovery/browser/daemon; exact `data-path` вынесен в
отдельную owner-invoked command; whole-directory stopped backup; no down-migration claim; uninstall and data removal
separated; no recursive product cleanup.

## 8. Acceptance criteria

1. Legacy start syntax и explicit `start` эквивалентны; help/doctor/data-path не создают bootstrap token и не
   запускают daemon/browser.
2. Parser отклоняет unknown/mixed flags и invalid port до side effects на macOS и Windows.
3. `doctor --json` имеет stable closed schema/order, общий deterministic status и не содержит path, username,
   environment override value, raw provider/Git/SQLite output или exception text.
4. Missing data directory/DB и unauthenticated providers дают `WARN`/exit 0; invalid runtime, Git/data failure,
   corrupt/drift/future/unreadable DB дают `FAIL`/exit 1.
5. Existing current DB проходит `quick_check` и current migration ledger без writes; missing tail, altered checksum и
   future migration получают разные codes.
6. Provider snapshot совпадает с Settings availability contract и использует существующие bounded auth probes.
7. EN/RU guide даёт проверяемые команды install/doctor/start, stopped whole-directory backup, upgrade/rollback и
   separate uninstall/data removal; не обещает portable restore или deletion внешних данных.
8. Clean-install tarball выполняет `loomrail doctor --json`, `loomrail data-path` и прежний readiness smoke на macOS
   и Windows.

## 9. Non-goals

- setup wizard UI, desktop installer или provider login automation;
- online backup/export/import, archive generation или cloud sync;
- delete/reset/repair/migrate command;
- чтение repository contents, Git status/worktrees или project state для support bundle;
- сбор/отправка telemetry, crash dump или diagnostics;
- version-specific provider support claims без отдельной compatibility-evidence matrix;
- npm publish, tag или release promotion.
