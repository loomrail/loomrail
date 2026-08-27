# E1.5 — Видимость изменений: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНАЯ ПОД-СКИЛЛ: `superpowers:subagent-driven-development`.
> Шаги помечены чекбоксами (`- [ ]`).

**Цель:** владелец видит в карточке задачи, какие файлы изменила рабочая область и что именно в них
изменилось, не выходя из продукта в терминал.

**Архитектура:** чтение изменений добавляется в `packages/workspace` — единственное место в дереве,
которое запускает `git`. Состав изменений считается **через временный индекс**, а не наивным `git
diff` по рабочему дереву: последний не видит созданных агентом файлов (спека §2.1). Тот же индекс
одним вызовом `write-tree` отдаёт хэш дерева — метку конца стадии. Над этим — две схемы контракта,
две GET-ручки демона и секция в карточке, обновляемая по каналу событий A1.5.

**Технологии:** TypeScript strict, pnpm workspaces, Zod 4, Vitest, `node:child_process`,
`node:sqlite` (только в `packages/persistence-sqlite`), React, Playwright.

**Спека:** [15-e1-5-change-visibility-spec.ru.md](15-e1-5-change-visibility-spec.ru.md) — читать
вместе с планом. План аргументирует из спеки; при расхождении спека главнее.

## Глобальные ограничения

- TypeScript strict. Zod 4 на каждой границе, `.strict()` несущий.
- Новых зависимостей времени исполнения не добавлять. `git` запускается как процесс, без обёрток.
- `node:sqlite` импортирует только `packages/persistence-sqlite`.
- Применённую миграцию не редактировать — добавлять новую. Текущая последняя — 0011.
- Реальную базу владельца (`~/Library/Application Support/Loomrail/state.sqlite`) не трогать. Для
  проверок — копия через backup API, никогда не `cp` (WAL теряется).
- **Наивный `git diff <baseline>` по рабочему дереву запрещён на всех путях** (спека D2). Состав
  изменений читается только через временный индекс. Это не стилистика: проба §2.1 показала, что
  наивный вызов молча теряет созданные файлы.
- **Флаги, снимающие влияние конфига владельца, обязательны на каждом вызове чтения** (спека D4):
  `--no-ext-diff`, `--no-color`, `-c core.quotepath=false`, явный `-M`.
- **Каждый тест обязан уметь покраснеть от дефекта, который он называет.** Сломать реализацию,
  убедиться в красноте **утверждением** (не таймаутом, не падением в подготовке, не необработанным
  отклонением промиса), вернуть. Мутация и текст утверждения — в отчёт.
- Тесты идут против настоящих Git-репозиториев, создаваемых в temp-каталоге. Выдуманная фикстура,
  утверждающая предположение, — это дефект: так родился Critical этапа A2.
- В worktree ничего не пишется ради показа (спека D10). Временный индекс живёт в temp-каталоге ОС.
- Никаких декоративных функций: за каждым контролом реальное поведение.
- Гейт между задачами — `pnpm verify` **целиком**, плюс `pnpm build`. Не подмножество.
- Коммитить файлы поимённо. Никогда `git add .`, `git add -A`, `git add <каталог>`. Не пушить.
- Node 24.19.0 (`.nvmrc`).

## Пределы (спека §12.1)

Названы здесь один раз и используются как единственный источник:

- `MAX_SUMMARY_FILES = 2_000` — файлов в сводке. Больше — `truncated: true`.
- `MAX_PATCH_BYTES = 512 * 1024` — байт тела одного файла. Больше — обрезка с `omittedBytes`.
- `SUMMARY_REFRESH_DEBOUNCE_MS = 750` — не чаще одного перечитывания сводки в этот интервал.

Числа выбраны как рабочие значения, а не измерены. Задача 7 требует измерить их на настоящем
большом репозитории и записать результат; менять их разрешено только после измерения.

## Структура файлов

**Создаётся:**

- `packages/workspace/src/changes.ts` — состав изменений, тело диффа, проверка пути.
- `packages/persistence-sqlite/migrations/0012_stage_attempt_result_tree.sql` — метка стадии.
- `apps/web/src/views/ChangesSection.tsx` — секция изменений в карточке.

