# E1 — Рабочая область: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНАЯ ПОД-СКИЛЛ: `superpowers:subagent-driven-development`.
> Шаги помечены чекбоксами (`- [ ]`).

**Цель:** живой агент правит код в настоящем Git-worktree, отрезанном от репозитория владельца, и
стадии IMPLEMENT и QA перестают отклоняться.

**Архитектура:** новый пакет `packages/workspace` — единственное место в дереве, которое запускает
`git`. Он чистый: принимает пути, возвращает данные, ничего не знает про Loomrail. Над ним —
долговечная сущность `WorkItemWorkspace` в SQLite, решения в `packages/domain`, оркестрация в
демоне, и передача пути в адаптер через `ProviderInvocation`.

**Технологии:** TypeScript strict, pnpm workspaces, Zod 4, Vitest, `node:child_process`,
`node:sqlite` (только в `packages/persistence-sqlite`), Playwright.

**Спека:** [13-e1-workspace-execution-spec.ru.md](13-e1-workspace-execution-spec.ru.md) — читать
вместе с планом. План аргументирует из спеки; при расхождении спека главнее.

## Глобальные ограничения

- TypeScript strict. Zod 4 на каждой границе, `.strict()` несущий.
- Новых зависимостей времени исполнения не добавлять. `git` запускается как процесс, без обёрток.
- `node:sqlite` импортирует только `packages/persistence-sqlite`.
- Применённую миграцию не редактировать — добавлять новую. Текущая последняя — 0010.
- Реальную базу владельца (`~/Library/Application Support/Loomrail/state.sqlite`) не трогать. Для
  проверок — копия через backup API, никогда не `cp` (WAL теряется).
- **Каждый тест обязан уметь покраснеть от дефекта, который он называет.** Сломать реализацию,
  убедиться в красноте **утверждением** (не таймаутом, не падением в подготовке, не необработанным
  отклонением промиса), вернуть. Мутация и текст утверждения — в отчёт.
- Тесты идут против настоящих Git-репозиториев, создаваемых в temp-каталоге, и против записанных
  потоков настоящего CLI. Выдуманная фикстура, утверждающая предположение, — это дефект: так
  родился Critical этапа A2.
- Никаких декоративных функций: за каждым контролом реальное поведение.
- `--dangerously-*` не появляется ни на одном пути (SD-001). Через `-c` разрешён ровно один ключ —
  `sandbox_workspace_write.network_access`.
- Гейт между задачами — `pnpm verify` **целиком**, плюс `pnpm build`. Не подмножество: этап A2
  трижды отгружал красноту, потому что проверялось подмножество.
- Коммитить файлы поимённо. Никогда `git add .`, `git add -A`, `git add <каталог>`. Не пушить.
- Node 24.19.0 (`.nvmrc`). `codex` при этом установлен под Node 22 — см. Задачу 1.

## Структура файлов

**Создаётся:**

- `packages/workspace/src/git.ts` — запуск `git` как процесса: аргументы массивом, без оболочки;
  код выхода, stdout, stderr.
- `packages/workspace/src/repository.ts` — осмотр репозитория: это ли репозиторий, HEAD,
  незавершённая операция, корень.
- `packages/workspace/src/snapshot.ts` — снимок незакоммиченного через временный индекс.
- `packages/workspace/src/worktree.ts` — создание, перечисление, удаление worktree; занятость ветки.
- `packages/workspace/src/index.ts` — публичный API пакета.
- `packages/contracts/src/workspace.ts` — `workItemWorkspaceSchema`, события, команды.
- `packages/domain/src/workspace.ts` — чистые решения: имя ветки, отказы.
- `packages/persistence-sqlite/migrations/0011_work_item_workspaces.sql` — таблица рабочих областей.

**Изменяется:** `packages/provider-codex/src/index.ts`, `packages/provider-core/src/index.ts`,
`packages/persistence-sqlite/src/index.ts`, `packages/domain/src/workflow.ts`,
`apps/daemon/src/session-loop.ts`, `apps/daemon/src/server.ts`, `apps/daemon/src/fixtures.ts`,
`apps/web/src/views/WorkbenchPage.tsx`, `apps/web/src/i18n.tsx`, `docs/security/THREAT-MODEL.md`,
`README.md`.

---

## Задача 1: Codex перестаёт наследовать личный конфиг владельца

Закрывает существующее ослабление (спека §2.1, D7). Не зависит ни от чего в этом этапе и идёт
первой именно поэтому.

**Файлы:**

- Изменить: `packages/provider-codex/src/index.ts` (сборка `args`)
- Тест: `packages/provider-codex/test/adapter.unit.test.ts`

**Интерфейсы:** ничего не производит для следующих задач.

- [ ] **Шаг 1: тест, который краснеет от отсутствия флага**

Тест поднимает адаптер на подставном CLI и утверждает над **массивом** аргументов, не над склеенной
строкой (склеенная строка содержит текст промпта и даёт ложные совпадения):

