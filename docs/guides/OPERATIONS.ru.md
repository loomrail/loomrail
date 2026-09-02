# Эксплуатация Loomrail

> Public pre-alpha · [English](OPERATIONS.md) · [Гайд владельца](USER-GUIDE.ru.md)

Это operational contract npm-launcher: проверка установки, локальная диагностика, сохранение данных, upgrade,
rollback и uninstall. Loomrail работает local-first. Эти команды не отправляют support report и не меняют provider
account.

## Поддерживаемая установка

Текущий пакет поддерживает Node.js `>=24.19 <25` на macOS и Windows. Linux остаётся best effort. Git нужен для
операций с repository/worktree; для Browser QA отдельно требуется Chromium, установленный Playwright.

Изолированная evaluation-установка:

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail setup
npx loomrail start
```

`next` явно выбирает pre-alpha channel. Для global install используйте
`npm install -g --ignore-scripts loomrail@next`, затем `npx playwright install chromium`, `loomrail setup` и
`loomrail start`. Если важна воспроизводимость, укажите exact version вместо `next`. Loomrail не требует dependency
lifecycle scripts; Chromium остаётся отдельным видимым installation step.

## Проверка происхождения package

Проверяйте exact version: moving tag `next` может измениться после review.

```bash
npm view loomrail@<exact-version> name version dist.integrity --json
npm install --ignore-scripts loomrail@<exact-version>
npm audit signatures
```

Registry integrity связывает downloaded tarball, а `npm audit signatures` проверяет registry signatures и доступные
provenance attestations установленного dependency graph. Release, заявляющий Loomrail provenance, должен ссылаться
на этот public repository, trusted publish workflow и reviewed source commit. Provenance не доказывает безопасность
кода; сохраняйте exact version, release notes и backup boundary.

Текущий published pre-alpha мог появиться до trusted-publishing policy. Будущий stable release не проходит release
gate без registry provenance. JSON рядом с локальным candidate tarball — unsigned integrity receipt, а не registry
attestation. Подробности — в [supply-chain policy](../security/SUPPLY-CHAIN.ru.md).

## Guided setup

В interactive terminal выполните `npx loomrail setup` и нажмите Enter для рекомендуемого Mock walkthrough либо
выберите проверку live provider. Automation обязана указать route явно:

```bash
npx loomrail setup --mode mock --json
```

Exit code 0 и `READY` означают, что выбранный full fixture route можно начать. Report объединяет те же read-only
наблюдения runtime/Git/data/SQLite/provider, что и `doctor`, со stat-only проверкой Chromium. Он содержит только
closed codes и ordered next actions, без paths, provider output, account, credentials или exception text.

Setup не создаёт data directory/БД, не применяет migration/recovery и не запускает daemon, browser, agent session,
provider login, installer или download. Он выполняет только документированные output-free Git/provider status probes.
Любой `LOOMRAIL_PROVIDER` override блокирует guided setup, чтобы route не расходился с фактическим startup. Pending
migration тоже блокирует путь до остановки Loomrail и сохранения всего data directory. Выполняйте показанные действия
самостоятельно: setup их не запускает и не сохраняет.

## Read-only diagnostics

Проверка для человека:

```bash
npx loomrail doctor
```

Machine-readable локальная сводка:

```bash
npx loomrail doctor --json
```

Report проверяет объявленный диапазон Node, запуск Git, доступ к data directory, SQLite integrity/migration
compatibility и installation/authentication поддерживаемых provider CLI. Он не запускает daemon или browser, не
создаёт data directory, не применяет migrations, не восстанавливает workflows и не меняет provider authentication.

`PASS` и `WARN` возвращают exit code 0. Новая установка без базы и установка только с Mock — warnings, а не failure.
`FAIL` возвращает 1: неподдерживаемый runtime, отсутствующий/незапускаемый Git, недоступное хранилище, corrupt,
drifted, future или unreadable state.

JSON построен по allowlist. В нём нет cwd, home/data/repository path, raw environment value, provider account,
command output, credential или exception message. Всё равно проверьте файл перед отправкой: наличие provider и
authentication state — metadata локальной машины.

Provider probes — bounded read-only status calls; Loomrail игнорирует output и наблюдает только exit result:

| Provider    | Проверка Loomrail    | Владелец credential |
| ----------- | -------------------- | ------------------- |
| Mock        | нет; всегда готов    | нет                 |
| Codex       | `codex login status` | Codex CLI           |
| Claude Code | `claude auth status` | Claude Code CLI     |

Loomrail не устанавливает эти CLI, не авторизуется вместо пользователя и не сохраняет их credentials. Проверенной
version compatibility matrix пока нет; после изменения любого CLI выполните `doctor` и mock walkthrough.

Точный путь локального хранилища раскрывается отдельной командой:

```bash
npx loomrail data-path
```

В отличие от `doctor`, она намеренно печатает absolute path. Не вставляйте его в публичный issue без проверки.

## Запуск и остановка

`npx loomrail start` — явная команда запуска. Прежняя форма `npx loomrail` эквивалентна. Обе поддерживают
`--no-open` и `--port N`. Перед сохранением, восстановлением, upgrade или удалением state остановите Loomrail через
`Ctrl+C` и дождитесь сообщения о завершении.

## Operational logs

Production launcher хранит отредактированную structured-диагностику в `logs/` внутри data directory. Один segment
ограничен 2 MiB, весь набор — 16 MiB; при активной записи rotation происходит не реже раза в сутки, retention — не
более 30 дней. Это не durable Event audit, не acceptance evidence и не raw output provider.

Перед management-командами остановите Loomrail. Export пишет только повторно проверенный и отредактированный NDJSON
в stdout, поэтому перенаправляйте его лишь в файл, который намерены проверить и защитить:

```bash
npx loomrail logs export > loomrail-logs.ndjson
npx loomrail logs delete
```

Export работает целиком или возвращает ошибку, не раскрывает исходные filenames и data-directory path. Delete удаляет
только принадлежащие Loomrail operational segments; неизвестные файлы в `logs/`, SQLite, migration backups, Browser
QA artifacts, repositories, workspaces, provider credentials и Git state остаются нетронутыми. Обе команды
отказываются работать, пока живой daemon владеет writer lease. Проверяйте export перед отправкой: redaction снижает
риск раскрытия, но не доказывает безопасность произвольного application text.

## Сохранение и восстановление

Data directory содержит SQLite с возможными WAL-файлами, migration safety backups, Browser QA artifacts,
отредактированные operational logs, demo repositories и managed task worktrees. Внешние repositories и provider
credentials туда не входят.

Чтобы сохранить установку:

1. Выполните `loomrail data-path` и запишите exact path.
2. Остановите Loomrail и дождитесь выхода.
3. Скопируйте или заархивируйте **весь data directory**, включая `state.sqlite-wal` и `state.sqlite-shm`, если они
   остались.
4. Отдельно сохраните каждый зарегистрированный внешний repository.
5. Сохраните важную незакоммиченную работу из показанного worktree либо самостоятельно сделайте commit.

Не копируйте только `state.sqlite` во время работы Loomrail. Файлы в `backups/` — автоматическая страховка перед
migration, а не регулярный полный backup или portable workspace export.

Для предсказуемого restore остановите Loomrail, верните весь каталог по прежнему пути, верните repositories по их
исходным путям, установите ту же Loomrail version, выполните `doctor` и только затем стартуйте. Linked Git worktree
хранят metadata с обеих сторон; перенос одного Loomrail directory не делает их portable.

## Upgrade

Изменения pre-alpha schema применяются только вперёд. Перед каждым upgrade:

1. Зафиксируйте exact установленную Loomrail version.
2. Остановите Loomrail и сохраните весь data directory.
3. Проверьте release notes, exact registry integrity и заявленный provenance target version.
4. Установите exact target version или осознанно обновите channel `next`.
5. Выполните `loomrail doctor`. До первого запуска нового совместимого build ожидаем `STATE_UPGRADE_REQUIRED`.
6. Запустите Loomrail нормально: только startup применяет migrations и recovery.
7. Пройдите mock walkthrough до работы с live provider.

Перед migration непустой DB в `backups/` может появиться автоматическая копия. Всё равно сохраняйте собственный
whole-directory pre-upgrade backup: автоматическая копия не включает repositories и остальные installation files.

## Rollback

Loomrail не обещает down-migrations. Не открывайте более старым binary state, уже мигрированный новой сборкой.
Безопасный rollback:

1. Остановите новую сборку.
2. Отдельно сохраните её текущее data directory для расследования.
3. Восстановите **pre-upgrade** whole-directory backup.
4. Установите exact Loomrail version, которая создала этот backup.
5. Выполните `doctor`, затем start.

Если подходящего pre-upgrade backup нет, сохраните новое состояние и сообщите о проблеме. Подмена отдельных SQLite
files наугад может потерять committed WAL state.

## Uninstall и локальные данные

Удаление npm package и owner data — разные действия.

1. Остановите Loomrail и сохраните нужные данные.
2. Удалите package из evaluation project своим package manager либо выполните `npm uninstall -g loomrail` для global
   installation.
3. Откройте ранее записанный path через Finder или Проводник, проверьте его и переместите именно этот Loomrail data
   directory в Корзину.

Package uninstall намеренно оставляет data directory. `loomrail logs delete` удаляет только принадлежащие продукту
log segments; recursive reset всей установки в этом release нет. Loomrail также не удаляет source repositories,
provider configuration/credentials, Git commits/branches или worktree metadata в source repositories. Перед ручной
очисткой проверяйте их отдельно.

## Retention и privacy

Durable Tasks, Events, Decisions, usage и acceptance records сохраняются, пока владелец не удалит installation data.
Browser QA screenshots/traces используют audited policy `STANDARD_30_DAYS` после перехода Task в `DONE` или
`CANCELLED`. Operational logs используют тот же 30-дневный максимум и дополнительный предел 16 MiB; raw provider
output не сохраняется. Unsafe/unknown files сохраняются, а не удаляются рекурсивно. В этом release нет
telemetry/crash upload, поддержанного online workspace export/import или retention UI.

Для product workflow продолжайте с [quick start](GETTING-STARTED.ru.md) и
[гайдом владельца](USER-GUIDE.ru.md). Packaging gates для maintainer описаны в [release guide](../RELEASE.md).
