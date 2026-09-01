# B4 — Scaffolding нового Project

**Дата:** 2026-09-01
**Статус:** approved implementation boundary
**Зависимости:** E1, B5+B1, B3+B2, PD-007, PD-013, T34

## 1. Результат

Владелец выбирает встроенный versioned recipe, видит точный preview нового локального repository и одним
подтверждением создаёт ранее не существовавший каталог. Loomrail восстанавливает прерванную публикацию после restart,
проверяет получившийся Git repository и регистрирует его как Project. Лендинг, удалённые templates и установка
dependencies не входят в B4.

## 2. Нормативная граница

### В B4

- один встроенный recipe `typescript-node` с фиксированным набором обычных файлов;
- read-only Scaffold Proposal: canonical target, recipe id/version, список relative paths, byte size, sha256 и
  canonical proposal digest;
- explicit owner confirmation точного digest;
- durable Scaffold Operation до первой filesystem mutation;
- exclusive claim ранее не существовавшего target и только create-new writes;
- repository-local marker `.loomrail/scaffold.json` с operation id, recipe version и proposal digest;
- `git init` с argv без shell, owner hooks/template/signing disabled;
- restart reconciliation и idempotent completion;
- регистрация результата как Project, RU/EN UI и точные отказные состояния.

### Не в B4

- GitHub/GitLab remote, repository visibility, commit, push или PR;
- `npm install`, `pnpm install`, `npx`, `npm create`, postinstall/hook или запуск generated code;
- URL, archive, local arbitrary template, marketplace или recipe plugin;
- secrets, `.env`, cloud account, deployment, billing setup или production credentials;
- выбор framework из маркетингового каталога или скрытая телеметрия;
- overwrite/merge в существующий каталог, автоматический rollback через recursive delete;
- изменение или использование `apps/landing`.

## 3. Первый Recipe

`typescript-node@1` создаёт небольшой Node ESM project:

```text
.gitignore
.loomrail/scaffold.json       # operation-bound marker, добавляется publisher
README.md
package.json
src/index.ts
test/index.test.ts
tsconfig.json
```

Recipe не содержит binary files, symlink, executable bit или абсолютный path. Relative paths canonical,
slash-separated, уникальны, не пусты, не содержат `.`/`..`, drive prefix или NUL. Content — UTF-8 с LF, каждый файл
и весь proposal bounded. `package.json` не содержит lifecycle scripts. Dependencies не устанавливаются; README
показывает последующий явный `pnpm install` и `pnpm test` как действия владельца.

## 4. Proposal

Запрос принимает `recipeId` и абсолютный `targetPath`. Daemon:

1. trim/нормализует input и требует, чтобы target отсутствовал;
2. canonicalizes существующий parent через `realpath`;
3. запрещает filesystem root, target внутри существующего Git repository и имя вне bounded portable subset;
4. рендерит recipe только из basename target; пользовательский текст не становится path, script или instruction;
5. возвращает точный manifest файлов и digest, но ничего не пишет.

Digest строится из schema version, canonical target, recipe id/version и canonical file records. Publish request
передаёт тот же input и `expectedProposalDigest`; daemon повторно строит proposal и fail-closed отказывает при drift.
Proposal не является durable permission.

## 5. Durable state и переходы

```text
PROPOSED (projection only)
  └─ owner confirms exact digest
       └─ PENDING
            ├─ COMPLETED (Project active)
            └─ FAILED
                  └─ explicit retry → PENDING
```

`PROVISIONING` Project, `PENDING` Scaffold Operation и audit Event создаются одной SQLite transaction до filesystem mutation;
сама pending Operation является durable follow-up для startup reconciliation.
Status versioned; command idempotency и expected-version conflict обязательны. Filesystem worker не меняет workflow
state напрямую. После проверки repository отдельная domain command атомарно активирует Project, закрывает Operation и
пишет Event.

`FAILED` хранит только закрытый error code и безопасную рекомендацию; raw Git stderr, file content и personal path не
попадают в Event. Retry — новая versioned попытка той же Operation, не новый бесконтрольный generator.

## 6. Filesystem publication

Portable directory `rename-no-replace` в Node отсутствует, поэтому B4 не обещает недоступную атомарность каталога.
Worker использует другой fail-closed protocol:

1. `mkdir(target, { recursive: false, mode: 0o700 })` эксклюзивно захватывает несуществующий target;
2. первым файлом через create-new write публикует marker точной Operation;
3. создаёт только заранее перечисленные directories и files; каждый file открывается с `wx`;
4. проверяет, что в target нет путей вне точного recipe/marker, и выполняет `git init` через argv в очищенном от
   ambient `GIT_*` окружении с отключёнными user/system config, template, hooks и prompt;
5. проверяет Git top-level, точную форму дерева, marker и все file digests;
6. атомарно переводит Operation в `COMPLETED`, а заранее зарегистрированный `PROVISIONING` Project — в `ACTIVE`.

При restart существующий target допустим только если regular-file marker полностью совпадает с operation id и
proposal digest. Тогда worker проверяет уже созданные files и дописывает только отсутствующие recipe files через
`wx`. Любой существующий файл с другим digest, неожиданный path, symlink, special file или неизвестный marker
переводит Operation в `FAILED` без удаления. Loomrail никогда автоматически не удаляет target целиком.

## 7. API и UI

- `POST /api/v1/scaffolds/propose` — authenticated read-only proposal; no CSRF exemption assumptions;
- `POST /api/v1/scaffolds/publish` — Origin/session/CSRF mutation with command id and expected digest;
- `GET /api/v1/scaffolds` — незавершённые операции для recovery UI;
- `GET /api/v1/scaffolds/:operationId` — current status;
- `POST /api/v1/scaffolds/:operationId/retry` — явный versioned retry только failed Operation;
- recipe catalog может быть статической частью proposal response, пока recipe один.

Settings показывает отдельные действия **Create new project** и **Register existing repository**. Create flow требует
target path, показывает recipe/version, exact files, отсутствие install/commit/push и кнопку, содержащую понятный
результат действия. После `COMPLETED` новый Project выбирается, а UI предлагает owner-run install/readiness как
следующий шаг. Keyboard focus, visible focus, errors, light/dark и RU/EN входят в acceptance.

## 8. Security acceptance

- target race никогда не приводит к overwrite;
- parent/root/nested-repository/symlink/file conflicts fail closed;
- recipe не может объявить lifecycle scripts или path traversal;
- restart после каждого filesystem step приводит к exact resume либо safe failure;
- mismatched marker/file не удаляется и не исправляется;
- duplicate publish command создаёт не более одного Operation/Project;
- no shell, downloader, package manager, ambient Git repository/config/template, hook, commit, push или remote;
- logs/telemetry/error response не содержат generated content, raw stderr или target path; target хранится только в
  локальном структурированном Project/Operation/Event, где он нужен для recovery и аудита.

## 9. Release acceptance

- pure recipe/proposal tests на macOS и Windows fixtures с spaces/non-ASCII;
- filesystem integration tests для crash/restart/conflicts/symlinks;
- SQLite idempotency/version/recovery tests;
- HTTP auth/Origin/CSRF/body bounds tests;
- RU/EN keyboard light/dark browser flow;
- `pnpm verify`, production audit и clean tarball smoke green;
- source diff под `apps/landing` отсутствует.