```ts
it("does not let the owner's own codex config decide what the agent may do", async () => {
  const spawned = await runAdapterAgainstRecording("hello.jsonl");
  expect(spawned.args).toContain("--ignore-user-config");
});
```

- [ ] **Шаг 2: прогнать, убедиться в красноте**

`pnpm --filter @loomrail/provider-codex test` → FAIL с `expected [ 'exec', '--json', … ] to include
'--ignore-user-config'`.

- [ ] **Шаг 3: добавить флаг**

В массив `args` сразу после `"--json"`. Рядом — комментарий, объясняющий, что именно наследовалось
без него: `approval_policy`, `sandbox_mode`, hooks, plugins, model providers и **MCP-серверы**, при
том что решение D6 этапа A2 запрещает MCP. Аутентификация живёт в `CODEX_HOME` и флагом не задета.

- [ ] **Шаг 4: тест на то, что запрет MCP теперь обеспечен**

```ts
it("cannot pick up an MCP server from the machine it runs on", async () => {
  const spawned = await runAdapterAgainstRecording("hello.jsonl");
  expect(spawned.args).toContain("--ignore-user-config");
  expect(spawned.args.filter((arg) => arg === "-c" || arg === "--config")).toHaveLength(0);
});
```

- [ ] **Шаг 5: `pnpm verify` и `pnpm build` от корня, затем коммит**

```bash
git add packages/provider-codex/src/index.ts packages/provider-codex/test/adapter.unit.test.ts
git commit -m "fix(provider-codex): stop inheriting whatever the machine's codex config says"
```

---

## Задача 2: запуск `git` как процесса

**Файлы:**

- Создать: `packages/workspace/package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `src/git.ts`, `src/index.ts`
- Тест: `packages/workspace/test/git.integration.test.ts`

Скопировать `package.json`, оба `tsconfig` и `vitest.config.ts` с `packages/ui` (он получил их
последним и потому актуален); имя пакета — `@loomrail/workspace`, зависимостей времени исполнения нет.

**Интерфейсы — производит:**

```ts
export type GitResult = { stdout: string; stderr: string; exitCode: number };
export type GitOptions = { cwd: string; env?: Readonly<Record<string, string>> };
export const runGit = (args: readonly string[], options: GitOptions): Promise<GitResult>;
export class GitMissingError extends Error {}
```

`runGit` **не бросает** на ненулевой код выхода: код возврата — это данные, и все вызывающие
разбирают его сами (спека §2.11: разные коды означают разные причины). Бросает только
`GitMissingError`, когда самого `git` нет.

- [ ] **Шаг 1: тест на то, что код выхода возвращается, а не бросается**

```ts
it("hands a failing git command back as a result, not as a throw", async () => {
  const repo = await makeThrowawayRepo();
  const result = await runGit(["rev-parse", "--verify", "refs/heads/nope"], { cwd: repo });
  expect(result.exitCode).toBe(128);
  expect(result.stdout).toBe("");
});
```

`makeThrowawayRepo` — хелпер в `test/helpers.ts`: `mkdtemp`, `git init`, `git -c user.email=… -c
user.name=… commit --allow-empty`. Имя и почта задаются флагами `-c`, а не глобальной конфигурацией
машины, иначе тест зависит от настроек того, кто его запускает.

- [ ] **Шаг 2: прогнать, убедиться в красноте** — `Cannot find module './git.js'`. Это красное по
      импорту, а не по утверждению, и потому не считается доказанным; доказательство даёт Шаг 5.

- [ ] **Шаг 3: реализовать через `spawn`**

Массив аргументов, `shell: false`, stdin закрыт. stdout и stderr собираются целиком.

- [ ] **Шаг 4: тест на отсутствующий `git`**

```ts
it("says git is missing rather than failing as if the command did", async () => {
  await expect(runGit(["--version"], { cwd: repo, env: { PATH: "/nonexistent" } })).rejects.toBeInstanceOf(
    GitMissingError,
  );
});
```

- [ ] **Шаг 5: мутация**

Заменить `exitCode` на константу `0` в реализации → тест Шага 1 краснеет утверждением
`expected 0 to be 128`. Вернуть. Записать в отчёт.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/package.json packages/workspace/tsconfig.json packages/workspace/tsconfig.build.json packages/workspace/vitest.config.ts packages/workspace/src/git.ts packages/workspace/src/index.ts packages/workspace/test/git.integration.test.ts packages/workspace/test/helpers.ts pnpm-lock.yaml
git commit -m "feat(workspace): run git as a process and hand its exit code back"
```

---

## Задача 3: осмотр репозитория до того, как что-то создавать

Спека D5 и §2.12: посреди rebase `worktree add` **успешен** и уводит агента на служебный коммит.
Значит осмотр — не украшение, а условие корректности.

**Файлы:**

- Создать: `packages/workspace/src/repository.ts`
- Изменить: `packages/workspace/src/index.ts` (реэкспорт)
- Тест: `packages/workspace/test/repository.integration.test.ts`

