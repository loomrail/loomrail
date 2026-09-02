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
npm install loomrail@next
npx playwright install chromium
npx loomrail doctor
npx loomrail start
```

`next` явно выбирает pre-alpha channel. Для global install используйте `npm install -g loomrail@next`, затем
`npx playwright install chromium`, `loomrail doctor` и `loomrail start`. Если важна воспроизводимость, укажите exact
version вместо `next`.

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

## Сохранение и восстановление

Data directory содержит SQLite с возможными WAL-файлами, migration safety backups, Browser QA artifacts,
demo repositories и managed task worktrees. Внешние repositories и provider credentials туда не входят.

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
3. Установите exact target version или осознанно обновите channel `next`.
4. Выполните `loomrail doctor`. До первого запуска нового совместимого build ожидаем `STATE_UPGRADE_REQUIRED`.
5. Запустите Loomrail нормально: только startup применяет migrations и recovery.
6. Пройдите mock walkthrough до работы с live provider.

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

Package uninstall намеренно оставляет data directory. В этом release нет recursive delete/reset command. Loomrail
также не удаляет source repositories, provider configuration/credentials, Git commits/branches или worktree metadata
в source repositories. Перед ручной очисткой проверяйте их отдельно.

## Retention и privacy

Durable Tasks, Events, Decisions, usage и acceptance records сохраняются, пока владелец не удалит installation data.
Browser QA screenshots/traces используют audited policy `STANDARD_30_DAYS` после перехода Task в `DONE` или
`CANCELLED`; unsafe/unknown files сохраняются, а не удаляются рекурсивно. В этом release нет telemetry/crash upload,
поддержанного online workspace export/import или retention UI.

Для product workflow продолжайте с [quick start](GETTING-STARTED.ru.md) и
[гайдом владельца](USER-GUIDE.ru.md). Packaging gates для maintainer описаны в [release guide](../RELEASE.md).
