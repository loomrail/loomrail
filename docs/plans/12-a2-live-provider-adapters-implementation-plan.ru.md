# A2 — Живые адаптеры Codex и Claude Code: план реализации

> **Для исполнителей-агентов:** ОБЯЗАТЕЛЬНАЯ ПОД-СКИЛЛ: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).

**Цель:** заменить синтетического провайдера двумя живыми адаптерами поверх локально установленных
CLI и закрыть четыре места, где контракт предполагал двойника.

**Архитектура:** один общий модуль запускает дочерний процесс, режет его stdout на строки, держит
крайний срок и гарантирует смерть процесса; поверх него два адаптера переводят собственные потоки
событий Codex и Claude в контракт `ProviderAdapter`. Симметрии между ними не добиваемся —
`capabilities()` объявляет то, что CLI действительно умеет.

**Технологии:** TypeScript strict, `node:child_process`, Zod 4, Vitest. Никаких новых зависимостей.

**Спек:** [`docs/plans/11-a2-live-provider-adapters-spec.ru.md`](11-a2-live-provider-adapters-spec.ru.md) — читается вместе с планом.

## Глобальные ограничения

- **Не коммитить и не пушить без явной просьбы человека.** Шаги «Commit» исполняются, только если
  разрешение дано на эту сессию.
- **Окружение каждой сессии:** `nvm use` (`.nvmrc` = 24.19.0), затем `corepack enable`.
- **Shell — zsh.** Незакавыченная переменная не разбивается на слова; пути в git-командах писать инлайном.
- **В репозитории работает параллельная сессия.** Перед каждым коммитом сверять `git status` и стейджить
  поимённо. Никогда `git add .`, `git add -A`, `git add packages`. Для файла, который держит и она,
  собирать патч только из своих ханков и применять `git apply --cached`.
- **Никаких новых зависимостей.** Запуск процессов — `node:child_process`, разбор — Zod.
- **НИКОГДА не строить команду с флагом обхода разрешений.** Ни `--dangerously-skip-permissions`,
  ни `--allow-dangerously-skip-permissions`, ни `--dangerously-bypass-approvals-and-sandbox`,
  ни `--permission-mode bypassPermissions`. SD-001 запрещает это прямо; задача 11 закрепляет запрет тестом.
- **TypeScript strict, никаких `any`** в продуктовом коде и публичных тестах. Именованные экспорты,
  `type` для форм данных, никаких non-null assertions, исчерпывающие switch.
- **Только `packages/persistence-sqlite` импортирует `node:sqlite`.** Не импортировать из `apps/*` в `packages/*`.
- **Никаких `console.log`** в продуктовых путях — структурный логгер с редактированием полей.
- **Форматирование принадлежит committed Prettier config:** двойные кавычки, точки с запятой, висячие
  запятые, `printWidth` 110.
- **Каждый тест сдаётся с доказательством мутацией:** сломать реализацию, убедиться, что тест краснеет
  **по утверждению**, а не по таймауту стенда или падению в setup, восстановить. За три milestone
  сюда приехало пятнадцать тестов, не способных упасть под названным дефектом.
- **Тесты адаптеров идут против записанных потоков**, снятых с настоящих CLI, а не против выдуманных
  фикстур: форма событий установлена разведкой и обязана оставаться проверяемой без сети и без квоты владельца.
- **После изменений:** `pnpm verify`, затем `pnpm test:e2e`, затем `git diff --check`. Контроллер гоняет
  их на чистом worktree — в рабочем дереве лежит незаконченная работа параллельной сессии.
- **Миграции:** применённую не редактировать, добавлять новую. Базу пользователя не сбрасывать; для
  проверок открывать её только read-only через `node:sqlite`, копировать только backup API, **никогда `cp`**
  (WAL держит данные, которых нет в основном файле).

## Порядок работ

Задача 1 — разведка, и она первая не по вежливости: от её ответа зависит, какую способность объявит
адаптер Claude в задаче 8, и переделывать это позже дороже, чем узнать сейчас.

Задачи 2–4 готовят контракт и общий механизм; 5–6 дают Codex, 7–8 — Claude; 9–11 закрывают жизненный
цикл процесса, безопасность и документы.

## Карта файлов

**Создаются:**

| Файл                                                      | Ответственность                                          |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `packages/provider-core/src/process-runner.ts`            | запуск процесса, построчный stdout, крайний срок, смерть |
| `packages/provider-core/test/process-runner.unit.test.ts` | его тесты                                                |
| `packages/provider-codex/**`                              | адаптер Codex (по образцу `packages/provider-mock`)      |
| `packages/provider-claude-code/**`                        | адаптер Claude Code                                      |
| `packages/provider-*/test/recordings/*.jsonl`             | записанные потоки настоящих CLI                          |

**Изменяются:** `packages/provider-core/src/index.ts` (контракт), `packages/contracts/src/workflow.ts`
(`ProviderUsage`), `packages/provider-mock/src/index.ts` (новые поля capabilities),
`packages/domain/src/workflow.ts` (гейт по стадиям), `apps/daemon/src/session-loop.ts` (`onUsage`),
`apps/daemon/src/server.ts` (выбор адаптера), `docs/security/THREAT-MODEL.md`,
`docs/plans/06-post-phase-0-decomposition.ru.md`.

## Тестовое обвязывание, которое пишет исполнитель