**Интерфейсы — потребляет:** `runGit`, `GitResult`.
**Производит:**

```ts
export type InProgressOperation = "REBASE" | "MERGE" | "CHERRY_PICK" | "BISECT";
export type RepositoryState = {
  topLevel: string;
  headCommit: string | null; // null — в репозитории нет ни одного коммита
  inProgress: InProgressOperation | null;
};
export const inspectRepository = (path: string): Promise<RepositoryState | null>; // null — не репозиторий
```

- [ ] **Шаг 1: тест на обычный репозиторий**

```ts
it("reports the commit a fresh worktree would be cut from", async () => {
  const repo = await makeThrowawayRepo();
  const state = await inspectRepository(repo);
  expect(state?.headCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(state?.inProgress).toBeNull();
});
```

- [ ] **Шаг 2: тест на пустой репозиторий**

```ts
it("says a repository with no commits has no head, rather than failing", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loomrail-empty-"));
  await runGit(["init"], { cwd: repo });
  const state = await inspectRepository(repo);
  expect(state).not.toBeNull();
  expect(state?.headCommit).toBeNull();
});
```

- [ ] **Шаг 3: тест на середину rebase — тот, ради которого задача существует**

Хелпер `makeRepoMidRebase` в `test/helpers.ts`: два коммита, расходящиеся правки одного файла,
`git rebase` до конфликта (ожидается ненулевой код выхода — это часть подготовки, а не ошибка).

```ts
it("refuses to call a rebase's scratch commit a base", async () => {
  const repo = await makeRepoMidRebase();
  const state = await inspectRepository(repo);
  expect(state?.inProgress).toBe("REBASE");
});
```

- [ ] **Шаг 4: реализация**

Не репозиторий → `null` (`rev-parse --show-toplevel` с ненулевым кодом). `headCommit` —
`rev-parse HEAD`, ненулевой код в пустом репозитории даёт `null`. Незавершённая операция
определяется наличием каталогов и файлов в `--git-dir`: `rebase-merge`/`rebase-apply` → `REBASE`,
`MERGE_HEAD` → `MERGE`, `CHERRY_PICK_HEAD` → `CHERRY_PICK`, `BISECT_LOG` → `BISECT`. Путь берётся
из `rev-parse --git-dir`, а не склеивается как `<repo>/.git`: внутри linked worktree это другой
каталог (спека §2.10).

- [ ] **Шаг 5: мутация**

Убрать ветку `rebase-merge` → тест Шага 3 краснеет `expected null to be 'REBASE'`. Вернуть.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/src/repository.ts packages/workspace/src/index.ts packages/workspace/test/repository.integration.test.ts packages/workspace/test/helpers.ts
git commit -m "feat(workspace): look at the repository before cutting anything from it"
```

---

## Задача 4: снимок незакоммиченного состояния

Спека D3, §2.8, §2.9. `git stash create` здесь непригоден и это доказано пробой — реализовывать
через временный индекс.

**Файлы:**

- Создать: `packages/workspace/src/snapshot.ts`
- Изменить: `packages/workspace/src/index.ts`
- Тест: `packages/workspace/test/snapshot.integration.test.ts`

**Интерфейсы — потребляет:** `runGit`, `RepositoryState`.
**Производит:**

```ts
export type CarryInSnapshot = { commit: string; carriedPaths: readonly string[] };
export const createCarryInSnapshot = (context: {
  topLevel: string;
  headCommit: string | null;
  message: string;
}): Promise<CarryInSnapshot | null>; // null — переносить нечего
```

- [ ] **Шаг 1: тест на все четыре категории сразу**

Хелпер `makeRepoWithEveryKindOfChange`: изменённый отслеживаемый файл, файл добавленный в индекс,
untracked-файл в корне, untracked-файл во вложенном каталоге, игнорируемый файл, и удалённый
отслеживаемый файл.

```ts
it("carries the work the owner has not committed, and leaves the ignored files behind", async () => {
  const repo = await makeRepoWithEveryKindOfChange();
  const state = await inspectRepository(repo.path);
  const snapshot = await createCarryInSnapshot({
    topLevel: state!.topLevel,
    headCommit: state!.headCommit,
    message: "loomrail: carry-in",
  });
  const listed = await runGit(["ls-tree", "-r", "--name-only", snapshot!.commit], { cwd: repo.path });
  const paths = listed.stdout.trim().split("\n");
  expect(paths).toContain("tracked-modified.txt");
  expect(paths).toContain("staged.txt");
  expect(paths).toContain("untracked-new.txt");
  expect(paths).toContain("subdir/untracked-nested.txt");
  expect(paths).not.toContain("build/artifact.txt");
  expect(paths).not.toContain("deleted.txt");
});
```

- [ ] **Шаг 2: тест на неприкосновенность рабочей копии владельца**

Критерий приёмки 4 спеки. Утверждение над строкой целиком, не над «примерно тем же»:

```ts
it("leaves the owner's own working copy byte for byte as it was", async () => {
  const repo = await makeRepoWithEveryKindOfChange();
  const before = await runGit(["status", "--porcelain"], { cwd: repo.path });
  await createCarryInSnapshot({ topLevel: repo.path, headCommit: repo.head, message: "m" });
  const after = await runGit(["status", "--porcelain"], { cwd: repo.path });
  expect(after.stdout).toBe(before.stdout);
  const stash = await runGit(["rev-parse", "--verify", "refs/stash"], { cwd: repo.path });
  expect(stash.exitCode).not.toBe(0);
});
```

- [ ] **Шаг 3: тест на «переносить нечего»**

```ts
it("says there was nothing to carry rather than making an empty commit", async () => {
  const repo = await makeThrowawayRepo();
  const snapshot = await createCarryInSnapshot({ topLevel: repo, headCommit: head, message: "m" });
  expect(snapshot).toBeNull();
});
```

- [ ] **Шаг 4: реализация**

Последовательность из спеки §2.9. `GIT_INDEX_FILE` — во временном каталоге **вне** `.git`,
удаляется в `finally`, включая путь отказа. Пустой репозиторий (`headCommit === null`) →
`commit-tree` без `-p`. «Нечего переносить» — сравнение `write-tree` с `rev-parse HEAD^{tree}`, а не
разбор текста статуса. `carriedPaths` — из `diff --name-only HEAD <snapshot>` для непустого HEAD и
из `ls-tree` для пустого.

- [ ] **Шаг 5: мутация**

Заменить `git add -A` на `git add -u` (переносит только отслеживаемые) → тест Шага 1 краснеет
`expected [ … ] to contain 'untracked-new.txt'`. Вернуть. Это ровно тот дефект, который дал бы
`git stash create`, и тест обязан его ловить.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/src/snapshot.ts packages/workspace/src/index.ts packages/workspace/test/snapshot.integration.test.ts packages/workspace/test/helpers.ts
git commit -m "feat(workspace): snapshot the work the owner has not committed yet"
```