**Изменяется:** `packages/workspace/src/index.ts`, `packages/workspace/test/helpers.ts`,
`packages/contracts/src/workspace.ts`, `packages/contracts/src/workflow.ts`,
`packages/persistence-sqlite/src/index.ts`, `apps/daemon/src/server.ts`,
`apps/daemon/src/session-loop.ts`, `apps/web/src/api.ts`,
`apps/web/src/views/WorkbenchPage.tsx`, `apps/web/src/i18n.tsx`, `README.md`,
`docs/plans/15-e1-5-change-visibility-spec.ru.md`.

---

## Задача 1: состав изменений через временный индекс

**Файлы:**

- Создать: `packages/workspace/src/changes.ts`
- Изменить: `packages/workspace/src/index.ts`, `packages/workspace/src/git.ts`,
  `packages/workspace/src/snapshot.ts`, `packages/workspace/test/helpers.ts`
- Тест: `packages/workspace/test/changes.integration.test.ts`

**Интерфейсы — производит:**

```ts
export type ChangeStatus = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

export type ChangedFile = {
  path: string;
  // Only set for RENAMED; null otherwise. Named `previousPath` rather than `from` because the
  // record reads as a statement about this file, not about a pair.
  previousPath: string | null;
  status: ChangeStatus;
  // Null for a binary file, never zero: zero is a claim that nothing changed in it.
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ChangeSummary = {
  files: readonly ChangedFile[];
  // `write-tree` over the very same temporary index the files were read from, so the two can
  // never disagree (spec D3).
  tree: string;
  truncated: boolean;
};

export const summariseChanges = (context: {
  worktreePath: string;
  baseline: string;
  maxFiles: number;
}): Promise<ChangeSummary>;
```

Плюс один точечный переезд: `runGitWithIndex` сейчас приватен внутри `snapshot.ts`, а нужен обоим
читателям. Он переезжает в `git.ts` и экспортируется оттуда; `snapshot.ts` начинает импортировать
его вместо собственной копии. Поведение не меняется — тесты снимка обязаны остаться зелёными без
правок, и это само по себе проверка переезда.

```ts
export const runGitWithIndex = (
  args: readonly string[],
  cwd: string,
  indexFile: string,
): Promise<GitResult>;
```

Форматы вывода git установлены пробой, а не выведены по памяти. `--numstat -z` даёт записи
`ins\tdel\tpath\0`, для бинарного файла — `-\t-\tpath\0`, а для переименования — `ins\tdel\t\0` и
следом **два** отдельных токена: старый путь и новый. `--name-status -z` даёт `A\0path\0`,
`M\0path\0`, `D\0path\0` и `R100\0old\0new\0`. Соединять по новому пути.

- [ ] **Шаг 1: тест-регрессия на созданный файл**

Это главный тест задачи: он краснеет ровно от того дефекта, ради которого существует временный
индекс.

```ts
it("sees a file the agent created, which a plain `git diff` against the baseline does not", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

  const created = summary.files.find((file) => file.path === "added.txt");
  expect(created).toEqual({
    path: "added.txt",
    previousPath: null,
    status: "ADDED",
    insertions: 1,
    deletions: 0,
    binary: false,
  });
});
```

`makeWorktreeWithEveryKindOfChange` — новый хелпер в `test/helpers.ts`, рядом с существующим
`makeRepoWithEveryKindOfChange`. Он создаёт репозиторий, коммитит базу, возвращает её sha и оставляет
в дереве: изменённый отслеживаемый файл, созданный файл, удалённый файл, переименованный файл,
изменённый бинарный файл и файл под `.gitignore`. Имя и почта коммиттера задаются флагами `-c`, а не
глобальной конфигурацией машины, иначе тест зависит от настроек того, кто его запускает.

- [ ] **Шаг 2: прогнать, убедиться в красноте** — `Cannot find module './changes.js'`. Это красное по
      импорту, а не по утверждению, и потому не считается доказанным; доказательство даёт Шаг 5.

- [ ] **Шаг 3: реализация**