Код задач ссылается на помощники, которых в репозитории нет и которые не заслуживают отдельной задачи:
`recordSpawn()` — перехват аргументов запуска без настоящего процесса; `startWith(spawned, adapter)`;
`runAgainstRecording(file, listener?, options?)` — прогон адаптера против записанного потока вместо живого
CLI; `fakeCodexPath` / `fakeClaudePath` — исполняемый файл-заглушка. Их пишет исполнитель той задачи, где
они впервые понадобились, в её же тестовом файле; следующая задача переиспользует, а не копирует. Если
помощник понадобился двум пакетам — вынести в отдельный модуль внутри `test/`, никогда в `src/`.

## Именованные константы

```ts
const PROCESS_TERMINATION_GRACE_MS = 5_000; // между сигналом завершения и безусловным убийством
const SESSION_DEADLINE_MS = 600_000; // предел жизни одной сессии провайдера
const MAX_STREAM_LINE_BYTES = 1_000_000; // строка длиннее считается мусором и отбрасывается
```

---

### Задача 1: РАЗВЕДКА — умеет ли Claude принимать сообщение в идущую сессию

**Файлы:** ничего в репозитории. Результат — отчёт.

**Почему первой.** Спек §7 оставляет ровно одно место, опирающееся на документацию флага, а не на
наблюдение: `--input-format stream-json`. Если он действительно позволяет впрыснуть сообщение в идущую
сессию, адаптер Claude объявляет `checkpointOnRequest: true` и превентивный рез §6.2 A1 работает как
задумано. Если нет — способность объявляется `false`, и адаптер ведёт себя как Codex.

**Это тратит квоту владельца.** Один короткий диалог, не больше.

- [ ] **Шаг 1: убедиться, что CLI авторизован**

```bash
claude -p "Reply with exactly the word: ok" --output-format json < /dev/null
```

В ответе должно быть `"is_error": false`. Если пришло `"Not logged in"` — **остановись и сообщи
контроллеру**; разведку выполняет человек, а не агент, и подставлять учётные данные нельзя.

- [ ] **Шаг 2: попытаться впрыснуть второе сообщение в идущую сессию**

Запустить `claude -p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages`, подать первым сообщением задачу, которая заведомо займёт несколько ходов
(например «посчитай до двадцати, по одному числу за сообщение»), затем **во время работы** подать вторым
сообщением просьбу немедленно свернуться и подвести итог.

Формат входных сообщений — тот же JSONL, что и на выходе: объект с `type: "user"` и полем `message`.
Точную форму подтвердить по первому кадру `--replay-user-messages`, а не угадывать.

- [ ] **Шаг 3: записать наблюдения**

Ответить на три вопроса фактами, не впечатлением:

1. доходит ли второе сообщение до идущей сессии (виден ли его повтор через `--replay-user-messages`);
2. меняет ли оно поведение — сворачивается ли агент;
3. сохранить сырой поток в файл: он станет фикстурой задачи 8.

- [ ] **Шаг 4: отчёт**

Вывод одной строкой: `checkpointOnRequest` для Claude — `true` или `false`. Приложить сырой поток.
Если `false`, задача 8 объявляет способность `false` и не строит впрыск.

---

### Задача 2: идентичность провайдера и расширенные capabilities

**Файлы:**

- Изменить: `packages/provider-core/src/index.ts`
- Изменить: `packages/provider-mock/src/index.ts`
- Тест: `packages/provider-core/test/contract.unit.test.ts`

**Интерфейсы:**

- Производит:
  ```ts
  export const providerIdSchema = z.enum(["MOCK", "CODEX", "CLAUDE_CODE"]);
  export type ProviderId = z.infer<typeof providerIdSchema>;
  // providerCapabilitiesSchema дополняется:
  //   provider: providerIdSchema          (было z.literal("MOCK"))
  //   stages: z.array(workflowStageSchema).min(1)
  //   costReporting: z.boolean()
  ```
  потребляется задачами 4, 6, 8

**Почему `stages` — часть capabilities, а не конфигурации.** До E1 живой адаптер физически не может
обслуживать IMPLEMENT: он не касается репозитория. Без объявления диспетчер отправит ему эту стадию, он
вернёт текст, и всё будет выглядеть работающим — ровно «контрол без поведения за ним».

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("accepts a live provider identity", () => {
  expect(providerCapabilitiesSchema.parse({ ...validCapabilities, provider: "CODEX" }).provider).toBe(
    "CODEX",
  );
});

it("rejects a provider identity outside the enum", () => {
  expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, provider: "GPT" })).toThrow();
});

// An adapter that serves no stage can never be dispatched to; declaring one is not optional.
it("rejects capabilities that declare no stage at all", () => {
  expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, stages: [] })).toThrow();
});

it("rejects an unknown stage", () => {
  expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, stages: ["DEPLOY"] })).toThrow();
});
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

`pnpm --filter @loomrail/provider-core test` — ожидается FAIL на неизвестном поле `stages`.

- [ ] **Шаг 3: реализовать**

Заменить `provider: z.literal("MOCK")` на `provider: providerIdSchema`, добавить `stages` и
`costReporting`. В `provider-mock` объявить `provider: "MOCK"`, `stages` — все шесть стадий шаблона,
`costReporting: false`.

- [ ] **Шаг 4: прогнать и починить потребителей**

`pnpm --filter @loomrail/provider-core test`, затем `pnpm --filter @loomrail/provider-mock test`,
затем `pnpm --filter @loomrail/daemon test`. Существующие тесты, строящие capabilities вручную,
получат новые обязательные поля — это ожидаемо.

- [ ] **Шаг 5: доказательство мутацией**