---

## Задача 5: создание, перечисление и удаление worktree

**Файлы:**

- Создать: `packages/workspace/src/worktree.ts`
- Изменить: `packages/workspace/src/index.ts`
- Тест: `packages/workspace/test/worktree.integration.test.ts`

**Интерфейсы — потребляет:** `runGit`.
**Производит:**

```ts
export type WorktreeEntry = { path: string; branch: string | null; prunable: boolean };
export type AddWorktreeRefusal =
  | { type: "BRANCH_EXISTS"; branch: string }
  | { type: "BRANCH_CHECKED_OUT"; branch: string; occupiedBy: string }
  | { type: "PATH_EXISTS"; path: string };
export const listWorktrees = (topLevel: string): Promise<readonly WorktreeEntry[]>;
export const addWorktree = (context: {
  topLevel: string;
  branch: string;
  path: string;
  startPoint: string;
}): Promise<{ type: "ADDED" } | { type: "REFUSED"; refusal: AddWorktreeRefusal }>;
export const removeWorktree = (context: { topLevel: string; path: string }): Promise<void>;
```

Занятость проверяется **до** попытки создания (спека §2.11), через `show-ref --verify --quiet` и
`listWorktrees`, а не разбором текста ошибки. Разбор прозы — это то, что ломается при обновлении
`git`.

- [ ] **Шаг 1: тест на создание вне репозитория**

```ts
it("puts the worktree where the owner's repository will not see it", async () => {
  const repo = await makeThrowawayRepo();
  const outside = join(await mkdtemp(join(tmpdir(), "loomrail-wt-")), "task-1");
  const added = await addWorktree({
    topLevel: repo,
    branch: "loomrail/task-1",
    path: outside,
    startPoint: "HEAD",
  });
  expect(added.type).toBe("ADDED");
  const status = await runGit(["status", "--porcelain"], { cwd: repo });
  expect(status.stdout).toBe("");
});
```

- [ ] **Шаг 2: тест на занятую ветку**

```ts
it("names the branch it will not take over", async () => {
  const repo = await makeThrowawayRepo();
  await runGit(["branch", "loomrail/task-1"], { cwd: repo });
  const added = await addWorktree({
    topLevel: repo,
    branch: "loomrail/task-1",
    path: dir,
    startPoint: "HEAD",
  });
  expect(added).toEqual({ type: "REFUSED", refusal: { type: "BRANCH_EXISTS", branch: "loomrail/task-1" } });
});
```

- [ ] **Шаг 3: тест на осиротевший worktree**

```ts
it("marks a worktree whose directory was deleted from under git", async () => {
  const repo = await makeThrowawayRepo();
  const dir = join(await mkdtemp(join(tmpdir(), "loomrail-wt-")), "task-1");
  await addWorktree({ topLevel: repo, branch: "loomrail/task-1", path: dir, startPoint: "HEAD" });
  await rm(dir, { recursive: true, force: true });
  const entries = await listWorktrees(repo);
  expect(entries.find((entry) => entry.path === dir)?.prunable).toBe(true);
});
```