```ts
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// The flags that make git's answer independent of the owner's config (spec D4). `-M` is passed
// explicitly rather than relying on `diff.renames`, and `core.quotepath=false` keeps non-ASCII
// paths as themselves instead of escape sequences.
const readArgs = [
  "-c",
  "core.quotepath=false",
  "diff-index",
  "--cached",
  "--no-ext-diff",
  "--no-color",
  "-M",
  "-z",
];

const splitNul = (text: string): readonly string[] => text.split("\0").filter((part) => part.length > 0);
```

`summariseChanges` строит временный индекс тем же плумбингом, что и `createCarryInSnapshot`
(`read-tree` базы → `add -A`), берёт `write-tree`, затем делает два чтения — `--numstat` и
`--name-status` — и соединяет их по новому пути. Временный каталог удаляется в `finally`, включая
путь с исключением. `add -A` уважает `.gitignore`, поэтому сборочный мусор в сводку не попадает сам
собой, без списка исключений в коде.

Разбор `--numstat -z`: токены читаются по одному. Токен вида `ins\tdel\tpath` — обычная запись;
токен вида `ins\tdel\t` с пустым третьим полем означает переименование, и следующие два токена — это
старый и новый пути. `-` вместо числа означает бинарный файл: `insertions` и `deletions` — `null`,
`binary` — `true`.

`baseline` подставляется в аргументы как отдельный элемент массива, никогда не склейкой строк.

- [ ] **Шаг 4: тесты на остальные виды изменений**

```ts
it("reports a rename as a rename, naming where the file came from", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

  expect(summary.files.find((file) => file.path === "renamed-to.txt")).toMatchObject({
    status: "RENAMED",
    previousPath: "renamed-from.txt",
  });
  expect(summary.files.some((file) => file.path === "renamed-from.txt")).toBe(false);
});

it("marks a binary file binary and refuses to invent line counts for it", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

  expect(summary.files.find((file) => file.path === "pic.bin")).toMatchObject({
    binary: true,
    insertions: null,
    deletions: null,
  });
});

it("leaves an ignored file out of the summary", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

  expect(summary.files.some((file) => file.path.startsWith("build/"))).toBe(false);
});

it("says the summary was truncated instead of quietly returning fewer files", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 1 });

  expect(summary.files).toHaveLength(1);
  expect(summary.truncated).toBe(true);
});

it("hands back the tree of the same index the files were read from", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

  expect(summary.tree).toMatch(/^[0-9a-f]{40}$/);
  expect(summary.tree).not.toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904"); // git's empty tree
});
```

- [ ] **Шаг 5: мутация**

Заменить построение временного индекса на наивный `runGit(["diff", "--numstat", baseline], { cwd:
worktreePath })` → тест Шага 1 краснеет утверждением `expected undefined to deeply equal { path:
'added.txt', … }`. Вернуть. Записать в отчёт: это доказательство §2.1, а не формальность.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/src/changes.ts packages/workspace/src/git.ts packages/workspace/src/snapshot.ts packages/workspace/src/index.ts packages/workspace/test/helpers.ts packages/workspace/test/changes.integration.test.ts
git commit -m "feat(workspace): read what a work item changed, including files it created"
```

---

## Задача 2: тело диффа одного файла и граница рабочей области

**Файлы:**

- Изменить: `packages/workspace/src/changes.ts`
- Тест: `packages/workspace/test/changes.integration.test.ts`

**Интерфейсы — потребляет:** `readArgs`, `splitNul` из Задачи 1.

**Интерфейсы — производит:**

```ts
export type FileDiff = {
  path: string;
  binary: boolean;
  // Null for a binary file: there is no text to show, and an empty string would read as "no
  // change" (spec D8).
  patch: string | null;
  truncated: boolean;
  omittedBytes: number;
};

export class PathOutsideWorktreeError extends Error {
  readonly requestedPath: string;
}

// Resolves a client-supplied path against the worktree and refuses anything that leaves it.
// Exported because the daemon refuses before doing any work, and the refusal must be the same one.
export const resolveWorktreeRelativePath = (worktreePath: string, requestedPath: string): string;