Вернуть `provider: z.literal("MOCK")` → падает «accepts a live provider identity». Убрать `.min(1)`
у `stages` → падает «rejects capabilities that declare no stage at all». Восстановить.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-core/src/index.ts packages/provider-core/test/contract.unit.test.ts packages/provider-mock/src/index.ts
git commit -m "feat(provider-core): let an adapter declare who it is and what it can serve"
```

---

### Задача 3: канал расхода — `ProviderUsage` и `onUsage`

**Файлы:**

- Изменить: `packages/contracts/src/workflow.ts` (схема `providerUsageSchema`)
- Изменить: `packages/provider-core/src/index.ts` (`ProviderSessionListener`)
- Тест: `packages/contracts/test/workflow.unit.test.ts`

**Интерфейсы:**

- Производит:
  ```ts
  export const providerUsageSchema = z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      reasoningOutputTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      quality: usageQualitySchema,
    })
    .strict();
  export type ProviderUsage = z.infer<typeof providerUsageSchema>;
  // ProviderSessionListener += onUsage: (usage: ProviderUsage) => void
  ```
  потребляется задачами 6, 8 и вызывается из `apps/daemon/src/session-loop.ts`

**Почему отдельный канал, а не поле в `ContextWindowUsage`.** Занятость окна ведёт к handoff, расход
ведёт к бюджетным порогам BD-001 и к HARD-паузе. Это разные величины с разными потребителями, и
складывать их в один канал значит обязать потребителя одного разбирать другое.

- [ ] **Шаг 1: написать падающие тесты**

```ts
const validUsage = { inputTokens: 1200, outputTokens: 340, quality: "ACTUAL" } as const;

it("accepts a report without cost, because not every provider reports one", () => {
  expect(providerUsageSchema.parse(validUsage)).toEqual(validUsage);
});

it("accepts a report with cost", () => {
  expect(providerUsageSchema.parse({ ...validUsage, costUsd: 0.0412 }).costUsd).toBeCloseTo(0.0412);
});

// Each negative case breaks exactly one field of the proven-valid fixture, so a failure names the
// rule that broke rather than "something in this object is wrong".
it("rejects a negative token count", () => {
  expect(() => providerUsageSchema.parse({ ...validUsage, outputTokens: -1 })).toThrow();
});

it("rejects a fractional token count", () => {
  expect(() => providerUsageSchema.parse({ ...validUsage, inputTokens: 1.5 })).toThrow();
});

it("rejects a field beyond the schema, so a provider cannot smuggle content through usage", () => {
  expect(() => providerUsageSchema.parse({ ...validUsage, transcript: "…" })).toThrow();
});
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

`pnpm --filter @loomrail/contracts test` — FAIL, схемы нет.

- [ ] **Шаг 3: реализовать схему и добавить `onUsage` в слушатель**

- [ ] **Шаг 4: прогнать**

`pnpm --filter @loomrail/contracts test`, `pnpm --filter @loomrail/provider-core typecheck`.

- [ ] **Шаг 5: доказательство мутацией**