- [ ] **Шаг 4: реализация**

`listWorktrees` разбирает `worktree list --porcelain`: записи разделены пустой строкой, ключи —
`worktree`, `branch`, `prunable`, `detached`. Ветка приводится из `refs/heads/<имя>` к `<имя>`.
`addWorktree` сначала проверяет три условия отказа, потом запускает
`worktree add -b <ветка> <путь> <стартовая точка>`. `removeWorktree` — `worktree remove --force`,
и код 0 на исчезнувшем каталоге считается успехом (спека §2.11).

- [ ] **Шаг 5: мутация**

Убрать проверку `BRANCH_EXISTS` до вызова → тест Шага 2 краснеет утверждением над формой результата
(`expected { type: 'ADDED' } to deeply equal { type: 'REFUSED', … }`), а не падением процесса.
Вернуть.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/src/worktree.ts packages/workspace/src/index.ts packages/workspace/test/worktree.integration.test.ts
git commit -m "feat(workspace): create, list and remove the worktree a task works in"
```

---

## Задача 6: контракт рабочей области

**Файлы:**

- Создать: `packages/contracts/src/workspace.ts`
- Изменить: `packages/contracts/src/index.ts`
- Тест: `packages/contracts/test/workspace.unit.test.ts`

**Интерфейсы — производит:**

```ts
export const workItemWorkspaceStatusSchema = z.enum(["READY", "ORPHANED", "REMOVED"]);
export const workItemWorkspaceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    branch: z.string().trim().min(1).max(255),
    worktreePath: z.string().trim().min(1).max(4_000),
    baseCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    snapshotCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    status: workItemWorkspaceStatusSchema,
    leaseHolder: opaqueIdSchema.nullable(),
    createdAt: utcTimestampSchema,
    version: z.number().int().positive(),
  })
  .strict();
```

Плюс событие `WORK_ITEM_WORKSPACE_CREATED` (несёт рабочую область и `carriedPaths`, не более 500
путей), `WORK_ITEM_WORKSPACE_ORPHANED`, и команды `CREATE_WORK_ITEM_WORKSPACE`,
`ACQUIRE_WORKSPACE_LEASE`, `RELEASE_WORKSPACE_LEASE`, `MARK_WORKSPACE_ORPHANED`.

`baseCommit` — nullable, потому что пустой репозиторий его не имеет (спека §2.12). Это не
необязательность, а факт: `.nullable()`, не `.optional()`.

- [ ] **Шаг 1: тест на то, что путь обязателен**

```ts
it("refuses a workspace that names no worktree", () => {
  expect(() => workItemWorkspaceSchema.parse({ ...validWorkspace, worktreePath: "" })).toThrow();
});
```

Собрать `validWorkspace` в этом же файле полем за полем — тест, который бросает по недостающему
полю вместо названного нарушения, проходит по неверной причине. Этап A2 нашёл ровно это в
`session.unit.test.ts`.

- [ ] **Шаг 2: тест на закрытость схемы**

```ts
it("does not silently accept a field nobody declared", () => {
  expect(() => workItemWorkspaceSchema.parse({ ...validWorkspace, remoteUrl: "x" })).toThrow();
});
```

- [ ] **Шаг 3: реализация схем и реэкспорт из `index.ts`.**

- [ ] **Шаг 4: мутация** — убрать `.strict()` → тест Шага 2 краснеет
      `expected [Function] to throw an error`. Вернуть.

- [ ] **Шаг 5: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/contracts/src/workspace.ts packages/contracts/src/index.ts packages/contracts/test/workspace.unit.test.ts
git commit -m "feat(contracts): give a work item the workspace it is edited in"
```

---

## Задача 7: миграция 0011 и хранение

**Файлы:**

- Создать: `packages/persistence-sqlite/migrations/0011_work_item_workspaces.sql`
- Изменить: `packages/persistence-sqlite/src/index.ts`
- Тест: `packages/persistence-sqlite/test/local-state.integration.test.ts`

**Интерфейсы — потребляет:** контракт Задачи 6.
**Производит:** обработчики четырёх команд и чтение рабочей области по `workItemId`.

- [ ] **Шаг 1: миграция**

```sql
CREATE TABLE work_item_workspaces (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_commit TEXT,
  snapshot_commit TEXT,
  status TEXT NOT NULL CHECK (status IN ('READY', 'ORPHANED', 'REMOVED')),
  lease_holder TEXT REFERENCES stage_attempts(id),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
);
```

`work_item_id` — `UNIQUE`: рабочая область принадлежит WorkItem (D1), и вторая означала бы двух
писателей мимо аренды. Инвариант принадлежит хранилищу, а не соглашению вызывающих.

- [ ] **Шаг 2: тест на единственность**

```ts
it("refuses a second workspace for one work item", async () => {
  await state.execute(createWorkspaceCommand(workItemId));
  await expect(state.execute(createWorkspaceCommand(workItemId, { commandId: other }))).rejects.toThrow();
});
```

