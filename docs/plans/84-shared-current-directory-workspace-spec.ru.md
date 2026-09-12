# Shared current-directory workspace — спецификация

**Дата:** 2026-09-06

**Статус:** implemented and verified by accepted private Recurkit dogfood on macOS

**Основание:** AD-007, AD-008, `MASTER-PLAN.ru.md` §11.2 и §22

## 1. Outcome

Project, чья repository policy запрещает linked worktree, может явно выбрать работу в зарегистрированной текущей
папке. Loomrail не создаёт branch/worktree, но сохраняет точную исходную Git-базу, не смешивает старые правки
владельца с изменениями WorkItem и атомарно допускает не более одного Loomrail writer или verifier на весь Project.

Изолированный worktree остаётся default. Режим текущей папки не является sandbox и не блокирует внешний IDE,
терминал или другой процесс владельца; это ограничение показывается до opt-in и в Task Cockpit.

## 2. Ubiquitous language

- **Workspace Strategy** — versioned Project-настройка `ISOLATED_WORKTREE | SHARED_CURRENT_DIRECTORY`. Она влияет
  только на создание новых WorkItemWorkspace.
- **Shared Current Directory** — зарегистрированный Git top-level Project, который сам является рабочей папкой
  WorkItemWorkspace. Loomrail не создаёт для него branch или linked worktree.
- **Shared Writer Authority** — project-scoped exclusive claim. Его держит один writing StageAttempt либо один
  VerificationRun; read-only provider stages claim не берут.
- **Carry-in Baseline** — внутренний Git commit object, созданный через временный index без изменения index,
  working tree, branch или refs владельца. Diff WorkItem вычисляется относительно него.

## 3. Решения

### D1 — Стратегия принадлежит Project, фактический режим — WorkItemWorkspace

Project хранит durable выбор отдельно от Project row. Отсутствие записи означает `ISOLATED_WORKTREE`; это сохраняет
совместимость существующих баз. Смена Project-настройки увеличивает Project version и записывает Event. Уже
созданный WorkItemWorkspace сохраняет свою strategy навсегда, поэтому изменение настройки не переносит и не
переинтерпретирует текущую работу.

### D2 — Shared workspace использует существующий Git top-level

Preflight остаётся тем же: canonical path обязан совпадать с Git top-level, а merge/rebase/cherry-pick/bisect
отказываются до запуска. `worktreePath` у shared workspace равен зарегистрированному top-level, `branch` равен
текущей именованной ветке, `baseCommit` — текущему HEAD. Detached HEAD отказывается: без имени ветки Cockpit и
аудит не могут честно назвать, где живёт результат.

### D3 — Старые изменения становятся неизменяемой базой

До первого provider session Loomrail строит Carry-in Baseline существующим временным-index механизмом. Он не
пишет настоящий index, working tree, refs, stash и не создаёт checkout. `snapshotCommit ?? baseCommit` остаётся
единственной diff-базой. Список carried paths записывается в `WORK_ITEM_WORKSPACE_CREATED` и показывается владельцу.

Loomrail не обещает физически запретить agent process менять carried path: same-user process имеет права владельца.
Если внешний процесс или агент изменил такой путь, это видно в diff относительно baseline и требует review. Перед
dogfood дополнительно проверяется побайтовая неизменность исходного набора изменений.

### D4 — Один project-scoped writer/verifier

Для `SHARED_CURRENT_DIRECTORY` одновременно может существовать только один ненулевой `leaseHolder` или
`verificationHolder` среди всех WorkItemWorkspace одного Project. Проверка и claim выполняются одним SQLite
statement; partial unique index является storage backstop. Read-only DISCOVERY, PLAN, REVIEW и provider-часть QA
получают папку без writer claim. IMPLEMENT получает writer lease. VerificationRun получает тот же exclusive class
authority, потому что owner-approved build/test/lint может менять generated files.

Изолированные worktree сохраняют прежнюю per-workspace lease семантику и могут исполняться параллельно.

### D5 — Никаких скрытых Git side effects

Shared provisioning не вызывает `git worktree add`, не создаёт и не удаляет ветку, не checkout'ит, не commit'ит в
историю и не push'ит. Ошибка записи durable workspace не вызывает Git cleanup: создан только unreferenced internal
commit object, который безопасно останется для обычного Git GC.

### D6 — Recovery различает стратегии

Startup reconciliation проверяет shared workspace как canonical registered repository, а не как linked-worktree
ветку. Исчезнувший/перемещённый top-level становится ORPHANED тем же append-only transition. Мёртвый writer или
verifier освобождает project-scoped authority только после существующих process-identity проверок; автоматический
resume запрещён AD-008.

### D7 — Opt-in должен быть понятен до клика

Project Settings показывает две стратегии, безопасный default и отдельное подтверждение перед включением shared
mode. Текст прямо говорит: агенты пишут в текущую папку; Loomrail сериализует только свои writing/verification
запуски; внешние процессы не блокируются; untracked и локальные файлы доступны процессу по обычным правам ОС;
существующие WorkItem сохраняют прежний режим.

Task Cockpit показывает `Mode`, а для shared — `Working directory`, не `Worktree`. Состояние и предупреждение не
кодируются только цветом; control работает с клавиатуры и в light/dark themes.

## 4. Public seams

1. `GET/PUT /api/v1/projects/:projectId/workspace-strategy` — authenticated, mutation защищена Origin/session/CSRF
   и optimistic Project version.
2. `CREATE_WORK_ITEM_WORKSPACE` записывает strategy вместе с фактической папкой и baseline; lease/verification
   commands обеспечивают project-scoped exclusivity.
3. Project Settings и Task Cockpit показывают настройку и фактический режим соответственно.

## 5. Forbidden states

- shared включён неявно или через environment/provider output;
- shared workspace указывает не на canonical Project Git top-level;
- два shared WorkItem одного Project одновременно имеют writer/verification authority;
- detached HEAD принят как именованная рабочая ветка;
- смена Project strategy задним числом меняет уже созданный workspace;
- Cockpit называет shared directory «worktree»;
- ошибка provisioning удаляет или восстанавливает пользовательские файлы;
- WebSocket считается источником стратегии или lease.

## 6. Verification

- contracts/domain: закрытый словарь, CAS, inactive Project, unchanged strategy;
- persistence: default without row, idempotent receipt, restart, version conflict, migration of existing rows;
- concurrency: writer↔writer, writer↔verification и verification↔verification conflicts across two WorkItems;
- isolated workspaces remain independent;
- workspace integration: dirty tracked/untracked/non-ASCII/path-with-spaces repository, no new refs/worktrees/index
  changes, exact baseline diff;
- daemon: shared preparation never calls worktree mutation helpers; read-only stage gets the folder without claim;
- HTTP: auth, Origin, CSRF, bounds and stale version;
- UI/E2E: explicit confirmation, keyboard, EN/RU, light/dark, Cockpit labels and warning;
- private dogfood: exact before/after repository observation and mid-workflow daemon restart.