Убрать `.strict()` → падает «rejects a field beyond the schema». Заменить `.int()` на ничего →
падает «rejects a fractional token count». Восстановить.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/contracts/src/workflow.ts packages/contracts/test/workflow.unit.test.ts packages/provider-core/src/index.ts
git commit -m "feat(contracts): give a provider a way to report what it spent"
```

---

### Задача 4: общий запускатель процессов

**Файлы:**

- Создать: `packages/provider-core/src/process-runner.ts`
- Создать: `packages/provider-core/test/process-runner.unit.test.ts`
- Изменить: `packages/provider-core/src/index.ts` (экспорт)

**Интерфейсы:**

- Производит:
  ```ts
  export type ProcessRun = {
    /** Resolves only after the child has actually exited. */
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly pid: number | undefined;
    /** Terminate signal, grace period, then unconditional kill. Idempotent. */
    stop: () => Promise<void>;
  };
  export const runProcess: (options: {
    command: string;
    args: readonly string[];
    cwd: string;
    onLine: (line: string) => void;
    onStderr: (line: string) => void;
    deadlineMs: number;
    graceMs?: number;
  }) => ProcessRun;
  ```
  потребляется задачами 6 и 8

**Три вещи, которые этот модуль обязан делать правильно, потому что оба адаптера на них стоят.**

_stdin закрывается._ Разведка установила: `codex exec` читает stdin даже при позиционном промпте и виснет,
если его не закрыть. Запуск идёт с `stdio: ["pipe", "pipe", "pipe"]`, и stdin закрывается сразу после
записи промпта (или немедленно, если промпт передан аргументом).

_Строки собираются, а не предполагаются._ stdout приходит кусками, не совпадающими с границами строк.
Буфер накапливается до `\n`; строка длиннее `MAX_STREAM_LINE_BYTES` отбрасывается с записью, чтобы
испорченный поток не съел память.

_`exited` резолвится по факту выхода._ Не по `stop()`, не по закрытию потоков — по событию `exit`. Это
несущее: спек §8 требует, чтобы `abortSession` резолвился только после подтверждённого выхода, а A1.5
оставил это как известную дыру именно до сюда.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// A real child process, not a double: the thing under test IS the process boundary.
const node = process.execPath;

it("delivers stdout as whole lines even when the child writes them in pieces", async () => {
  const lines: string[] = [];
  const run = runProcess({
    command: node,
    args: ["-e", `process.stdout.write("{\\"a\\":1}\\n{\\"b\\":"); process.stdout.write("2}\\n");`],
    cwd: process.cwd(),
    onLine: (line) => lines.push(line),
    onStderr: () => undefined,
    deadlineMs: 10_000,
  });
  await run.exited;
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

// The claim A1.5 deferred to this milestone: resolving is not the same as having stopped.
it("resolves `exited` only after the child has really gone", async () => {
  const run = runProcess({
    command: node,
    args: ["-e", "setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    onLine: () => undefined,
    onStderr: () => undefined,
    deadlineMs: 30_000,
    graceMs: 200,
  });
  let exited = false;
  void run.exited.then(() => {
    exited = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(exited).toBe(false);
  await run.stop();
  expect(exited).toBe(true);
});

it("kills a child that ignores the terminate signal", async () => {
  const run = runProcess({
    command: node,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    onLine: () => undefined,
    onStderr: () => undefined,
    deadlineMs: 30_000,
    graceMs: 200,
  });
  await run.stop();
  const outcome = await run.exited;
  expect(outcome.signal).toBe("SIGKILL");
});

it("stops a child that produces nothing once its deadline passes", async () => {
  const run = runProcess({
    command: node,
    args: ["-e", "setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    onLine: () => undefined,
    onStderr: () => undefined,
    deadlineMs: 150,
    graceMs: 100,
  });
  const outcome = await run.exited;
  expect(outcome.code === null || outcome.code !== 0).toBe(true);
});

it("is safe to stop twice", async () => {
  const run = runProcess({
    command: node,
    args: ["-e", "setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    onLine: () => undefined,
    onStderr: () => undefined,
    deadlineMs: 30_000,
    graceMs: 100,
  });
  await run.stop();
  await expect(run.stop()).resolves.toBeUndefined();
});

it("drops a line longer than the cap instead of buffering it forever", async () => {
  const lines: string[] = [];
  const run = runProcess({
    command: node,
    args: ["-e", `process.stdout.write("x".repeat(1_100_000) + "\\nkept\\n");`],
    cwd: process.cwd(),
    onLine: (line) => lines.push(line),
    onStderr: () => undefined,
    deadlineMs: 20_000,
  });
  await run.exited;
  expect(lines).toEqual(["kept"]);
});
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

`pnpm --filter @loomrail/provider-core test` — FAIL, модуля нет.

- [ ] **Шаг 3: реализовать**

`spawn` из `node:child_process`; буфер строк на stdout и stderr; `unref` не использовать — процесс
обязан удерживать демона до своего конца; таймер крайнего срока с `unref`, чтобы он сам не удерживал.
`stop()` идемпотентен: первый вызов шлёт `SIGTERM`, взводит таймер `graceMs`, по истечении шлёт
`SIGKILL`; повторные вызовы возвращают то же обещание.

- [ ] **Шаг 4: прогнать**

`pnpm --filter @loomrail/provider-core test` — все шесть проходят.

- [ ] **Шаг 5: доказательства мутацией**

1. Резолвить `exited` из `stop()` вместо события `exit` → падает «resolves `exited` only after the child
   has really gone».
2. Убрать эскалацию до `SIGKILL` → падает «kills a child that ignores the terminate signal».
3. Отдавать куски stdout как есть, без сборки строк → падает «delivers stdout as whole lines».
4. Убрать предел длины строки → падает «drops a line longer than the cap».

Для каждой указать, было ли падение утверждением.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-core/src/process-runner.ts packages/provider-core/test/process-runner.unit.test.ts packages/provider-core/src/index.ts
git commit -m "feat(provider-core): run a child process and know when it is really gone"
```

---

### Задача 5: разбор потока Codex

**Файлы:**

- Создать: `packages/provider-codex/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Создать: `packages/provider-codex/src/stream.ts`
- Создать: `packages/provider-codex/test/stream.unit.test.ts`
- Создать: `packages/provider-codex/test/recordings/hello.jsonl`

**Интерфейсы:**

- Производит: `parseCodexEvent(line: string): CodexEvent | null` — `null` для строки, которую нельзя
  использовать; потребляется задачей 6

**Записанный поток.** Форма установлена разведкой на настоящем CLI и кладётся в
`test/recordings/hello.jsonl` дословно:

```jsonl
{"type":"thread.started","thread_id":"01a03f5e-5a0d-7823-8aa5-e7183a2e42c0"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":17854,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}
```

- [ ] **Шаг 1: завести пакет по образцу `packages/provider-mock`**

Скопировать четыре конфигурационных файла, поменять имя на `@loomrail/provider-codex`. Зависимости —
`@loomrail/contracts` и `@loomrail/provider-core`.

- [ ] **Шаг 2: написать падающие тесты**

```ts
it("reads the recorded stream of a real run", () => {
  const events = readFileSync(recordingPath, "utf8").split("\n").filter(Boolean).map(parseCodexEvent);
  expect(events.map((event) => event?.type)).toEqual([
    "thread.started",
    "turn.started",
    "item.completed",
    "turn.completed",
  ]);
});

it("carries the usage a completed turn reports", () => {
  const event = parseCodexEvent(
    '{"type":"turn.completed","usage":{"input_tokens":17854,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
  );
  expect(event).toEqual({
    type: "turn.completed",
    usage: { inputTokens: 17854, cachedInputTokens: 9984, outputTokens: 5, reasoningOutputTokens: 0 },
  });
});

// Provider output is untrusted input: a line that cannot be used is dropped, never thrown on.
it("drops a line that is not JSON", () => {
  expect(parseCodexEvent("Reading additional input from stdin…")).toBeNull();
});

it("drops a JSON line whose shape is not an event", () => {
  expect(parseCodexEvent('{"hello":"world"}')).toBeNull();
});

it("drops a turn.completed whose usage is missing the fields it is read for", () => {
  expect(parseCodexEvent('{"type":"turn.completed","usage":{"input_tokens":"lots"}}')).toBeNull();
});
```

- [ ] **Шаг 3: запустить, убедиться, что падают**

- [ ] **Шаг 4: реализовать разбор через Zod**

Схема на каждый известный тип события, дискриминированное объединение, `safeParse`, `null` при неуспехе.
Ключи snake_case из потока переводятся в camelCase контракта здесь и только здесь.

- [ ] **Шаг 5: прогнать и доказать мутацией**

Заменить `safeParse` на `parse` → падают оба теста про отбрасывание, причём **броском, а не
утверждением**; это и есть демонстрация, зачем `safeParse`. Отметить в отчёте, что падение было
броском, и что тест на это и рассчитан.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-codex
git commit -m "feat(provider-codex): read the event stream a real run produces"
```

---

### Задача 6: адаптер Codex

**Файлы:**

- Создать: `packages/provider-codex/src/index.ts`
- Создать: `packages/provider-codex/test/adapter.unit.test.ts`

**Интерфейсы:**

- Потребляет: `runProcess` (задача 4), `parseCodexEvent` (задача 5), `providerIdSchema`/`stages`
  (задача 2), `ProviderUsage` (задача 3)
- Производит: `createCodexProvider(options?: { command?: string; contextWindowTokens?: number }): ProviderAdapter`

**Команда запуска — дословно, включая то, что установила разведка:**

```text
codex exec --json --skip-git-repo-check -C <пустой временный каталог> -s read-only
           --output-schema <файл со схемой checkpoint>
```

stdin **закрыт**: без этого `codex exec` виснет на «Reading additional input from stdin…».
`--skip-git-repo-check` обязателен: вне доверенного каталога CLI отказывается запускаться.

**Объявляемые способности:**

```ts
{
  provider: "CODEX",
  stages: ["DISCOVERY", "PLAN", "REVIEW"],
  start: true, interrupt: true, eventStream: true,
  usageReporting: true, contextWindowReporting: true,
  costReporting: false,      // стоимости в потоке нет
  checkpointOnRequest: false, // канала внутрь одноразового exec не существует
  contextWindowTokens: <объявляется опцией, по умолчанию консервативно>,
}
```

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("declares itself as Codex and serves only the stages it can serve without a repository", () => {
  const capabilities = createCodexProvider().capabilities();
  expect(capabilities.provider).toBe("CODEX");
  expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "REVIEW"]);
  expect(capabilities.checkpointOnRequest).toBe(false);
});