export const readFileDiff = (context: {
  worktreePath: string;
  baseline: string;
  path: string;
  maxBytes: number;
}): Promise<FileDiff>;
```

- [ ] **Шаг 1: тест на тело диффа**

```ts
it("returns the unified diff of one file, and only that file", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const diff = await readFileDiff({ worktreePath, baseline, path: "mod.txt", maxBytes: 512 * 1024 });

  expect(diff.patch).toContain("-original");
  expect(diff.patch).toContain("+changed");
  expect(diff.patch).not.toContain("added.txt");
  expect(diff.truncated).toBe(false);
  expect(diff.omittedBytes).toBe(0);
});
```

- [ ] **Шаг 2: прогнать, убедиться в красноте** — `readFileDiff is not a function`.

- [ ] **Шаг 3: реализация**

Тот же временный индекс, затем `diff-index --cached` с теми же флагами D4, плюс путь **после `--`**,
чтобы путь, начинающийся с дефиса, не был прочитан как флаг:

```ts
const result = await runGitWithIndex(
  [...readArgs.filter((arg) => arg !== "-z"), "-p", baseline, "--", relativePath],
  worktreePath,
  indexFile,
);
```

Обрезка считается в байтах готового патча: если длина больше `maxBytes`, патч режется по границе
строки, `truncated` — `true`, `omittedBytes` — сколько байт отброшено. Ноль, когда не обрезано.

`resolveWorktreeRelativePath` нормализует путь, приводит worktree к каноническому виду через
`realpath` и сравнивает по разделителю пути, а не по префиксу строки: `/tmp/wt-evil` не должен
считаться лежащим внутри `/tmp/wt`. Абсолютный путь и путь с `..`, уходящий наружу, — отказ.

- [ ] **Шаг 4: тесты на бинарник, обрезку и границу**

```ts
it("marks a binary file binary instead of handing back an empty patch", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const diff = await readFileDiff({ worktreePath, baseline, path: "pic.bin", maxBytes: 512 * 1024 });

  expect(diff).toMatchObject({ binary: true, patch: null });
});

it("says a patch was truncated and how much was left out", async () => {
  const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

  const diff = await readFileDiff({ worktreePath, baseline, path: "mod.txt", maxBytes: 20 });

  expect(diff.truncated).toBe(true);
  expect(diff.omittedBytes).toBeGreaterThan(0);
});

it("refuses a path that leaves the worktree, naming the path it refused", async () => {
  const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

  expect(() => resolveWorktreeRelativePath(worktreePath, "../../etc/passwd")).toThrow(
    expect.objectContaining({ requestedPath: "../../etc/passwd" }),
  );
});

it("refuses a sibling directory whose name merely starts with the worktree's", async () => {
  const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

  expect(() => resolveWorktreeRelativePath(worktreePath, `${worktreePath}-evil/secret.txt`)).toThrow(
    PathOutsideWorktreeError,
  );
});
```

- [ ] **Шаг 5: мутация**

Заменить сравнение по разделителю на `resolved.startsWith(worktreePath)` → тест на соседний каталог
краснеет утверждением `expected [Function] to throw PathOutsideWorktreeError`. Затем убрать признак
`truncated` (всегда `false`) → краснеет тест обрезки. Вернуть оба. Записать в отчёт.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/workspace/src/changes.ts packages/workspace/test/changes.integration.test.ts
git commit -m "feat(workspace): read one file's diff, and refuse a path that leaves the worktree"
```

---

## Задача 3: контракт

**Файлы:**

- Изменить: `packages/contracts/src/workspace.ts`
- Тест: `packages/contracts/test/workspace.unit.test.ts`

**Интерфейсы — производит:**

```ts
export const changedFileSchema: z.ZodType<{ … }>;          // .strict()
export const workItemChangeSummarySchema: z.ZodType<{ … }>; // schemaVersion, baseline, files, truncated
export const fileDiffSchema: z.ZodType<{ … }>;              // schemaVersion, path, baseline, binary, patch, truncated, omittedBytes
```