- [ ] **Шаг 3: тест на аренду**

```ts
it("does not hand a second stage attempt the workspace a first one is writing in", async () => {
  await state.execute(acquireLease(workspaceId, attemptA));
  await expect(state.execute(acquireLease(workspaceId, attemptB))).rejects.toThrow(/lease/i);
});
```

- [ ] **Шаг 4: реализация обработчиков.** Аренда берётся сравнением с `null` в одном
      `UPDATE … WHERE lease_holder IS NULL`, а не чтением с последующей записью: проверка и захват
      обязаны быть одним действием.

- [ ] **Шаг 5: мутация** — снять условие `lease_holder IS NULL` → тест Шага 3 краснеет
      `promise resolved instead of rejecting`. Вернуть.

- [ ] **Шаг 6: тест на время миграции**

Прогнать миграцию на копии базы владельца, снятой **через backup API**, а не `cp` (WAL). Записать
измеренное время в отчёт. `ALTER`/`CREATE TABLE` здесь метаданные, так что ожидание — единицы
миллисекунд; если больше, это находка.

- [ ] **Шаг 7: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/persistence-sqlite/migrations/0011_work_item_workspaces.sql packages/persistence-sqlite/src/index.ts packages/persistence-sqlite/test/local-state.integration.test.ts
git commit -m "feat(persistence): store the workspace a work item is edited in"
```

---

## Задача 8: решения домена

**Файлы:**

- Создать: `packages/domain/src/workspace.ts`
- Изменить: `packages/domain/src/index.ts`, `packages/domain/src/workflow.ts`
- Тест: `packages/domain/test/workspace.unit.test.ts`

**Производит:**

```ts
export const workspaceBranchName = (context: { workItemId: string; title: string }): string;
export type ProvisionRefusal = { title: string; context: string; recommendation: string };
export const decideProvisionWorkspace = (context: {
  repository: { isRepository: boolean; inProgress: string | null; path: string };
}): { type: "PROVISION" } | { type: "REFUSED"; request: HumanRequestDraft };
```

Плюс третья ветка отказа диспетчеризации в `workflow.ts` — «рабочую область создать не удалось»,
отдельная от двух существующих (спека §5).

- [ ] **Шаг 1: тест на имя ветки**

```ts
it("builds a branch name a human can recognise and git will accept", () => {
  const branch = workspaceBranchName({ workItemId: "workItem-9a342451-…", title: "Fix the login redirect" });
  expect(branch).toBe("loomrail/9a342451-fix-the-login-redirect");
});