// Established by probing the real CLI: without these two the adapter either hangs or is refused.
it("runs with stdin closed and the trusted-directory check skipped", async () => {
  const spawned = recordSpawn();
  await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
  expect(spawned.args).toContain("--skip-git-repo-check");
  expect(spawned.stdinClosed).toBe(true);
});

// SD-001 forbids enabling a permission bypass automatically; this is the test, not the convention.
it("never builds a command carrying a permission-bypass flag", async () => {
  const spawned = recordSpawn();
  await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
  expect(spawned.args.join(" ")).not.toContain("dangerously");
});

it("reports the usage of every completed turn", async () => {
  const usages: ProviderUsage[] = [];
  await runAgainstRecording("hello.jsonl", { onUsage: (usage) => usages.push(usage) });
  expect(usages).toEqual([
    {
      inputTokens: 17854,
      outputTokens: 5,
      cachedInputTokens: 9984,
      reasoningOutputTokens: 0,
      quality: "ACTUAL",
    },
  ]);
});

it("reports window occupancy from the input tokens of the last turn", async () => {
  const seen: ContextWindowUsage[] = [];
  await runAgainstRecording(
    "hello.jsonl",
    { onContextWindow: (usage) => seen.push(usage) },
    { contextWindowTokens: 200_000 },
  );
  expect(seen.at(-1)).toEqual({ usedTokens: 17854, windowTokens: 200_000, quality: "ACTUAL" });
});

// requestHandoff is declared unsupported; it must be a no-op rather than an error, because the loop
// calls it whenever the threshold is crossed and cannot know which adapter it is talking to.
it("accepts a handoff request without doing anything and without failing", async () => {
  await expect(createCodexProvider().requestHandoff("providerSession-1")).resolves.toBeUndefined();
});
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

- [ ] **Шаг 3: реализовать**

Пак рендерится в промпт и передаётся аргументом. Временный каталог создаётся на сессию и удаляется в
`finally`. `abortSession` вызывает `stop()` запускателя и **ждёт** `exited`.

- [ ] **Шаг 4: прогнать**

- [ ] **Шаг 5: доказательства мутацией**