Границы задаются здесь, а не в демоне: `path` — до 4096 символов, как `carriedPathsSchema` рядом;
`insertions` и `deletions` — неотрицательные целые **или** `null`; `patch` — строка или `null`;
`omittedBytes` — неотрицательное целое. `baseline` — `commitShaSchema`, ненулевой: сводка без базы
бессмысленна.

- [ ] **Шаг 1: тест на то, что схема не принимает ноль вместо `null` у бинарного файла**

```ts
it("keeps a binary file's line counts null, so zero cannot be read as `nothing changed`", () => {
  const parsed = changedFileSchema.parse({
    path: "pic.bin",
    previousPath: null,
    status: "MODIFIED",
    insertions: null,
    deletions: null,
    binary: true,
  });

  expect(parsed.insertions).toBeNull();
});

it("refuses a file record carrying an unknown field", () => {
  expect(() =>
    changedFileSchema.parse({
      path: "a.txt",
      previousPath: null,
      status: "MODIFIED",
      insertions: 1,
      deletions: 1,
      binary: false,
      hunks: [],
    }),
  ).toThrow();
});
```

- [ ] **Шаг 2: прогнать, убедиться в красноте** — схемы не существует.

- [ ] **Шаг 3: реализация** — три схемы, `.strict()` на каждой, экспорт из `contracts/src/index.ts`
      уже покрыт существующим `export * from "./workspace.js"`.

- [ ] **Шаг 4: мутация** — снять `.strict()` с `changedFileSchema` → тест на неизвестное поле
      краснеет утверждением `expected [Function] to throw`. Вернуть.

- [ ] **Шаг 5: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/contracts/src/workspace.ts packages/contracts/test/workspace.unit.test.ts
git commit -m "feat(contracts): give a work item's changes a shape"
```

---

## Задача 4: две ручки демона

**Файлы:**

- Изменить: `apps/daemon/src/server.ts`
- Тест: `apps/daemon/test/server.integration.test.ts`

**Интерфейсы — потребляет:** `summariseChanges`, `readFileDiff`, `resolveWorktreeRelativePath`,
`PathOutsideWorktreeError` (Задачи 1–2); `workItemChangeSummarySchema`, `fileDiffSchema` (Задача 3).

Маршруты, в стиле существующих (`requireSession`, `sendOperationError`, разбор параметров схемой):

```text
GET /api/v1/work-items/:workItemId/changes
GET /api/v1/work-items/:workItemId/changes/diff?path=<путь>
```

Рабочая область читается существующим запросом `GET_WORKSPACE_BY_WORK_ITEM`. База — `snapshotCommit
?? baseCommit` (спека D1). Рабочей области нет → пустой ответ с базой `null` и признаком, что области
нет; каталог исчез → отказ.

- [ ] **Шаг 1: тест на то, что перенесённая работа владельца не приписывается задаче**

Это тест решения D1 — самый ценный из четырёх, потому что дефект здесь выглядит как правдоподобный
результат.

```ts
it("does not report the owner's carried-in work as something the task changed", async () => {
  const { daemon, session, workItemId } = await daemonWithWorkspaceCarryingUncommittedWork();

  const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/changes`, {
    headers: { cookie: session.cookie },
  });
  const body = workItemChangeSummarySchema.parse(await response.json());

  expect(body.files.map((file) => file.path)).not.toContain("owner-was-editing.txt");
});
```

- [ ] **Шаг 2: прогнать, убедиться в красноте** — 404 на несуществующем маршруте.

- [ ] **Шаг 3: реализация обеих ручек**

- [ ] **Шаг 4: тесты на отказы**

```ts
it("refuses a path outside the workspace, naming the path", async () => {
  const { daemon, session, workItemId } = await daemonWithWorkspace();

  const response = await fetch(
    `${daemon.baseUrl}/api/v1/work-items/${workItemId}/changes/diff?path=${encodeURIComponent("../../etc/passwd")}`,
    { headers: { cookie: session.cookie } },
  );

  expect(response.status).toBe(400);
  expect((await response.json()).message).toContain("../../etc/passwd");
});

it("refuses rather than reporting an empty summary when the worktree is gone", async () => {
  const { daemon, session, workItemId, worktreePath } = await daemonWithWorkspace();
  await rm(worktreePath, { recursive: true, force: true });

  const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/changes`, {
    headers: { cookie: session.cookie },
  });

  expect(response.status).toBe(409);
});