it("keeps a title made only of punctuation from producing an unusable ref", () => {
  const branch = workspaceBranchName({ workItemId: "workItem-9a342451-…", title: "??? !!!" });
  expect(branch).toBe("loomrail/9a342451");
});
```

Git запрещает в именах ссылок пробелы, `~^:?*[`, две точки подряд, завершающую точку и `.lock`;
slug строится из строчных латинских букв, цифр и дефиса, обрезается по 40 символам, и пустой slug
даёт имя из одного идентификатора.

- [ ] **Шаг 2: тест на отказ посреди rebase**

```ts
it("asks the owner rather than cutting a branch from a rebase in progress", () => {
  const decision = decideProvisionWorkspace({
    repository: { isRepository: true, inProgress: "REBASE", path: "/x" },
  });
  expect(decision.type).toBe("REFUSED");
  expect(decision.request.title).toContain("rebase");
  expect(decision.request.blocking).toBe(true);
});
```

- [ ] **Шаг 3: реализация.** Тексты отказов пишутся по образцу `decideDispatchStage`
      (`packages/domain/src/workflow.ts:297`): `kind: "FREE_TEXT"`, `allowOther: true`, пустой
      `options` — правильное действие тут вне Loomrail и перечислению не поддаётся.

- [ ] **Шаг 4: мутация** — вернуть `PROVISION` при `inProgress !== null` → тест Шага 2 краснеет
      `expected 'PROVISION' to be 'REFUSED'`. Вернуть.

- [ ] **Шаг 5: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/domain/src/workspace.ts packages/domain/src/index.ts packages/domain/src/workflow.ts packages/domain/test/workspace.unit.test.ts
git commit -m "feat(domain): decide when a workspace may be cut, and what to call its branch"
```

---

## Задача 9: демон создаёт рабочую область перед диспетчеризацией

**Файлы:**

- Изменить: `apps/daemon/src/session-loop.ts`
- Тест: `apps/daemon/test/session-loop.integration.test.ts`

**Потребляет:** Задачи 3, 4, 5 (`packages/workspace`), 7 (команды), 8 (решения).

Порядок (спека §6): осмотр репозитория → решение домена → снимок → `worktree add` → команда
создания → аренда → диспетчеризация. Каждый шаг отказа заканчивается вопросом владельцу, а не
исключением, вылетающим наверх.

- [ ] **Шаг 1: тест на то, что рабочая область появляется до сессии**

Поднять демон на одноразовом репозитории с mock-адаптером, объявляющим IMPLEMENT, запустить стадию,
утвердить, что worktree существует на диске и его `git status` чистый **до** старта сессии.

- [ ] **Шаг 2: тест на отказ посреди rebase — сквозной**

```ts
it("asks the owner instead of running an agent over a rebase's scratch commit", async () => {
  const repo = await makeRepoMidRebase();
  // …запустить стадию…
  const requests = await listHumanRequests();
  expect(requests[0]?.title).toContain("rebase");
  expect(await listWorktrees(repo)).toHaveLength(1); // только сам репозиторий
});
```

- [ ] **Шаг 3: реализация.** Стадии, которым репозиторий не нужен, рабочую область не создают:
      признак берётся из шаблона workflow, а не из имени стадии.

- [ ] **Шаг 4: мутация** — убрать вызов решения домена → тест Шага 2 краснеет утверждением над
      числом worktree. Вернуть.

- [ ] **Шаг 5: `pnpm verify`, `pnpm build`, коммит**

```bash
git add apps/daemon/src/session-loop.ts apps/daemon/test/session-loop.integration.test.ts
git commit -m "feat(daemon): cut the workspace before dispatching work into it"
```

---

## Задача 10: подбор осиротевших рабочих областей при старте

**Файлы:**

- Изменить: `packages/persistence-sqlite/src/index.ts` (обработчик `RECONCILE_WORKFLOWS`)
- Тест: `packages/persistence-sqlite/test/local-state.integration.test.ts`

Приём тот же, что уже подбирает осиротевшие процессы, и с тем же правилом: **ничего не
воскрешается** (AD-008). Каталог, исчезнувший снаружи, переводит рабочую область в `ORPHANED`
с записью в лог; ветка остаётся, потому что в ней единственный экземпляр работы (D12).

- [ ] **Шаг 1: тест** — создать рабочую область, удалить каталог, перезапустить, утвердить статус
      `ORPHANED` и наличие записи в логе, и что ветка **всё ещё существует**.
- [ ] **Шаг 2: реализация.** Отказ `git` на этом пути не должен мешать демону стартовать: правило
      Задачи 1 этапа A2 (`killOrphanedSessionProcess`) действует и здесь — ничто отсюда не
      вылетает в `execute`.
- [ ] **Шаг 3: мутация** — убрать проверку `prunable`; тест краснеет утверждением над статусом
      (`READY` вместо `ORPHANED`). Вернуть.
- [ ] **Шаг 4: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/persistence-sqlite/src/index.ts packages/persistence-sqlite/test/local-state.integration.test.ts
git commit -m "feat(persistence): notice the workspace whose directory went away"
```

---

## Задача 11: адаптер Codex работает в worktree

**Файлы:**

- Изменить: `packages/provider-core/src/index.ts` (`ProviderInvocation`),
  `packages/provider-codex/src/index.ts`
- Создать: `packages/provider-codex/test/recordings/workspace-write.jsonl` — **запись настоящего
  потока**, снятая с авторизованного CLI прогоном, который создаёт файл и запускает команду
- Тест: `packages/provider-codex/test/adapter.unit.test.ts`

**Производит:** `ProviderInvocation.workspace?: { path: string; branch: string; baseCommit: string | null }`.

Запуск (спека D8): `-C <worktree>`, `-s workspace-write`,
`-c sandbox_workspace_write.network_access=true`, `--ignore-user-config` (уже с Задачи 1), **без**
`--skip-git-repo-check` (§2.7) и **без** флага одобрения (§2.3 — его добавление ломает запуск).
Объявляемые стадии Codex становятся шестью.

- [ ] **Шаг 1: тест на аргументы** — утверждение над массивом, не над склейкой (§Задача 1).
- [ ] **Шаг 2: тест на закрытый список `-c`**

```ts
it("opens exactly one config key and no others", () => {
  const configValues = spawned.args.filter((arg, index) => spawned.args[index - 1] === "-c");
  expect(configValues).toEqual(["sandbox_workspace_write.network_access=true"]);
});
```

- [ ] **Шаг 3: тест на «побеждает последний»** — спека D9, §2.6. Против записи, содержащей
      **плацехолдер до работы и настоящий ответ после**:

```ts
it("returns the answer the agent finished with, not the one it started with", async () => {
  const outcome = await runAdapterAgainstRecording("workspace-write.jsonl");
  expect(outcome).toEqual({ type: "COMPLETED", summary: "<текст последнего agent_message>" });
});
```

- [ ] **Шаг 4: реализация.** Пустой временный каталог остаётся только на пути «рабочей области нет».
- [ ] **Шаг 5: мутация** — сделать чекпоинт «первым победившим» → тест Шага 3 краснеет
      `expected { summary: '' } to deeply equal { summary: '…' }`. Вернуть. **Это главная мутация
      задачи**: без неё стадия завершается успехом с пустым чекпоинтом.
- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

---

## Задача 12: регистрация репозитория и fixture как настоящие репозитории

**Файлы:**

- Изменить: `apps/daemon/src/server.ts`, `apps/daemon/src/fixtures.ts`
- Тест: `apps/daemon/test/server.integration.test.ts`, `e2e/walking-skeleton.spec.ts`

Bundled fixture **не может** храниться в репозитории как настоящий Git-репозиторий: вложенный `.git`
не коммитится. Поэтому fixture остаётся шаблоном, а репозиторием становится при регистрации:
каталог копируется в `<data>/demo-projects/<fixtureId>`, там выполняются `git init` и первый коммит.
Обещание спеки («fixture становятся настоящими репозиториями с первым коммитом») этим выполняется.

- [ ] **Шаг 1: тест на регистрацию своего репозитория** — путь, не являющийся репозиторием,
      отклоняется с называнием пути.
- [ ] **Шаг 2: тест на материализацию fixture** — после инициализации демо `inspectRepository`
      возвращает непустой `headCommit`.
- [ ] **Шаг 3: реализация.** Материализация идемпотентна: повторная инициализация не пересоздаёт
      репозиторий и не теряет работу.
- [ ] **Шаг 4: мутация** — убрать первый коммит → тест Шага 2 краснеет `expected null to match /^[0-9a-f]{40}$/`.
- [ ] **Шаг 5: `pnpm verify`, `pnpm build`, `pnpm test:e2e`, коммит**

---

## Задача 13: рабочая область видна в карточке

**Файлы:**

- Изменить: `apps/web/src/views/WorkbenchPage.tsx`, `apps/web/src/i18n.tsx`,
  `apps/daemon/src/server.ts` (ответ API)
- Тест: `e2e/walking-skeleton.spec.ts`

Показываются: репозиторий, ветка, базовый коммит, путь к worktree, список изменённых файлов с числом
строк. Список берётся из `git diff --numstat <snapshot|base> -- .` в worktree.

- [ ] **Шаг 1: браузерный тест** — после стадии, изменившей файл, карточка называет ветку и файл.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: мутация** — вернуть пустой список файлов → тест краснеет по отсутствию имени файла.
- [ ] **Шаг 4: `pnpm verify`, `pnpm test:e2e`, коммит**

---

## Задача 14: документы догоняют код

**Файлы:** `docs/security/THREAT-MODEL.md`, `README.md`,
`docs/plans/13-e1-workspace-execution-spec.ru.md` (блоки `ПРАВКА`)

- [ ] **Шаг 1: модель угроз** — наследование пользовательского конфига (закрыто Задачей 1);
      исключение для одного ключа `-c` с утверждением, которое его стережёт; принятый риск переноса
      секретов рядом с открытой сетью; логин-оболочка `/bin/zsh -lc` и окружение владельца.
- [ ] **Шаг 2: README** — что живой агент теперь делает и чего по-прежнему не делает (не коммитит,
      не пушит, не выходит за worktree).
- [ ] **Шаг 3: правки спеки** — каждое место, где реализация разошлась со спекой, блоком `ПРАВКА`,
      а не переписыванием истории. Если расхождений нет, записать и это.
- [ ] **Шаг 4: коммит**

---

## Само-ревью плана

**Покрытие спеки.** D1 → Задачи 6, 7. D2 → Задача 5. D3 → Задача 4. D4 → Задача 4 (снимок как
стартовая точка) и 9. D5 → Задачи 3, 8, 9. D6 → Задача 7 (аренда одним `UPDATE`). D7 → Задача 1.
D8 → Задача 11. D9 → Задача 11, Шаг 3. D10 → Задача 11 плюс стартовый отчёт. D11 → Задача 11
(Claude не трогается). D12 → Задачи 10, 12. Критерии приёмки 1–16 → Задачи 12, 12, 4, 4, 5, 9, 3,
5, 10, 7, 11, 11, 11, ручной прогон, 11, 13.

**Незакрытое, названное явно:** критерий 14 (живая сессия меняет файл) требует авторизованного CLI и
расхода квоты владельца — он проверяется прогоном, а не тестом, и Задача 11 требует **записи
настоящего потока**, которую можно снять только таким прогоном. Это первое, что делает исполнитель
Задачи 11, и если снять запись не удаётся — это BLOCKED, а не повод сочинить фикстуру.

**Согласованность типов.** `RepositoryState.topLevel` (Задача 3) — то же поле, что читает
`createCarryInSnapshot` (Задача 4) и `addWorktree` (Задача 5). `CarryInSnapshot.commit` (Задача 4) —
`startPoint` для `addWorktree` (Задача 5) и `snapshotCommit` в контракте (Задача 6). `baseCommit`
всюду nullable и всюду `.nullable()`, не `.optional()`.

**Порядок.** Задача 1 не зависит ни от чего. Задачи 2–5 строят пакет снизу вверх. 6–7 — долговечное
состояние. 8–10 — оркестрация. 11 — адаптер. 12–14 — поверхность и документы.