1. Убрать `--skip-git-repo-check` → падает соответствующий тест.
2. Не закрывать stdin → падает тест про stdin.
3. Добавить в аргументы `--dangerously-bypass-approvals-and-sandbox` → падает тест про обход разрешений.
4. Не передавать `quality: "ACTUAL"` → падает тест про usage.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-codex
git commit -m "feat(provider-codex): a live adapter that declares what it cannot do"
```

---

### Задача 7: разбор потока Claude Code

**Файлы:**

- Создать: `packages/provider-claude-code/**` (конфигурация по образцу `provider-mock`)
- Создать: `packages/provider-claude-code/src/stream.ts`
- Создать: `packages/provider-claude-code/test/stream.unit.test.ts`
- Создать: `packages/provider-claude-code/test/recordings/not-logged-in.jsonl`

**Интерфейсы:**

- Производит: `parseClaudeEvent(line: string): ClaudeEvent | null`; потребляется задачей 8

**Два факта разведки, на которых стоят два теста.**

_Отказ авторизации приезжает успехом._ Настоящий поток содержит
`{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login",…}`.
Адаптер, ветвящийся по `subtype`, записал бы неудачный логин завершённой сессией — и §6.5 A1 не
сработал бы, потому что «успешная» сессия не считается непродуктивной. Разбор идёт по `is_error`.

_В потоке едут хуки пользователя._ События `hook_started` и `hook_response` несут `stdout` и `stderr`
с машины владельца. Они не события провайдера и не должны попадать ни в исход, ни в записываемый поток.

- [ ] **Шаг 1: положить записанный поток**

Файл `test/recordings/not-logged-in.jsonl` — снятый разведкой поток целиком, включая события хуков.
Перед укладкой **отредактировать любые пути и значения с машины владельца**: фикстура едет в git, а
SD-003 запрещает попадание туда абсолютных личных путей.

- [ ] **Шаг 2: написать падающие тесты**

```ts
it("treats an authentication failure as a failure, even though its subtype says success", () => {
  const event = parseClaudeEvent(
    '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0}',
  );
  expect(event).toEqual({ type: "result", ok: false, text: "Not logged in · Please run /login", costUsd: 0 });
});

it("treats a real success as a success", () => {
  const event = parseClaudeEvent(
    '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.0031}',
  );
  expect(event).toEqual({ type: "result", ok: true, text: "ok", costUsd: 0.0031 });
});

// The user's own hooks stream through here carrying their stdout and stderr. They are not provider
// events, and SD-003 forbids Loomrail recording that text.
it("drops the user's hook events", () => {
  const recorded = readFileSync(recordingPath, "utf8").split("\n").filter(Boolean);
  const kept = recorded.map(parseClaudeEvent).filter((event) => event !== null);
  expect(kept.some((event) => JSON.stringify(event).includes("hook"))).toBe(false);
});

it("drops a line that is not JSON", () => {
  expect(parseClaudeEvent("some warning printed by a wrapper")).toBeNull();
});
```

- [ ] **Шаг 3: запустить, убедиться, что падают**

- [ ] **Шаг 4: реализовать разбор**

- [ ] **Шаг 5: доказательства мутацией**

1. Ветвиться по `subtype` вместо `is_error` → падает «treats an authentication failure as a failure».
2. Пропускать события `system` без фильтра → падает «drops the user's hook events».

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-claude-code
git commit -m "feat(provider-claude-code): read a stream that reports failure as success"
```

---

### Задача 8: адаптер Claude Code

**Файлы:**

- Создать: `packages/provider-claude-code/src/index.ts`
- Создать: `packages/provider-claude-code/test/adapter.unit.test.ts`

**Интерфейсы:**

- Потребляет: `runProcess`, `parseClaudeEvent`, contract из задач 2-3
- Производит: `createClaudeCodeProvider(options?: { command?: string; contextWindowTokens?: number; maxBudgetUsd?: number }): ProviderAdapter`

**Команда запуска:**

```text
claude -p --output-format stream-json --verbose --permission-mode plan
       --no-session-persistence --max-budget-usd <лимит> --json-schema <схема checkpoint>
```

**`checkpointOnRequest` определяется задачей 1.** Если разведка подтвердила впрыск через
`--input-format stream-json` — объявить `true` и реализовать `requestHandoff` как впрыск просьбы
свернуться. Если нет — объявить `false`, `requestHandoff` становится no-op, и адаптер ведёт себя как
Codex. **Не строить впрыск, которого разведка не подтвердила.**

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("declares itself as Claude Code and reports cost, which Codex cannot", () => {
  const capabilities = createClaudeCodeProvider().capabilities();
  expect(capabilities.provider).toBe("CLAUDE_CODE");
  expect(capabilities.costReporting).toBe(true);
});

// SD-001 again, and for this CLI there are two flags to stay away from, not one.
it("never builds a command carrying a permission-bypass flag", async () => {
  const spawned = recordSpawn();
  await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
  const line = spawned.args.join(" ");
  expect(line).not.toContain("dangerously");
  expect(line).not.toContain("bypassPermissions");
});

// BD-001: the budget stops being a Loomrail estimate and becomes something the CLI enforces.
it("passes the remaining budget to the CLI so the limit is enforced where the spending happens", async () => {
  const spawned = recordSpawn();
  await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath, maxBudgetUsd: 1.25 }));
  expect(spawned.args).toContain("--max-budget-usd");
  expect(spawned.args[spawned.args.indexOf("--max-budget-usd") + 1]).toBe("1.25");
});

it("fails the session when the CLI reports an authentication failure", async () => {
  const outcome = await runAgainstRecording("not-logged-in.jsonl");
  expect(outcome.type).not.toBe("COMPLETED");
});

it("reports the cost the CLI reports", async () => {
  const usages: ProviderUsage[] = [];
  await runAgainstRecording("hello.jsonl", { onUsage: (usage) => usages.push(usage) });
  expect(usages.at(-1)?.costUsd).toBeGreaterThan(0);
});
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

- [ ] **Шаг 3: реализовать**

- [ ] **Шаг 4: прогнать**

- [ ] **Шаг 5: доказательства мутацией**

1. Не передавать `--max-budget-usd` → падает тест про бюджет.
2. Считать `subtype: "success"` успехом → падает тест про отказ авторизации.
3. Добавить `--permission-mode bypassPermissions` → падает тест про обход разрешений.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/provider-claude-code
git commit -m "feat(provider-claude-code): a live adapter with a budget the CLI itself enforces"
```

---

### Задача 9: гейт по стадиям и выбор адаптера

**Файлы:**

- Изменить: `packages/domain/src/workflow.ts`
- Изменить: `apps/daemon/src/server.ts`
- Тест: `packages/domain/test/workflow.unit.test.ts`, `apps/daemon/test/server.integration.test.ts`

**Интерфейсы:**

- Потребляет: `capabilities().stages` (задача 2)

**Почему это отдельная задача.** Без неё адаптеры существуют, но диспетчер по-прежнему отправит Codex
стадию IMPLEMENT, тот вернёт текст, и стадия будет выглядеть сделанной. Ревьюер обязан иметь возможность
отклонить этот гейт отдельно от самих адаптеров.

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("refuses to dispatch a stage the adapter did not declare", () => {
  const decision = decideDispatchStage({
    stage: "IMPLEMENT",
    capabilities: { ...codexCapabilities, stages: ["DISCOVERY", "PLAN", "REVIEW"] },
  });
  expect(decision.type).toBe("STAGE_NOT_SERVED");
});

it("dispatches a stage the adapter did declare", () => {
  const decision = decideDispatchStage({
    stage: "PLAN",
    capabilities: { ...codexCapabilities, stages: ["DISCOVERY", "PLAN", "REVIEW"] },
  });
  expect(decision.type).toBe("DISPATCH");
});

// A refusal the owner cannot see is a stage that silently never runs.
it("opens a Human Request naming the stage and the provider", () => {
  const decision = decideDispatchStage({ stage: "IMPLEMENT", capabilities: codexCapabilities });
  expect(decision.type === "STAGE_NOT_SERVED" && decision.request.prompt).toContain("IMPLEMENT");
});
```

- [ ] **Шаг 2-4: реализовать и прогнать**

- [ ] **Шаг 5: доказательство мутацией**

Всегда возвращать `DISPATCH` → падают первый и третий тесты, оба утверждением.

- [ ] **Шаг 6: Commit** (при наличии разрешения)

```bash
git add packages/domain/src/workflow.ts packages/domain/test/workflow.unit.test.ts apps/daemon/src/server.ts apps/daemon/test/server.integration.test.ts
git commit -m "feat(domain): do not send a stage to an adapter that cannot serve it"
```

---

### Задача 10: pid живой сессии и убийство осиротевшего процесса

**Файлы:**

- Создать: `packages/persistence-sqlite/migrations/0010_provider_session_pid.sql`
- Изменить: `packages/persistence-sqlite/src/index.ts`, `packages/persistence-sqlite/src/migrations.ts`
- Изменить: `packages/contracts/src/workflow.ts` (`providerSessionSchema`)
- Изменить: `apps/daemon/src/session-loop.ts`
- Тест: `packages/persistence-sqlite/test/local-state.integration.test.ts`, `apps/daemon/test/session.integration.test.ts`

**Почему.** Спек §8: если демон умер, не убив дочерний процесс, тот его переживёт — продолжит работать и
тратить деньги владельца, а Loomrail будет считать сессию просто осиротевшей. Реконсиляция обязана
сначала убить, потом закрывать.

**Правила миграций** из глобальных ограничений действуют буквально: 0010 новая, 0001-0009 неприкосновенны,
проверка идёт на **копии** базы владельца, снятой backup API, а не `cp`.

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("remembers the process a running session is driving", () => {
  const state = openTemporaryState();
  const session = startProviderSession(state, { pid: 4242 });
  expect(readProviderSession(state, session.id).pid).toBe(4242);
});

// "no process was ever started" and "a process whose pid is 0" are different facts, and a
// NOT NULL DEFAULT 0 column cannot tell them apart -- which is the difference between
// reconciliation skipping a session and reconciliation trying to signal init.
it("leaves the pid null for a session that never started a process", () => {
  const state = openTemporaryState();
  const session = startProviderSession(state, {});
  expect(readProviderSession(state, session.id).pid).toBeNull();
});

// The claim reconciliation makes is "killed first, marked second". Proven with a REAL detached
// child, because the whole point is that the process outlives the daemon that spawned it.
it("kills a process orphaned by a daemon restart before ending its session", async () => {
  const databasePath = await temporaryDatabasePath();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true });
  const pid = child.pid;
  if (pid === undefined) throw new Error("The probe child did not start");
  child.unref();

  const before = await openLocalState({ databasePath });
  const session = startProviderSession(before, { pid });
  before.close();

  const after = await openLocalState({ databasePath });
  after.execute(reconcileWorkflowsCommand());

  expect(isProcessAlive(pid)).toBe(false);
  expect(readProviderSession(after, session.id).status).toBe("ENDED");
  after.close();
});

// `process.kill(pid, 0)` throws ESRCH when nothing is there; it asks without signalling, and it is
// what the reconciliation itself must use.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
```

- [ ] **Шаг 2: запустить, убедиться, что падают**

`pnpm --filter @loomrail/persistence-sqlite test` — FAIL, колонки нет.

- [ ] **Шаг 3: миграция 0010**

```sql
-- The process a RUNNING session is driving, so a daemon that died without killing it can find that
-- process on the next start. Nullable on purpose: a session that never reached `spawn` has no
-- process, and that is a different fact from "a process whose pid is 0".
ALTER TABLE provider_sessions
  ADD COLUMN process_pid INTEGER CHECK (process_pid IS NULL OR process_pid > 0);
```

Зарегистрировать в `migrations.ts`; добавить `pid` в `providerSessionSchema` как
`z.number().int().positive().nullable()`.

- [ ] **Шаг 4: убийство в реконсиляции**

`RECONCILE_WORKFLOWS` перед тем, как пометить осиротевшую сессию `ENDED/INTERRUPTED`, читает её
`process_pid` и, если он есть и процесс жив, убивает его. **Порядок несущий: сначала убить, потом
пометить.** Обратный порядок оставляет при крахе между двумя шагами запись «завершена» рядом с живым
процессом, которого следующий старт уже не найдёт — то есть ровно тот осиротевший процесс, ради
которого всё это и делается.

- [ ] **Шаг 5: доказательства мутацией**

1. Помечать сессию завершённой, не убивая процесс → падает третий тест.
2. Сделать колонку `NOT NULL DEFAULT 0` → падает второй: «не было процесса» и «процесс с pid 0» перестают
   различаться.

- [ ] **Шаг 6: проверка на копии базы владельца**

Снять копию backup API (не `cp` — WAL), прогнать цепочку миграций, замерить время, проверить
`integrity_check` и что события читаются. Числа — в отчёт.

- [ ] **Шаг 7: Commit** (при наличии разрешения)

---

### Задача 10.5: отсутствующий CLI, запрет resume и отказ от записи сырого потока

**Файлы:** `packages/provider-codex/src/index.ts`, `packages/provider-claude-code/src/index.ts` и их тесты.

Три требования спека, у которых иначе не было бы ни одной задачи. Собраны вместе, потому что все три —
маленькие правки в тех же двух файлах, и ревьюер судит их одним взглядом.

**§9, первая строка: CLI не установлен.** `capabilities()` не должен обещать провайдера, которого нет на
машине. Проверка наличия исполняемого файла делается один раз при создании адаптера, а не на каждый запуск.

**D3: собственный resume провайдеров не используется.** Ни `codex resume`, ни `claude --resume`, ни
`--continue`, ни `--fork-session`. Это не забывчивость, а решение: D1 спека A1 убрал второй путь
исполнения, и вернуть его через флаг CLI значило бы отменить A1, не заметив этого.

**D7: сырой поток никуда не записывается.** Единственная надёжная защита от того, что вывод хуков владельца
попадёт в диагностику Loomrail, — не сохранять сырой поток вообще. Сохраняются разобранные события; сырые
строки живут только внутри разбора.

- [ ] **Шаг 1: написать падающие тесты**

```ts
it("declares itself unavailable when its CLI is not installed", () => {
  const capabilities = createCodexProvider({ command: "/nonexistent/codex" }).capabilities();
  expect(capabilities.start).toBe(false);
  expect(capabilities.stages).toEqual([]);
});

// A1's D1 removed the second execution path deliberately; reinstating it through a CLI flag would
// undo that decision without anyone deciding to.
it("never resumes a provider-side session", async () => {
  const spawned = recordSpawn();
  await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
  const line = spawned.args.join(" ");
  expect(line).not.toContain("resume");
  expect(line).not.toContain("--continue");
  expect(line).not.toContain("--fork-session");
});

// The only reliable protection against recording the owner's hook output is not to keep the raw
// stream at all.
it("keeps no raw provider output after the session ends", async () => {
  const outcome = await runAgainstRecording("hello.jsonl");
  expect(JSON.stringify(outcome)).not.toContain("hook");
});
```

Те же три теста — для `createClaudeCodeProvider`, с его собственными флагами.

- [ ] **Шаг 2: запустить, убедиться, что падают**

- [ ] **Шаг 3: реализовать**

Наличие CLI проверяется через `node:fs` по разрешённому пути; при отсутствии — `start: false` и пустые
`stages`, что гейт задачи 9 уже умеет обрабатывать.

- [ ] **Шаг 4: доказательства мутацией**

1. Возвращать `start: true` при отсутствующем файле → падает первый тест.
2. Добавить `--continue` в аргументы → падает второй.

- [ ] **Шаг 5: Commit** (при наличии разрешения)

```bash
git add packages/provider-codex packages/provider-claude-code
git commit -m "feat(providers): refuse to promise an adapter whose CLI is not there"
```

---

### Задача 11: безопасность и документы

**Файлы:**

- Изменить: `docs/security/THREAT-MODEL.md`
- Изменить: `docs/plans/06-post-phase-0-decomposition.ru.md`
- Тест: `packages/provider-codex/test/adapter.unit.test.ts`, `packages/provider-claude-code/test/adapter.unit.test.ts`

- [ ] **Шаг 1: сводный тест на запрет обхода разрешений**

Один тест на каждый адаптер, перебирающий **все** запрещённые флаги списком, а не по одному:
`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--permission-mode bypassPermissions`. Список именованной
константой, чтобы добавление флага в CLI требовало осознанного решения, а не осталось незамеченным.

- [ ] **Шаг 2: THREAT-MODEL**

Новые строки: запуск дочерних процессов под учётной записью владельца; осиротевший процесс, переживший
демона; недоверенный поток провайдера, несущий вывод хуков пользователя. Для каждой — смягчение и
**имя теста**, который его проверяет. Ссылку проверить `grep`-ом: ссылка, которая не разрешается, хуже
отсутствующей.

- [ ] **Шаг 3: декомпозиция**

Отметить A2 сделанным, записать, что живые адаптеры до E1 обслуживают только DISCOVERY, PLAN и REVIEW, и
что IMPLEMENT с QA ждут E1.

- [ ] **Шаг 4: `pnpm verify`** (включает `prettier --check` по Markdown)

- [ ] **Шаг 5: Commit** (при наличии разрешения)

---

## Финальная проверка перед сдачей

- [ ] `pnpm verify` зелёный на чистом worktree
- [ ] `pnpm test:e2e` зелёный
- [ ] `pnpm pack:release && pnpm test:release` — обязательно: задача 10 меняет чтение сохранённой базы
- [ ] `git diff --check` чистый
- [ ] Каждая задача сдана с доказательством мутацией, и для каждой указано, было ли падение утверждением
- [ ] Ни в одном пути кода нет флага обхода разрешений — проверено `grep -ri dangerous packages/provider-*`
- [ ] Записанные потоки в `test/recordings/` не содержат абсолютных личных путей и секретов
- [ ] `git status` сверен: работа параллельной сессии не тронута и не застейджена
