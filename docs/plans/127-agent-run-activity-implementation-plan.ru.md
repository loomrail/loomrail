# Agent Run Activity — уровень 1: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development` (рекомендуется)
> либо `superpowers:executing-plans`. Шаги отмечаются чекбоксами `- [ ]`.

**Goal:** владелец видит в Task Cockpit одну хронологию действий агентского прогона, объединяющую проверенные
демоном workspace-операции и то, о чём отчитался локальный CLI провайдера.

**Architecture:** захват живёт в provider adapter и отдаёт нормализованные записи через новый опциональный
`ProviderSessionListener.onActivity`. Демон валидирует, редактирует и пишет их в отдельную прунимую таблицу, не
трогая append-only Event vocabulary. Кадр канала событий не меняется: демон публикует обычный сигнал, клиент
дотягивает содержимое по HTTP. Слияние с `workspace_tool_calls` выполняется на чтении.

**Tech Stack:** TypeScript strict, zod 4, vitest, `node:sqlite` через `@loomrail/persistence-sqlite`, Fastify,
React + TanStack Router, Playwright.

**Spec:** [`docs/plans/126-agent-run-activity-spec.ru.md`](126-agent-run-activity-spec.ru.md)

## Global Constraints

- TypeScript strict; `any` запрещён в production-коде и публичных тестах; только named exports; `type` для форм
  данных; switch по union исчерпывающий.
- Prettier владеет форматированием: двойные кавычки, точки с запятой, trailing commas. Перед сдачей — `pnpm verify`.
- `console.log` в продуктовых путях запрещён; только структурный логгер с redaction.
- `node:sqlite` импортирует только `packages/persistence-sqlite`. Импорт из `apps/*` в `packages/*` запрещён.
- Provider output — недоверенный вход. Любое значение оттуда проходит `safeParse`, границы длины и redaction.
- Мигрaцию, вошедшую в общую историю, править нельзя; добавляется новая.
- Инжектируемые часы и генераторы ID, никаких `Date.now()` в детерминируемом коде.
- **Коммиты только по явной просьбе владельца** (AGENTS.md). Шаги «Commit» выполняются, если владелец попросил
  коммитить; иначе изменения остаются в рабочем дереве.
- Границы: `label` ≤ 500 символов, `detail` ≤ 2 000, `status` ≤ 120, `actionKey` ≤ 200, не более 1 000 записей на
  прогон.

---

### Task 1: Контракт записи активности

**Files:**

- Create: `packages/contracts/src/activity.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/activity.unit.test.ts`

**Interfaces:**

- Produces: `providerActivityEntrySchema`, `ProviderActivityEntry`, `activityOriginSchema`,
  `agentRunActivityEntrySchema`, `AgentRunActivityEntry`, `agentRunActivityPageSchema`.

- [ ] **Шаг 1: Написать падающий тест**

```ts
import { describe, expect, it } from "vitest";

import { providerActivityEntrySchema } from "../src/activity.js";

const valid = {
  actionKey: "call_1",
  kind: "TOOL_CALL",
  label: "pnpm test",
  detail: null,
  status: null,
  terminal: false,
  truncated: false,
} as const;

describe("providerActivityEntrySchema", () => {
  it("accepts a started tool call", () => {
    expect(providerActivityEntrySchema.parse(valid)).toEqual(valid);
  });

  it("rejects a label past the bound instead of silently keeping it", () => {
    const result = providerActivityEntrySchema.safeParse({ ...valid, label: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field so a later addition cannot ride along", () => {
    const result = providerActivityEntrySchema.safeParse({ ...valid, extra: "1" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/contracts test -- activity`
Expected: FAIL — модуль `../src/activity.js` не найден.

- [ ] **Шаг 3: Написать минимальную реализацию**

```ts
import { z } from "zod";

/**
 * What a provider adapter reports about one action it took.
 *
 * Bounded and `.strict()` on purpose: this crosses the boundary from untrusted process output into
 * Loomrail, so a field added later fails to parse rather than riding along. It carries no
 * authority -- `git diff` and measured verification remain the source of truth about what changed.
 */
export const providerActivityKindSchema = z.enum([
  "TOOL_CALL",
  "AGENT_TEXT",
  "FILE_CHANGE",
  "PROVIDER_ERROR",
]);

export const providerActivityEntrySchema = z
  .object({
    // The provider's own identifier for the action, so a terminal report updates the record the
    // starting one created instead of appending a second row for the same action.
    actionKey: z.string().trim().min(1).max(200),
    kind: providerActivityKindSchema,
    label: z.string().trim().min(1).max(500).nullable(),
    detail: z.string().trim().min(1).max(2_000).nullable(),
    status: z.string().trim().min(1).max(120).nullable(),
    terminal: z.boolean(),
    // True when any text on this entry was cut to fit its bound. Silent truncation would let a
    // reader mistake a fragment for the whole thing.
    truncated: z.boolean(),
  })
  .strict();

export type ProviderActivityEntry = z.infer<typeof providerActivityEntrySchema>;

/**
 * Where an entry came from, and therefore how much it is worth.
 *
 * `DAEMON_AUDITED` passed through the daemon-owned gateway and is recorded in append-only
 * `workspace_tool_calls`. `PROVIDER_REPORTED` is the provider's account of itself: unverified,
 * prunable, and never evidence. Computed by the reader from the source table, never accepted from
 * a provider.
 */
export const activityOriginSchema = z.enum(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);

export const agentRunActivityEntrySchema = z
  .object({
    id: z.string().min(1),
    // Monotonic within a run but NOT dense: eviction leaves gaps, and a reader that treats a
    // missing number as a defect would report every long run as broken.
    seq: z.number().int().positive(),
    at: z.string().datetime(),
    origin: activityOriginSchema,
    provider: z.enum(["CODEX", "CLAUDE_CODE"]),
    kind: providerActivityKindSchema,
    label: z.string().max(500).nullable(),
    detail: z.string().max(2_000).nullable(),
    status: z.string().max(120).nullable(),
    truncated: z.boolean(),
  })
  .strict();

export type AgentRunActivityEntry = z.infer<typeof agentRunActivityEntrySchema>;

export const agentRunActivityPageSchema = z
  .object({
    entries: z.array(agentRunActivityEntrySchema).max(200),
    // Opaque: the client hands it back and never parses it. The merged feed has two sources, so a
    // single table's row number cannot address a position in it.
    nextCursor: z.string().min(1).nullable(),
    omittedCount: z.number().int().nonnegative(),
    degraded: z.boolean(),
    // True when the cursor named a pruned position and the page restarts from the oldest entry
    // still held, so the client can say so instead of showing a silent hole.
    gap: z.boolean(),
  })
  .strict();
```