it("requires a session", async () => {
  const { daemon, workItemId } = await daemonWithWorkspace();

  const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/changes`);

  expect(response.status).toBe(401);
});
```

- [ ] **Шаг 5: мутация**

Заменить базу на `workspace.baseCommit` → тест Шага 1 краснеет утверждением `expected [
'owner-was-editing.txt', … ] not to contain 'owner-was-editing.txt'`. Затем вернуть пустую сводку
вместо отказа при исчезнувшем worktree → краснеет `expected 200 to be 409`. Вернуть оба.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add apps/daemon/src/server.ts apps/daemon/test/server.integration.test.ts
git commit -m "feat(daemon): serve what a work item changed, and one file's diff"
```

---

## Задача 5: метка конца стадии

**Файлы:**

- Создать: `packages/persistence-sqlite/migrations/0012_stage_attempt_result_tree.sql`
- Изменить: `packages/contracts/src/workflow.ts`, `packages/persistence-sqlite/src/index.ts`,
  `apps/daemon/src/session-loop.ts`
- Тест: `packages/persistence-sqlite/test/local-state.integration.test.ts`,
  `apps/daemon/test/server.integration.test.ts`, `apps/daemon/test/daemon-fixtures.ts`

Миграция добавляет `result_tree TEXT` к `stage_attempts`, nullable, без значения по умолчанию.
Существующие записи остаются `null` навсегда — это факт «дерево не фиксировалось», а не пропуск
(спека §12.3). Контракт получает `resultTree: commitShaSchema.nullable()` на `stageAttemptSchema`.

Демон на завершении стадии зовёт `summariseChanges` и пишет `summary.tree` в той же транзакции, что
и завершение. Не удалось прочитать (рабочей области уже нет) — пишется `null` и запись в лог; отказ
стадии из-за метки недопустим: метка служебная, а стадия — работа владельца.

- [ ] **Шаг 1: тест на запись метки**

```ts
it("records the tree a stage ended on, so a later diff has a point to measure from", async () => {
  const { daemon, session, workItemId } = await daemonWithWorkspace();
  await runOneStageThatChangesAFile(daemon, session, workItemId);

  const snapshot = await getWorkflowSnapshot(daemon, session, workItemId);

  expect(snapshot.stageAttempts.at(-1)?.resultTree).toMatch(/^[0-9a-f]{40}$/);
});

it("completes the stage even when the tree could not be recorded", async () => {
  const { daemon, session, workItemId, worktreePath } = await daemonWithWorkspace();
  await rm(worktreePath, { recursive: true, force: true });

  const snapshot = await runOneStageAndRead(daemon, session, workItemId);

  expect(snapshot.stageAttempts.at(-1)?.status).not.toBe("FAILED");
  expect(snapshot.stageAttempts.at(-1)?.resultTree).toBeNull();
});
```

Хелперы `runOneStageThatChangesAFile`, `runOneStageAndRead` и `getWorkflowSnapshot` — новые, в
`apps/daemon/test/daemon-fixtures.ts`, рядом с существующими: они поднимают демон на mock-адаптере,
прогоняют одну стадию и читают снимок workflow существующей ручкой. `openStateMigratedTo`,
`migrateTo`, `insertStageAttempt` и `readStageAttempt` — новые хелперы в
`packages/persistence-sqlite/test/local-state.integration.test.ts`: миграций до заданного номера в
тестах пакета сейчас нет, и это первый случай, которому они нужны.

- [ ] **Шаг 2: прогнать, убедиться в красноте** — поля `resultTree` в снимке нет.

- [ ] **Шаг 3: миграция, контракт, запись в демоне**

- [ ] **Шаг 4: тест на то, что миграция не ломает существующие записи**

```ts
it("leaves stage attempts recorded before this migration with a null result tree", async () => {
  const state = await openStateMigratedTo("0011");
  const attemptId = await insertStageAttempt(state);

  await migrateTo(state, "0012");

  expect(readStageAttempt(state, attemptId).resultTree).toBeNull();
});
```

- [ ] **Шаг 5: мутация**

Сделать запись метки бросающей при исчезнувшем worktree → тест «завершает стадию» краснеет
утверждением `expected 'FAILED' not to be 'FAILED'`. Вернуть.

- [ ] **Шаг 6: `pnpm verify`, `pnpm build`, коммит**

```bash
git add packages/persistence-sqlite/migrations/0012_stage_attempt_result_tree.sql packages/persistence-sqlite/src/index.ts packages/persistence-sqlite/test/local-state.integration.test.ts packages/contracts/src/workflow.ts apps/daemon/src/session-loop.ts apps/daemon/test/server.integration.test.ts apps/daemon/test/daemon-fixtures.ts
git commit -m "feat(persistence): record the tree a stage ended on"
```

---

## Задача 6: секция изменений в карточке

**Файлы:**

- Создать: `apps/web/src/views/ChangesSection.tsx`
- Изменить: `apps/web/src/api.ts`, `apps/web/src/views/WorkbenchPage.tsx`, `apps/web/src/i18n.tsx`
- Тест: `e2e/walking-skeleton.spec.ts`

**Интерфейсы — производит:**

```ts
export const getWorkItemChanges = async (workItemId: string) => …;      // api.ts
export const getWorkItemFileDiff = async (workItemId: string, path: string) => …;
```

Обе через существующий `requestLocalApi(path, schema)`; путь уходит в query через
`encodeURIComponent`. Ключи i18n в существующем стиле точечной нотации: `changes.title`,
`changes.empty`, `changes.truncated`, `changes.binary`, `changes.patchTruncated`, `changes.status.added`
и так далее — EN и RU обе, иначе `i18n.test.ts` покраснеет на неполном словаре.

Секция: список файлов со статусом и `+N / −M`, клик разворачивает тело. Бинарный файл не
разворачивается и назван бинарным. Обрезка названа явно — и сводки, и тела.

- [ ] **Шаг 1: браузерный тест**

```ts
test("names the file a stage changed and shows its diff when expanded", async ({ page }) => {
  await startPipelineOnFixture(page);
  await expect(page.getByRole("button", { name: /mod\.txt/ })).toBeVisible();

  await page.getByRole("button", { name: /mod\.txt/ }).click();

  await expect(page.getByText("+changed")).toBeVisible();
});
```

- [ ] **Шаг 2: реализация**

- [ ] **Шаг 3: мутация** — вернуть из `getWorkItemChanges` пустой список → тест краснеет по
      отсутствию `mod.txt` (`expected locator to be visible`). Вернуть.

- [ ] **Шаг 4: `pnpm verify`, `pnpm test:e2e`, коммит**

```bash
git add apps/web/src/views/ChangesSection.tsx apps/web/src/views/WorkbenchPage.tsx apps/web/src/api.ts apps/web/src/i18n.tsx e2e/walking-skeleton.spec.ts
git commit -m "feat(web): show the files a task changed, and the diff inside them"
```

---

## Задача 7: обновление по событиям и измерение дебаунса

**Файлы:**

- Изменить: `apps/web/src/views/ChangesSection.tsx`
- Тест: `apps/web/src/views/ChangesSection.test.ts`, `e2e/walking-skeleton.spec.ts`

Пока карточка открыта, событие стадии из существующего канала (`useEventStream`) вызывает
перечитывание сводки, не чаще `SUMMARY_REFRESH_DEBOUNCE_MS`. Тело перечитывается только для
развёрнутого файла. Закрытая карточка не перечитывает ничего.

- [ ] **Шаг 1: тест на дебаунс**

```ts
it("reads the summary once for a burst of events, not once per event", async () => {
  const read = vi.fn().mockResolvedValue(emptySummary);
  const debounced = makeSummaryRefresher(read, 750);

  debounced();
  debounced();
  debounced();
  await vi.advanceTimersByTimeAsync(800);

  expect(read).toHaveBeenCalledTimes(1);
});
```

- [ ] **Шаг 2: прогнать, убедиться в красноте** — `makeSummaryRefresher is not a function`.

- [ ] **Шаг 3: реализация**

- [ ] **Шаг 4: браузерный тест на то, что список пополняется сам**

```ts
test("grows the change list while the stage is still running, without a reload", async ({ page }) => {
  await startPipelineOnFixture(page);
  await expect(page.getByRole("button", { name: /mod\.txt/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /added\.txt/ })).toBeVisible();
});
```

- [ ] **Шаг 5: мутация** — убрать дебаунс (звать `read` напрямую) → тест Шага 1 краснеет
      утверждением `expected "read" to be called 1 times, but got 3 times`. Вернуть.

- [ ] **Шаг 6: измерить пределы**

Прогнать `summariseChanges` на настоящем большом репозитории (подойдёт чекаут самого Loomrail с
`node_modules` на месте) и записать в отчёт время одного вызова. Если оно превышает
`SUMMARY_REFRESH_DEBOUNCE_MS`, дебаунс поднимается до измеренного значения, и число в разделе
«Пределы» правится вместе с обоснованием. Не измерив — не менять.

- [ ] **Шаг 7: `pnpm verify`, `pnpm test:e2e`, коммит**

```bash
git add apps/web/src/views/ChangesSection.tsx apps/web/src/views/ChangesSection.test.ts e2e/walking-skeleton.spec.ts
git commit -m "feat(web): keep the change list current while the stage runs"
```

---

## Задача 8: документы догоняют код

**Файлы:**

- Изменить: `README.md`, `docs/plans/15-e1-5-change-visibility-spec.ru.md`

- [ ] **Шаг 1: README** — строка «Agents» в «Current checkpoint» теряет из «Next» видимость
      рабочей области, потому что она уже есть. В разделе про адаптеры — одно предложение о том, что
      состав изменений и дифф видны в карточке, и что Loomrail по-прежнему ничего не коммитит.

- [ ] **Шаг 2: правки спеки** — каждое место, где реализация разошлась со спекой, блоком `ПРАВКА`
      внутри соответствующего раздела, а не молчаливым переписыванием. Измеренные в Задаче 7 числа
      попадают в §12.1 как измеренные, а не выбранные.

- [ ] **Шаг 3: `pnpm verify`, коммит**

```bash
git add README.md docs/plans/15-e1-5-change-visibility-spec.ru.md
git commit -m "docs(e1-5): say what the owner can now see, and what is still not committed"
```

---

## Само-ревью плана

**Покрытие спеки.** D1 — Задача 4 (тест и мутация). D2 — Задача 1 (тест, мутация, глобальное
ограничение). D3 — Задачи 1 и 5. D4 — Задача 1, `readArgs`. D5 — Задачи 1 и 2 раздельно. D6 —
Задача 7. D7 — Задача 4 (отказ вместо пустой сводки). D8 — Задачи 2 и 6. D9 — Задача 2. D10 —
глобальное ограничение и `finally` в Задаче 1. D11 — в плане нет ни одной задачи, пишущей дифф в
состояние, и это намеренно.

Критерии приёмки спеки §10: 1 → Задача 1 Шаг 1; 2 → Задача 1 Шаг 4; 3 → Задача 4 Шаг 1; 4 → Задача 1
Шаг 4; 5 → Задачи 1 и 2; 6 → Задача 2 Шаг 4; 7 → Задачи 2 и 4; 8 → Задача 4 Шаг 4; 9 → Задача 5;
10 → Задача 7.

**Согласованность имён.** `summariseChanges`, `readFileDiff`, `resolveWorktreeRelativePath`,
`PathOutsideWorktreeError`, `ChangeSummary.tree`, `FileDiff.omittedBytes`, `resultTree` — по одному
написанию на всё, включая тесты и ручки.

**Незакрытое.** §2.3 спеки называет непроверенным поведение на Windows (`core.autocrlf`) и в
worktree посреди конфликта. План этого не закрывает: первое проверяется существующим гейтом Windows
CI на Задаче 1, второе остаётся известным пробелом и должно быть названо в отчёте Задачи 8, а не
тихо пропущено.