- [ ] **Шаг 4: Экспортировать модуль**

В `packages/contracts/src/index.ts` добавить строку в алфавитном порядке рядом с `./activation.js`:

```ts
export * from "./activity.js";
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/contracts test -- activity`
Expected: PASS, три теста.

- [ ] **Шаг 6: Commit** (если владелец просил коммитить)

```bash
git add packages/contracts/src/activity.ts packages/contracts/src/index.ts packages/contracts/test/activity.unit.test.ts
git commit -m "feat(contracts): add bounded provider activity entry contract"
```

---

### Task 2: Парсер активности Codex

**Files:**

- Modify: `packages/provider-codex/src/stream.ts`
- Test: `packages/provider-codex/test/activity.unit.test.ts`

**Interfaces:**

- Consumes: `ProviderActivityEntry` из Task 1.
- Produces: `parseCodexActivity(line: string): readonly ProviderActivityEntry[]`.

Отдельная функция, а не расширение `parseCodexEvent`: существующий парсер отвечает за исход сессии и usage, его
контракт и его тесты не должны двигаться ради диагностики. Одна строка может дать несколько записей, поэтому
возвращается массив.

- [ ] **Шаг 1: Написать падающий тест**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCodexActivity } from "../src/activity.js";

const recording = (name: string): readonly string[] =>
  readFileSync(fileURLToPath(new URL(`./recordings/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);

describe("parseCodexActivity", () => {
  it("reports a command and its exit code from a real workspace-write run", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const commands = entries.filter((entry) => entry.kind === "TOOL_CALL");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((entry) => entry.label !== null)).toBe(true);
    expect(commands.some((entry) => entry.terminal && entry.status !== null)).toBe(true);
  });

  it("pairs the start and the completion of one action under one key", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const keys = entries.filter((entry) => entry.kind === "TOOL_CALL").map((entry) => entry.actionKey);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });

  it("reports file changes as paths without their content", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const changes = entries.filter((entry) => entry.kind === "FILE_CHANGE");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((entry) => entry.detail === null || entry.detail.length <= 2_000)).toBe(true);
  });

  it("returns nothing for a line it does not understand", () => {
    expect(parseCodexActivity("not json")).toEqual([]);
    expect(parseCodexActivity(JSON.stringify({ type: "turn.started" }))).toEqual([]);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/provider-codex test -- activity`
Expected: FAIL — `../src/activity.js` не найден.

- [ ] **Шаг 3: Написать реализацию в `packages/provider-codex/src/activity.ts`**

```ts
import type { ProviderActivityEntry } from "@loomrail/contracts";
import { z } from "zod";

import { boundActivityText } from "@loomrail/provider-core";

// Only the fields an entry is built from. Not `.strict()`: the real CLI carries more on these
// items, and a field added upstream must not turn a readable action into an unreadable line.
const commandItemSchema = z.object({
  id: z.string(),
  type: z.literal("command_execution"),
  command: z.string(),
  status: z.string().optional(),
  exit_code: z.number().int().optional(),
});

const fileChangeItemSchema = z.object({
  id: z.string(),
  type: z.literal("file_change"),
  changes: z.array(z.object({ path: z.string(), kind: z.string().optional() })).optional(),
});

const agentMessageItemSchema = z.object({
  id: z.string(),
  type: z.literal("agent_message"),
  text: z.string(),
});

const activityLineSchema = z.object({
  type: z.enum(["item.started", "item.completed"]),
  item: z.union([commandItemSchema, fileChangeItemSchema, agentMessageItemSchema]),
});

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Builds diagnostic activity entries from one line of `codex exec`'s JSONL stream.
 *
 * Deliberately separate from `parseCodexEvent`: that parser decides the session's outcome, and
 * widening it to also describe actions would make one failure mode -- an unreadable action -- able
 * to change what Loomrail believes about the result. Returns an empty array for anything it does
 * not understand, exactly as the event parser returns null.
 */
export const parseCodexActivity = (line: string): readonly ProviderActivityEntry[] => {
  const parsed = activityLineSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) return [];
  const { type, item } = parsed.data;
  const terminal = type === "item.completed";

  switch (item.type) {
    case "command_execution": {
      const label = boundActivityText(item.command, 500);
      return [
        {
          actionKey: item.id,
          kind: "TOOL_CALL",
          label: label.text,
          detail: null,
          status: terminal
            ? item.exit_code === undefined
              ? (item.status ?? null)
              : `exit ${item.exit_code}`
            : null,
          terminal,
          truncated: label.truncated,
        },
      ];
    }
    case "file_change": {
      // Paths only. The content of a change is never read here: `git diff` against the worktree is
      // Loomrail's account of what changed, and a second, weaker source invites a reader to trust
      // the provider's report of itself over the disk.
      if (!terminal) return [];
      const paths = (item.changes ?? []).map((change) => change.path);
      if (paths.length === 0) return [];
      const label = boundActivityText(paths[0] ?? "", 500);
      const detail = paths.length > 1 ? boundActivityText(paths.slice(1).join(", "), 2_000) : null;
      return [
        {
          actionKey: item.id,
          kind: "FILE_CHANGE",
          label: label.text,
          detail: detail?.text ?? null,
          status: null,
          terminal: true,
          truncated: label.truncated || (detail?.truncated ?? false),
        },
      ];
    }
    case "agent_message": {
      if (!terminal) return [];
      const detail = boundActivityText(item.text, 2_000);
      if (detail.text === null) return [];
      return [
        {
          actionKey: item.id,
          kind: "AGENT_TEXT",
          label: null,
          detail: detail.text,
          status: null,
          terminal: true,
          truncated: detail.truncated,
        },
      ];
    }
  }
};
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/provider-codex test -- activity`
Expected: PASS, четыре теста. Существующие тесты `stream.unit.test.ts` не изменились.

- [ ] **Шаг 5: Commit** (по просьбе владельца)

```bash
git add packages/provider-codex/src/activity.ts packages/provider-codex/test/activity.unit.test.ts
git commit -m "feat(provider-codex): parse diagnostic activity from the JSONL stream"
```

---

### Task 3: Граница текста в provider-core

**Files:**

- Create: `packages/provider-core/src/activity-text.ts`
- Modify: `packages/provider-core/src/index.ts`
- Test: `packages/provider-core/test/activity-text.unit.test.ts`

**Interfaces:**

- Produces: `boundActivityText(value: string, maxChars: number): { text: string | null; truncated: boolean }`.

Задача идёт раньше Task 2 по зависимости, но после него по номеру: выполнять **до** Task 2, если исполнитель
читает план по порядку — Task 2 импортирует эту функцию.

- [ ] **Шаг 1: Написать падающий тест**

```ts
import { describe, expect, it } from "vitest";

import { boundActivityText } from "../src/activity-text.js";

describe("boundActivityText", () => {
  it("keeps a short value and reports no truncation", () => {
    expect(boundActivityText("pnpm test", 500)).toEqual({ text: "pnpm test", truncated: false });
  });

  it("cuts a long value and says that it did", () => {
    const result = boundActivityText("x".repeat(600), 500);
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBeLessThanOrEqual(500);
  });

  it("returns null for a value that is empty once trimmed", () => {
    expect(boundActivityText("   \n  ", 500)).toEqual({ text: null, truncated: false });
  });

  it("does not split a surrogate pair", () => {
    const result = boundActivityText("😀".repeat(400), 500);
    expect(result.text === null || [...result.text].every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/provider-core test -- activity-text`
Expected: FAIL — модуль не найден.

- [ ] **Шаг 3: Написать реализацию**

```ts
export type BoundedActivityText = {
  text: string | null;
  truncated: boolean;
};

/**
 * Trims a provider-reported string to its contract bound.
 *
 * Cutting by code points rather than by UTF-16 units: slicing a string in the middle of a
 * surrogate pair produces a replacement character, which is a corruption the reader cannot tell
 * from the provider's own output. `truncated` is returned rather than an ellipsis appended,
 * because the marker belongs to the record, not to the text -- appending to the text would make
 * the fragment indistinguishable from a provider that really ended its line with an ellipsis.
 */
export const boundActivityText = (value: string, maxChars: number): BoundedActivityText => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { text: null, truncated: false };
  const points = [...trimmed];
  if (points.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: points.slice(0, maxChars).join(""), truncated: true };
};
```

- [ ] **Шаг 4: Экспортировать**

В `packages/provider-core/src/index.ts` добавить:

```ts
export * from "./activity-text.js";
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/provider-core test -- activity-text`
Expected: PASS, четыре теста.

- [ ] **Шаг 6: Commit** (по просьбе владельца)

```bash
git add packages/provider-core/src/activity-text.ts packages/provider-core/src/index.ts packages/provider-core/test/activity-text.unit.test.ts
git commit -m "feat(provider-core): bound provider-reported activity text by code point"
```

---

### Task 4: Парсер активности Claude Code

**Files:**

- Create: `packages/provider-claude-code/src/activity.ts`
- Test: `packages/provider-claude-code/test/activity.unit.test.ts`

**Interfaces:**

- Consumes: `boundActivityText` (Task 3), `ProviderActivityEntry` (Task 1).
- Produces: `parseClaudeActivity(line: string): readonly ProviderActivityEntry[]`.

- [ ] **Шаг 1: Написать падающий тест**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeActivity } from "../src/activity.js";

const recording = (name: string): readonly string[] =>
  readFileSync(fileURLToPath(new URL(`./recordings/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);

describe("parseClaudeActivity", () => {
  it("reports tool calls from a real run that used MCP tools", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const calls = entries.filter((entry) => entry.kind === "TOOL_CALL" && !entry.terminal);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((entry) => entry.label !== null)).toBe(true);
  });

  it("pairs a tool result with the call it answers", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const started = entries.filter((entry) => entry.kind === "TOOL_CALL" && !entry.terminal);
    const finished = entries.filter((entry) => entry.kind === "TOOL_CALL" && entry.terminal);
    expect(finished.every((end) => started.some((start) => start.actionKey === end.actionKey))).toBe(true);
  });

  it("never carries tool result content", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const finished = entries.filter((entry) => entry.kind === "TOOL_CALL" && entry.terminal);
    expect(finished.every((entry) => entry.detail === null)).toBe(true);
  });

  it("drops every system event, including hook events", () => {
    const entries = recording("not-logged-in.jsonl").flatMap(parseClaudeActivity);
    expect(entries.every((entry) => entry.kind !== "PROVIDER_ERROR" || entry.label !== null)).toBe(true);
    const systemLines = recording("not-logged-in.jsonl").filter((line) => line.includes('"type":"system"'));
    expect(systemLines.flatMap(parseClaudeActivity)).toEqual([]);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/provider-claude-code test -- activity`
Expected: FAIL — модуль не найден.

- [ ] **Шаг 3: Написать реализацию**

```ts
import type { ProviderActivityEntry } from "@loomrail/contracts";
import { boundActivityText } from "@loomrail/provider-core";
import { z } from "zod";

// Which single argument identifies the target of a call, per tool. Read as a closed lookup rather
// than by serializing `input`: the argument object is provider-controlled and may carry file
// contents, so taking one named string keeps content out by construction, not by filtering.
const TOOL_TARGET_FIELDS: Readonly<Record<string, string>> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});

const assistantLineSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});

const userLineSchema = z.object({
  type: z.literal("user"),
  message: z.object({ content: z.array(z.unknown()) }),
});

const activityLineSchema = z.union([assistantLineSchema, userLineSchema]);

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const targetOf = (name: string, input: Record<string, unknown> | undefined): string | null => {
  const field = TOOL_TARGET_FIELDS[name];
  if (field === undefined || input === undefined) return null;
  const value = input[field];
  return typeof value === "string" ? value : null;
};

/**
 * Builds diagnostic activity entries from one line of the `claude` CLI's stream-json output.
 *
 * `system` events -- the CLI's own init line and the owner's hook events -- are not in the union
 * this parser reads, so hook stdout/stderr cannot reach an entry even through a subtype nobody has
 * seen yet. That is the same rule `parseClaudeEvent` enforces for the result path (SD-003).
 */
export const parseClaudeActivity = (line: string): readonly ProviderActivityEntry[] => {
  const parsed = activityLineSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) return [];
  const entries: ProviderActivityEntry[] = [];

  for (const raw of parsed.data.message.content) {
    const toolUse = toolUseBlockSchema.safeParse(raw);
    if (toolUse.success) {
      const label = boundActivityText(toolUse.data.name, 500);
      if (label.text === null) continue;
      const target = targetOf(toolUse.data.name, toolUse.data.input);
      const detail = target === null ? null : boundActivityText(target, 2_000);
      entries.push({
        actionKey: toolUse.data.id,
        kind: "TOOL_CALL",
        label: label.text,
        detail: detail?.text ?? null,
        status: null,
        terminal: false,
        truncated: label.truncated || (detail?.truncated ?? false),
      });
      continue;
    }

    const toolResult = toolResultBlockSchema.safeParse(raw);
    if (toolResult.success) {
      // Only the verdict. `content` is the tool's output and may be a file the agent read.
      entries.push({
        actionKey: toolResult.data.tool_use_id,
        kind: "TOOL_CALL",
        label: null,
        detail: null,
        status: toolResult.data.is_error === true ? "error" : "ok",
        terminal: true,
        truncated: false,
      });
      continue;
    }

    const text = textBlockSchema.safeParse(raw);
    if (text.success) {
      const detail = boundActivityText(text.data.text, 2_000);
      if (detail.text === null) continue;
      entries.push({
        actionKey: `text-${entries.length}`,
        kind: "AGENT_TEXT",
        label: null,
        detail: detail.text,
        status: null,
        terminal: true,
        truncated: detail.truncated,
      });
    }
  }

  return entries;
};
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/provider-claude-code test -- activity`
Expected: PASS, четыре теста.

- [ ] **Шаг 5: Commit** (по просьбе владельца)

```bash
git add packages/provider-claude-code/src/activity.ts packages/provider-claude-code/test/activity.unit.test.ts
git commit -m "feat(provider-claude-code): parse diagnostic activity from the stream-json output"
```

---

### Task 5: Канал `onActivity` и его вызов из адаптеров

**Files:**

- Modify: `packages/provider-core/src/index.ts:409-427` (`ProviderSessionListener`)
- Modify: `packages/provider-codex/src/index.ts:253-296` (`onLine`)
- Modify: `packages/provider-claude-code/src/index.ts:219-249` (`onLine`)
- Test: `packages/provider-codex/test/adapter-activity.unit.test.ts`

**Interfaces:**

- Produces: `ProviderSessionListener.onActivity?: (entry: ProviderActivityEntry) => void`.

- [ ] **Шаг 1: Расширить листенер**

В `ProviderSessionListener` добавить после `onProcessStarted`:

```ts
  /**
   * One action the provider reported taking. Optional like `onAllowance` and `onProcessStarted`:
   * an adapter that cannot describe its own actions stays correct by not calling it.
   *
   * Runs inside the adapter's stdout handler, where `runProcess` wraps every listener in a guard
   * that kills the child and fails the session on a throw. An implementation MUST NOT throw:
   * losing the diagnostic is correct, killing the run it was diagnosing is not.
   */
  onActivity?: (entry: ProviderActivityEntry) => void;
```

- [ ] **Шаг 2: Написать падающий тест на счётчик**

```ts
import { describe, expect, it } from "vitest";

import { parseCodexActivity } from "../src/activity.js";
import { parseCodexEvent } from "../src/stream.js";

// Mirrors the adapter's onLine bookkeeping so the counter rule is pinned by a test rather than by
// a comment: a line that produced activity is no longer "unused", or the adapter's own diagnostic
// would report a healthy run as one it could not read.
const classify = (line: string): { activity: number; unused: number } => {
  const activity = parseCodexActivity(line);
  const event = parseCodexEvent(line);
  const unused = event === null && activity.length === 0 ? 1 : 0;
  return { activity: activity.length, unused };
};

describe("adapter line bookkeeping", () => {
  it("does not count a command execution as an unused line", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "pnpm test", exit_code: 0 },
    });
    expect(classify(line)).toEqual({ activity: 1, unused: 0 });
  });

  it("still counts a line nothing understands", () => {
    expect(classify('{"type":"unknown.event"}')).toEqual({ activity: 0, unused: 1 });
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/provider-codex test -- adapter-activity`
Expected: FAIL.

- [ ] **Шаг 4: Вызвать `onActivity` в адаптере Codex**

В `packages/provider-codex/src/index.ts`, первой строкой тела `onLine`:

```ts
          onLine: (line) => {
            linesReceived += 1;
            const activity = parseCodexActivity(line);
            for (const entry of activity) listener.onActivity?.(entry);
            const event = parseCodexEvent(line);
            if (event === null) {
              const decoded = tryParseStructuredResult(line, invocation);
              if (decoded === null) {
                if (activity.length === 0) {
                  linesUnused += 1;
                  linesUnreadable += 1;
                }
              } else {
```

Остальное тело `onLine` не меняется. В ветке `case "item.ignored"` заменить безусловный `linesUnused += 1` на:

```ts
              case "item.ignored":
                if (activity.length === 0) linesUnused += 1;
                return;
```

- [ ] **Шаг 5: Вызвать `onActivity` в адаптере Claude Code**

В `packages/provider-claude-code/src/index.ts`:

```ts
          onLine: (line) => {
            linesReceived += 1;
            const activity = parseClaudeActivity(line);
            for (const entry of activity) listener.onActivity?.(entry);
            const event = parseClaudeEvent(line);
            if (event === null) {
              if (activity.length === 0) linesUnused += 1;
              return;
            }
```

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/provider-codex test && pnpm --filter @loomrail/provider-claude-code test`
Expected: PASS, включая существующие тесты адаптеров.

- [ ] **Шаг 7: Commit** (по просьбе владельца)

```bash
git add packages/provider-core/src/index.ts packages/provider-codex/src packages/provider-claude-code/src packages/provider-codex/test/adapter-activity.unit.test.ts
git commit -m "feat(providers): report diagnostic activity through the session listener"
```

---

### Task 6: Хранение активности

**Files:**

- Create: `packages/persistence-sqlite/migrations/0062_agent_run_activity.sql`
- Modify: `packages/persistence-sqlite/src/migrations.ts:325-330`
- Modify: `packages/persistence-sqlite/src/index.ts`
- Test: `packages/persistence-sqlite/test/agent-run-activity.integration.test.ts`

**Interfaces:**

- Produces: команда `RECORD_AGENT_RUN_ACTIVITY`, запрос `LIST_AGENT_RUN_ACTIVITY`.

Таблица намеренно **не** append-only, в отличие от `events` и `workspace_tool_calls`: запись обновляется терминальным
отчётом и вытесняется при переполнении. Это диагностический буфер без authority, и триггеры неизменяемости к нему
не применяются.

- [ ] **Шаг 1: Написать миграцию**

```sql
-- Level 1 Agent Run Activity: prunable, non-authoritative diagnostic record of what a provider
-- reported doing. Unlike `events` and `workspace_tool_calls` this table is deliberately mutable and
-- prunable: a terminal report updates the row its start created, and the oldest rows are evicted
-- once a run passes its bound. Nothing here is evidence.
CREATE TABLE agent_run_activity (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  action_key TEXT NOT NULL CHECK (length(action_key) BETWEEN 1 AND 200),
  provider TEXT NOT NULL CHECK (provider IN ('CODEX', 'CLAUDE_CODE')),
  kind TEXT NOT NULL CHECK (kind IN ('TOOL_CALL', 'AGENT_TEXT', 'FILE_CHANGE', 'PROVIDER_ERROR')),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 500),
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 2000),
  status TEXT CHECK (status IS NULL OR length(status) BETWEEN 1 AND 120),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  observed_at TEXT NOT NULL,
  UNIQUE (provider_session_id, action_key),
  UNIQUE (agent_run_id, seq)
) STRICT;

CREATE INDEX agent_run_activity_run_idx
ON agent_run_activity(agent_run_id, observed_at, id);

-- Per-run counters the entries themselves cannot carry: how many were evicted, and whether the
-- recorder ever failed to write. Both are shown to the owner rather than hidden.
CREATE TABLE agent_run_activity_state (
  agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  next_seq INTEGER NOT NULL CHECK (next_seq > 0),
  omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
  degraded INTEGER NOT NULL CHECK (degraded IN (0, 1))
) STRICT;
```

- [ ] **Шаг 2: Зарегистрировать миграцию**

В `packages/persistence-sqlite/src/migrations.ts` добавить после записи версии 61:

```ts
  {
    version: 62,
    name: "agent_run_activity",
    filename: "0062_agent_run_activity.sql",
  },
```

- [ ] **Шаг 3: Написать падающий тест**

```ts
import { describe, expect, it } from "vitest";

import { withTestState } from "./helpers/state.js"; // существующий helper временных БД

describe("agent run activity", () => {
  it("updates the row a start created instead of appending a second", () => {
    withTestState((state, fixture) => {
      state.execute(recordActivity(fixture, { actionKey: "c1", terminal: false, status: null }));
      state.execute(recordActivity(fixture, { actionKey: "c1", terminal: true, status: "exit 0" }));
      const page = state.query({
        type: "LIST_AGENT_RUN_ACTIVITY",
        agentRunId: fixture.agentRunId,
        limit: 50,
      });
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.status).toBe("exit 0");
    });
  });

  it("evicts the oldest entries past the bound and counts what it dropped", () => {
    withTestState((state, fixture) => {
      for (let index = 0; index < 1_005; index += 1) {
        state.execute(recordActivity(fixture, { actionKey: `c${index}`, terminal: true, status: "ok" }));
      }
      const page = state.query({
        type: "LIST_AGENT_RUN_ACTIVITY",
        agentRunId: fixture.agentRunId,
        limit: 2_000,
      });
      expect(page.entries.length).toBe(1_000);
      expect(page.omittedCount).toBe(5);
    });
  });

  it("keeps seq monotonic across eviction", () => {
    withTestState((state, fixture) => {
      for (let index = 0; index < 1_005; index += 1) {
        state.execute(recordActivity(fixture, { actionKey: `c${index}`, terminal: true, status: "ok" }));
      }
      const page = state.query({
        type: "LIST_AGENT_RUN_ACTIVITY",
        agentRunId: fixture.agentRunId,
        limit: 2_000,
      });
      const seqs = page.entries.map((entry) => entry.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    });
  });
});
```

Хелпер `recordActivity` — локальная функция файла, собирающая payload команды из фикстуры.

- [ ] **Шаг 4: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/persistence-sqlite test -- agent-run-activity`
Expected: FAIL — команда и запрос не существуют.

- [ ] **Шаг 5: Реализовать команду и запрос**

В `packages/persistence-sqlite/src/index.ts` добавить обработку `RECORD_AGENT_RUN_ACTIVITY` одной короткой
транзакцией. Команда **не пишет Event**: лента не является доменной историей, и добавление её в append-only
vocabulary дало бы ей authority, которой у неё нет.

```sql
-- 1. Занять номер.
INSERT INTO agent_run_activity_state (agent_run_id, schema_version, next_seq, omitted_count, degraded)
VALUES (?, 1, 1, 0, 0)
ON CONFLICT (agent_run_id) DO UPDATE SET next_seq = next_seq + 1
RETURNING next_seq;

-- 2. Создать запись либо обновить ту, которую создал её старт. Терминальный отчёт не затирает label/detail
--    непустого старта значением NULL: он добавляет исход, а не переписывает наблюдение.
INSERT INTO agent_run_activity (
  id, schema_version, project_id, work_item_id, agent_run_id, provider_session_id,
  seq, action_key, provider, kind, label, detail, status, truncated, observed_at
) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (provider_session_id, action_key) DO UPDATE SET
  status = COALESCE(excluded.status, agent_run_activity.status),
  label = COALESCE(agent_run_activity.label, excluded.label),
  detail = COALESCE(agent_run_activity.detail, excluded.detail),
  truncated = max(agent_run_activity.truncated, excluded.truncated);

-- 3. Вытеснить самые ранние записи сверх границы и честно сосчитать выброшенное.
DELETE FROM agent_run_activity
WHERE id IN (
  SELECT id FROM agent_run_activity
  WHERE agent_run_id = ?
  ORDER BY seq ASC
  LIMIT max(0, (SELECT count(*) FROM agent_run_activity WHERE agent_run_id = ?) - 1000)
);

UPDATE agent_run_activity_state
SET omitted_count = omitted_count + ?
WHERE agent_run_id = ?;
```

Все динамические значения — через prepared statements, без конкатенации.

`LIST_AGENT_RUN_ACTIVITY` возвращает `{ entries, omittedCount, degraded }`, читая `agent_run_activity` по индексу
`(agent_run_id, observed_at, id)` и состояние из `agent_run_activity_state`.

`LIST_AGENT_RUN_ACTIVITY` возвращает `{ entries, omittedCount, degraded }`, читая `agent_run_activity` по
`(agent_run_id, observed_at, id)` и состояние из `agent_run_activity_state`.

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/persistence-sqlite test -- agent-run-activity`
Expected: PASS, три теста.

- [ ] **Шаг 7: Проверить, что миграция накатывается на существующую БД**

Run: `pnpm --filter @loomrail/persistence-sqlite test`
Expected: PASS, включая существующие тесты миграций и `PRAGMA foreign_key_check`.

- [ ] **Шаг 8: Commit** (по просьбе владельца)

```bash
git add packages/persistence-sqlite
git commit -m "feat(persistence): store prunable agent run activity"
```

---

### Task 7: Recorder в session-loop

**Files:**

- Modify: `apps/daemon/src/session-loop.ts:1416-1600` (литерал `listener`)
- Test: `apps/daemon/test/session-activity.integration.test.ts`

**Interfaces:**

- Consumes: `RECORD_AGENT_RUN_ACTIVITY` (Task 6), `onActivity` (Task 5).

- [ ] **Шаг 1: Написать падающий тест «сбой записи не валит прогон»**

```ts
import { describe, expect, it } from "vitest";

describe("activity recorder", () => {
  it("finishes the run and marks the feed degraded when every write throws", async () => {
    const outcome = await runSessionWithFailingActivityWriter();
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.activity.degraded).toBe(true);
    expect(outcome.usage).toEqual(outcome.expectedUsage);
  });

  it("rejects an entry that does not satisfy the contract without failing the run", async () => {
    const outcome = await runSessionEmitting({ actionKey: "", kind: "TOOL_CALL" });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.activity.entries).toHaveLength(0);
  });
});
```

Хелперы строятся на существующей инфраструктуре `apps/daemon/test`, где адаптер инжектируется в `startDaemon`.

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/daemon test -- session-activity`
Expected: FAIL.

- [ ] **Шаг 3: Реализовать `onActivity` в литерале листенера**

Добавить в объект `listener` рядом с `onProcessStarted`:

```ts
      onActivity: (reported) => {
        if (live.closed || isAuthorityRevoked(authoritySignal)) return;
        const validated = providerActivityEntrySchema.safeParse(reported);
        if (!validated.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider reported an action that does not satisfy the contract",
          );
          return;
        }
        // Same guard as `onProcessStarted`: this runs synchronously inside the adapter's stdout
        // handler, where a throw kills the child and fails the session. Losing the diagnostic is
        // the correct outcome; killing the run it was diagnosing is not.
        try {
          deps.state.execute({
            schemaVersion: 1,
            commandId: `activity-${providerSession.id}-${validated.data.actionKey}-${validated.data.terminal ? "end" : "start"}`,
            correlationId: deps.correlationId,
            actor,
            type: "RECORD_AGENT_RUN_ACTIVITY",
            payload: {
              agentRunId,
              providerSessionId: providerSession.id,
              provider: invocationProvider,
              entry: validated.data,
            },
          });
        } catch (error: unknown) {
          live.activityDegraded = true;
          deps.logger.debug(
            { providerSessionId: providerSession.id, error: errorName(error) },
            "An action could not be recorded; the activity feed for this run is degraded",
          );
          return;
        }
        publishActivitySignal();
      },
```

- [ ] **Шаг 3b: Редактировать и нормализовать перед записью**

Между валидацией и записью прогнать `label`, `detail` и `status` через `sanitizeSupervisedOutput` из
`@loomrail/process-supervision` с тем же набором redaction values, который получает workspace executor, и
нормализовать пути относительно worktree:

```ts
const sanitizeEntry = (entry: ProviderActivityEntry): ProviderActivityEntry => {
  const clean = (value: string | null): string | null =>
    value === null ? null : sanitizeSupervisedOutput(value, deps.redactValues).trim() || null;
  const label = clean(entry.label);
  const detail = clean(entry.detail);
  return {
    ...entry,
    // A path that does not resolve inside the worktree is reported as an opaque marker: an
    // absolute personal path is exactly what SD-003 keeps out, and a provider is free to name one.
    label: entry.kind === "FILE_CHANGE" ? relativeToWorkspace(label, deps.workspacePath) : label,
    detail: entry.kind === "FILE_CHANGE" ? relativeToWorkspace(detail, deps.workspacePath) : detail,
    status: clean(entry.status),
  };
};
```

`relativeToWorkspace` возвращает `"[path outside workspace]"` для значения, которое после нормализации выходит за
пределы worktree, и живёт рядом с recorder, а не в адаптере: адаптер не знает, где worktree.

Тест на это добавляется в Task 11 вместе с канарейкой.

- [ ] **Шаг 4: Добавить дебаунс сигнала**

Рядом с объявлением `live` добавить:

```ts
// The activity feed is not an Event, so `broadcastingState` does not publish for it. It signals
// directly -- and at most once per interval, because a chatty run would otherwise turn one
// agent into a stream of signals for every open browser tab.
let activitySignalPending = false;
const publishActivitySignal = (): void => {
  if (activitySignalPending) return;
  activitySignalPending = true;
  const timer = setTimeout(() => {
    activitySignalPending = false;
    deps.publishSignal({
      projectId: deps.projectId,
      aggregateType: "WORK_ITEM",
      aggregateId: deps.workItemId,
    });
  }, ACTIVITY_SIGNAL_DEBOUNCE_MS);
  timer.unref();
};
```

`ACTIVITY_SIGNAL_DEBOUNCE_MS = 250` объявить рядом с прочими константами модуля. `deps.publishSignal` пробросить
из `startDaemon` — это та же функция `publish`, которую получает `broadcastingState`.

- [ ] **Шаг 5: Записать `degraded` при завершении сессии**

В ветке завершения сессии, где уже пишется её исход, добавить установку `degraded = 1` в
`agent_run_activity_state`, если `live.activityDegraded`. То же самое делает путь восстановления после рестарта
демона для прогона, найденного незавершённым: его буфер потерян, и лента обязана сказать об этом, а не выглядеть
полной.

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/daemon test -- session-activity`
Expected: PASS, два теста.

- [ ] **Шаг 7: Commit** (по просьбе владельца)

```bash
git add apps/daemon/src/session-loop.ts apps/daemon/test/session-activity.integration.test.ts
git commit -m "feat(daemon): record provider activity without risking the run"
```

---

### Task 8: Объединённая лента и роут

**Files:**

- Create: `apps/daemon/src/agent-run-activity.ts`
- Modify: `apps/daemon/src/server.ts` (рядом с роутом `/api/v1/verification-checks/:checkId/output`)
- Test: `apps/daemon/test/agent-run-activity.unit.test.ts`

**Interfaces:**

- Produces: `mergeRunActivity(...)`, `GET /api/v1/agent-runs/:runId/activity`.

- [ ] **Шаг 1: Написать падающий тест на слияние**

```ts
import { describe, expect, it } from "vitest";

import { mergeRunActivity } from "../src/agent-run-activity.js";

const audited = { id: "w1", at: "2026-09-14T10:00:00.000Z", origin: "DAEMON_AUDITED" } as const;
const reported = { id: "a1", at: "2026-09-14T10:00:00.000Z", origin: "PROVIDER_REPORTED" } as const;

describe("mergeRunActivity", () => {
  it("orders by time, then origin, then id, so equal timestamps are stable", () => {
    const first = mergeRunActivity([audited], [reported]).map((entry) => entry.id);
    const second = mergeRunActivity([reported], [audited]).map((entry) => entry.id);
    expect(first).toEqual(second);
  });

  it("marks each entry with the origin of its source, never with a provider-supplied value", () => {
    const merged = mergeRunActivity([audited], [reported]);
    expect(merged.map((entry) => entry.origin)).toEqual(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/daemon test -- agent-run-activity`
Expected: FAIL.

- [ ] **Шаг 3: Реализовать слияние и курсор**

```ts
const ORIGIN_ORDER: Readonly<Record<ActivityOrigin, number>> = {
  DAEMON_AUDITED: 0,
  PROVIDER_REPORTED: 1,
};

/**
 * Orders the two sources into one feed.
 *
 * Three keys, not one: two entries can share a timestamp to the millisecond, and an order that
 * depends on which source was read first would reshuffle the page between two identical requests
 * and make the cursor skip or repeat rows.
 */
export const mergeRunActivity = (
  audited: readonly AgentRunActivityEntry[],
  reported: readonly AgentRunActivityEntry[],
): readonly AgentRunActivityEntry[] =>
  [...audited, ...reported].sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] ||
      left.id.localeCompare(right.id),
  );

const cursorSchema = z
  .object({ at: z.string().datetime(), origin: activityOriginSchema, id: z.string().min(1) })
  .strict();

export const encodeCursor = (entry: AgentRunActivityEntry): string =>
  Buffer.from(JSON.stringify({ at: entry.at, origin: entry.origin, id: entry.id })).toString("base64url");

// A cursor is client-supplied input like any other: decoded through the schema, never trusted to
// be the value this daemon handed out.
export const decodeCursor = (value: string): z.infer<typeof cursorSchema> | null => {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
```

Если декодированная позиция старше самой ранней удержанной записи, страница отдаётся с начала окна и `gap: true`.

- [ ] **Шаг 4: Добавить роут**

Скопировать обвес роута `/api/v1/verification-checks/:checkId/output`: `requireSession`, `requestCorrelationId`,
`cache-control: no-store`, `x-content-type-options: nosniff`. Ответ — JSON по `agentRunActivityPageSchema`.

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/daemon test -- agent-run-activity`
Expected: PASS.

- [ ] **Шаг 6: Commit** (по просьбе владельца)

```bash
git add apps/daemon/src/agent-run-activity.ts apps/daemon/src/server.ts apps/daemon/test/agent-run-activity.unit.test.ts
git commit -m "feat(daemon): serve the merged agent run activity feed"
```

---

### Task 9: Run Activity в Task Cockpit

**Files:**

- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/views/WorkbenchPage.tsx:1323-1340` (убрать workspace-tool события из Activity)
- Create: `apps/web/src/components/RunActivitySection.tsx`
- Modify: `apps/web/src/i18n.tsx` (ключи в обеих локалях)
- Test: `apps/web/src/components/RunActivitySection.test.tsx`

- [ ] **Шаг 1: Написать падающий тест**

```tsx
import { describe, expect, it } from "vitest";

import { render, screen } from "@testing-library/react";

import { RunActivitySection } from "./RunActivitySection";

describe("RunActivitySection", () => {
  it("collapses to the latest action and a count", () => {
    render(<RunActivitySection entries={threeEntries} omittedCount={0} degraded={false} gap={false} />);
    expect(screen.getByRole("button", { name: /3/ })).toBeInTheDocument();
  });

  it("distinguishes a daemon-audited action from a provider report without relying on colour", () => {
    render(<RunActivitySection entries={mixedEntries} omittedCount={0} degraded={false} gap={false} />);
    expect(screen.getByText(/проверено Loomrail|verified by Loomrail/i)).toBeInTheDocument();
    expect(screen.getByText(/со слов провайдера|as reported by the provider/i)).toBeInTheDocument();
  });

  it("says when entries were dropped rather than showing a silent hole", () => {
    render(<RunActivitySection entries={threeEntries} omittedCount={12} degraded={false} gap={false} />);
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it("renders provider text as text, not as markup", () => {
    render(<RunActivitySection entries={hostileEntries} omittedCount={0} degraded={false} gap={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/web test -- RunActivitySection`
Expected: FAIL — компонент не существует.

- [ ] **Шаг 3: Реализовать компонент**

Секция сворачивается до последнего действия и счётчика; раскрытая показывает список с меткой происхождения
текстом, а не цветом. Использовать существующие примитивы `@loomrail/ui` и семантические токены; свои статус-цвета
не вводить. Клавиатурная навигация и видимый фокус — сразу.

- [ ] **Шаг 4: Убрать дублирование в Activity**

В `WorkbenchPage.tsx` удалить ветку, рендерящую `WORKSPACE_TOOL_CALL_CHANGED` как запись Activity
(строки 1323–1340). Ключи `event.workspaceToolCall*` в `i18n.tsx` удалить, ключи `workspaceTool.operation.*` и
`workspaceTool.status.*` сохранить — они переиспользуются Run Activity.

- [ ] **Шаг 5: Подключить запрос и обновление по сигналу**

В `api.ts` добавить `useAgentRunActivity(agentRunId)` с курсорной подгрузкой; инвалидация — по сигналу канала для
соответствующего WorkItem, тем же способом, каким это делают существующие запросы.

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/web test`
Expected: PASS, включая существующие тесты `WorkbenchPage`.

- [ ] **Шаг 7: Проверить темы и клавиатуру вручную**

Запустить приложение, открыть Task Cockpit с завершённым прогоном, проверить светлую и тёмную темы, обход с
клавиатуры, видимый фокус и различимость происхождения без цвета.

- [ ] **Шаг 8: Commit** (по просьбе владельца)

```bash
git add apps/web/src
git commit -m "feat(web): show one merged run activity feed in the task cockpit"
```

---

### Task 10: Колонка «сейчас» в Agent Fleet

**Files:**

- Modify: `apps/daemon/src/agent-fleet.ts`
- Modify: `packages/contracts/src/agents.ts` (`AgentFleetEntry`)
- Modify: `apps/web/src/views/AgentFleetPage.tsx:86-92,105-120`
- Modify: `apps/web/src/i18n.tsx`
- Test: `apps/daemon/test/agent-fleet.unit.test.ts`

- [ ] **Шаг 1: Написать падающий тест**

```ts
it("reports the latest action of a running entry and null when there is none", () => {
  const entries = buildFleet(fixtureWithActivity);
  expect(entries[0]?.latestAction).toEqual({ label: "pnpm test", origin: "PROVIDER_REPORTED" });
  expect(buildFleet(fixtureWithoutActivity)[0]?.latestAction).toBeNull();
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `pnpm --filter @loomrail/daemon test -- agent-fleet`
Expected: FAIL — поля `latestAction` нет.

- [ ] **Шаг 3: Добавить `latestAction` в контракт и проекцию**

Поле nullable; читается одной выборкой последней записи на прогон, без N+1 по прогонам.

- [ ] **Шаг 4: Добавить колонку в таблицу**

Заголовок `fleet.column.latestAction`, ячейка с `data-label`, прочерк с `aria-label` при `null` — как уже сделано
для `fleet.notStarted`. Таблица остаётся таблицей; сетка карточек не вводится.

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `pnpm --filter @loomrail/daemon test && pnpm --filter @loomrail/web test`
Expected: PASS.

- [ ] **Шаг 6: Commit** (по просьбе владельца)

```bash
git add packages/contracts/src/agents.ts apps/daemon/src/agent-fleet.ts apps/web/src
git commit -m "feat(web): show the latest action of each running agent in the fleet"
```

---

### Task 11: Канарейки утечек и E2E

**Files:**

- Create: `apps/daemon/test/agent-run-activity-leak.integration.test.ts`
- Create: `e2e/run-activity.spec.ts`

- [ ] **Шаг 1: Написать канарейку**

```ts
const CANARY = "lmr-canary-7f3a9c";

it("keeps a secret that appeared in a command out of every owner-visible export", async () => {
  const world = await runWithActivityContaining(CANARY);
  expect(JSON.stringify(await world.acceptancePackage())).not.toContain(CANARY);
  expect(JSON.stringify(await world.evidencePackage())).not.toContain(CANARY);
  expect(JSON.stringify(await world.insightsPayload())).not.toContain(CANARY);
  expect(JSON.stringify(await world.crashPayload())).not.toContain(CANARY);
  expect(await world.exportedLogs()).not.toContain(CANARY);
});

it("redacts a configured secret before it reaches storage", async () => {
  const world = await runWithActivityContaining(CANARY, { redactValues: [CANARY] });
  const page = await world.activity();
  expect(JSON.stringify(page)).not.toContain(CANARY);
  expect(JSON.stringify(page)).toContain("[REDACTED]");
});
```

- [ ] **Шаг 2: Убедиться, что канарейка падает до redaction и проходит после**

Run: `pnpm --filter @loomrail/daemon test -- agent-run-activity-leak`
Expected: сначала FAIL на втором тесте, затем PASS после подключения `sanitizeSupervisedOutput` в пути записи.

- [ ] **Шаг 2b: Добавить кросс-платформенные фикстуры**

Прогнать парсеры и путь записи на путях с пробелами и не-ASCII (`fixtures/пример проект/файл тест.ts`): macOS и
Windows — блокирующие платформы, и нормализация путей ломается именно на них.

- [ ] **Шаг 3: Написать E2E**

По образцу `e2e/event-channel.spec.ts`: запустить прогон, дождаться появления записей в Run Activity без
перезагрузки страницы, развернуть секцию, проверить, что одно workspace-действие показано ровно один раз.

- [ ] **Шаг 4: Прогнать E2E**

Run: `pnpm test:e2e -- run-activity`
Expected: PASS.

- [ ] **Шаг 5: Commit** (по просьбе владельца)

```bash
git add apps/daemon/test/agent-run-activity-leak.integration.test.ts e2e/run-activity.spec.ts
git commit -m "test: pin activity redaction and the absence of duplicate run entries"
```

---

### Task 12: ADR и дельта threat-model

**Files:**

- Create: `docs/adr/0029-diagnostic-provider-activity.md`
- Modify: `docs/security/THREAT-MODEL.md`
- Modify: `docs/product/PRODUCT-DECISIONS.ru.md` (UXD-002, уточнение)

- [ ] **Шаг 1: Написать ADR**

Контекст: адаптеры намеренно отбрасывали сообщения провайдера о собственных действиях, и в
`packages/provider-codex/src/stream.ts` для этого записан явный rationale. Решение: bounded, отредактированная,
прунимая проекция без authority; сырой поток остаётся незаписанным. Последствия: новая поверхность недоверенного
текста в UI, новая таблица вне append-only истории, различие origin обязано остаться видимым.

- [ ] **Шаг 2: Обновить threat-model**

В секции Q7 сохранить утверждение о сыром stdout/stderr — оно остаётся истинным — и добавить дельту про уровень 1:
какие поля записываются, чем ограничены, чем редактируются, и какие проверки это доказывают.

- [ ] **Шаг 3: Проверить непротиворечивость документов**

Run: `pnpm test:public-readiness`
Expected: PASS.

- [ ] **Шаг 4: Полная проверка**

Run: `pnpm verify`
Expected: PASS.

- [ ] **Шаг 5: Commit** (по просьбе владельца)

```bash
git add docs
git commit -m "docs: record the diagnostic provider activity boundary change"
```
