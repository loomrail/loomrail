import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { ContextWindowUsage, ProviderOutcome, ProviderUsage } from "@loomrail/contracts";
import type { ProviderAdapter, ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeCodeProvider } from "../src/index.js";

const fakeClaudePath = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

// --- Test scaffolding -------------------------------------------------------------------------
//
// `recordSpawn`, `startWith`, `runAgainstRecording`, `fakeClaudePath` mirror provider-codex's own
// helpers of the same names (packages/provider-codex/test/adapter.unit.test.ts) almost exactly --
// per the project's convention, they are written here because this is the first task that needs a
// `claude`-flavoured version of them (the record shape differs: no `stdinClosed`, since nothing in
// this adapter depends on stdin being closed the way provider-codex's does), and a later task that
// needs the same thing reuses this module rather than copying it again.

type Spawned = { args: string[]; readonly recordPath: string };

const recordSpawn = (): Spawned => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-claude-test-"));
  return { args: [], recordPath: join(dir, "spawn-record.json") };
};

const withEnv = async <T>(name: string, value: string, run: () => Promise<T>): Promise<T> => {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  }
};

const fixtureInvocation = (sessionId = "session-1"): ProviderInvocation => ({
  dispatch: {
    schemaVersion: 1,
    id: "dispatch-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    pipelineRunId: "run-1",
    stageAttemptId: "attempt-1",
    mode: "START",
    status: "PENDING",
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: null,
  },
  session: {
    id: sessionId,
    ordinal: 1,
    stageAttemptId: "attempt-1",
    stage: "DISCOVERY",
    attempt: 1,
  },
  contextPack: {
    schemaVersion: 1,
    text: "Discover the requirements for the payments retry policy.",
    contentHash: `sha256:${"0".repeat(64)}`,
  },
});

const noopListener = (): ProviderSessionListener => ({
  onContextWindow: () => undefined,
  onCheckpoint: () => undefined,
  onUsage: () => undefined,
});

// Runs `adapter.start()` once against `fakeClaudePath` with `spawned.recordPath` wired in, then
// fills `spawned.args` in from what the fake process recorded about itself.
const startWith = async (spawned: Spawned, adapter: ProviderAdapter): Promise<ProviderOutcome> => {
  const outcome = await withEnv("FAKE_CLAUDE_RECORD_PATH", spawned.recordPath, () =>
    adapter.start(fixtureInvocation(), noopListener()),
  );
  const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as { args: string[] };
  spawned.args = recorded.args;
  return outcome;
};

// Runs the adapter against a JSONL stream recorded from the real `claude -p --output-format
// stream-json` CLI (see recordings/ -- never a made-up fixture), by pointing `fakeClaudePath` at
// it instead of spawning the live CLI.
const runAgainstRecording = async (
  file: string,
  listener: Partial<ProviderSessionListener> = {},
  options: { contextWindowTokens?: number; maxBudgetUsd?: number } = {},
): Promise<ProviderOutcome> => {
  const recordingPath = fileURLToPath(new URL(`./recordings/${file}`, import.meta.url));
  const adapter = createClaudeCodeProvider({
    command: fakeClaudePath,
    ...(options.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: options.contextWindowTokens }),
    ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
  });
  return withEnv("FAKE_CLAUDE_OUTPUT_FILE", recordingPath, () =>
    adapter.start(fixtureInvocation(), { ...noopListener(), ...listener }),
  );
};

// Polls a file the fake process writes on its own, synchronously, as soon as it starts hanging
// (see FAKE_CLAUDE_HANG_MARKER_PATH in the fixture) -- there is no other signal available for
// "the child is now running and its pid is known".
const waitForHangMarker = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const marker = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      return marker.pid;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("fake-claude.mjs never announced its pid");
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// --- Tests -------------------------------------------------------------------------------------

describe("createClaudeCodeProvider", () => {
  afterEach(() => {
    delete process.env["FAKE_CLAUDE_RECORD_PATH"];
    delete process.env["FAKE_CLAUDE_OUTPUT_FILE"];
    delete process.env["FAKE_CLAUDE_HANG_MARKER_PATH"];
  });

  it("declares itself as Claude Code and reports cost, which Codex cannot", () => {
    const capabilities = createClaudeCodeProvider().capabilities();
    expect(capabilities.provider).toBe("CLAUDE_CODE");
    expect(capabilities.costReporting).toBe(true);
  });

  // Task 1's reconnaissance could not confirm an injection channel into a running session (the
  // CLI here is not authenticated) -- the controller ruling for this task is to declare the
  // capability false rather than build an unverified injection path.
  it("declares no mid-session handoff channel", () => {
    expect(createClaudeCodeProvider().capabilities().checkpointOnRequest).toBe(false);
  });

  // SD-001 again, and for this CLI there are two flags to stay away from, not one.
  it("never builds a command carrying a permission-bypass flag", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const line = spawned.args.join(" ");
    expect(line).not.toContain("dangerously");
    expect(line).not.toContain("bypassPermissions");
  });

  // The other half of the controller ruling above: not only must `checkpointOnRequest` read
  // `false`, the command line actually launched must not carry the one flag that channel would
  // have needed.
  it("never builds a command carrying the unverified stream-json input channel", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    expect(spawned.args).not.toContain("--input-format");
  });

  it("runs in plan mode, with no session persisted", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const permissionModeIndex = spawned.args.indexOf("--permission-mode");
    expect(permissionModeIndex).toBeGreaterThanOrEqual(0);
    expect(spawned.args[permissionModeIndex + 1]).toBe("plan");
    expect(spawned.args).toContain("--no-session-persistence");
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

  // `hello.jsonl`'s recorded `usage` object carries real, distinct-enough-to-not-be-confused-with-
  // each-other figures (input 4, output 214, cache_read 17038) -- this is the fact FINDING 1 named:
  // `parseClaudeEvent` surfaces real token counts, and the adapter must forward them rather than
  // reporting zeros tagged `ACTUAL`. `cachedInputTokens` is asserted against `cache_read_input_tokens`
  // specifically -- see the mapping rationale in `stream.ts`'s `ClaudeEvent` doc comment.
  it("reports the token counts the CLI reports, not zeros", async () => {
    const usages: ProviderUsage[] = [];
    await runAgainstRecording("hello.jsonl", { onUsage: (usage) => usages.push(usage) });
    expect(usages.at(-1)).toMatchObject({
      inputTokens: 4,
      outputTokens: 214,
      cachedInputTokens: 17038,
      quality: "ACTUAL",
    });
  });

  // Spec §7 declares `contextWindowReporting: true` for this adapter, on the grounds that usage
  // arrives in the stream -- this is the test behind that capability (mirrors provider-codex's
  // identical "reports window occupancy..." test). `usedTokens` must be the recording's real
  // `input_tokens` (4), not an estimate, and `windowTokens` the declared window passed at
  // construction.
  it("reports window occupancy from the input tokens the CLI reports, not an estimate", async () => {
    // Asserted alongside the behaviour, in the same test, on purpose: a capability and the
    // behaviour behind it must not be able to drift apart. `capabilities()` claiming `true` while
    // nothing calls `onContextWindow` (or vice versa) is exactly the gap this single test is
    // built to catch either half of.
    expect(createClaudeCodeProvider().capabilities().contextWindowReporting).toBe(true);

    const seen: ContextWindowUsage[] = [];
    await runAgainstRecording(
      "hello.jsonl",
      { onContextWindow: (usage) => seen.push(usage) },
      { contextWindowTokens: 200_000 },
    );
    expect(seen.at(-1)).toEqual({ usedTokens: 4, windowTokens: 200_000, quality: "ACTUAL" });
  });

  // `hello.jsonl`'s terminal result is JSON conforming to checkpointDraftSchema (what
  // `--json-schema` is supposed to produce on success) -- the adapter must both publish it via
  // `onCheckpoint` and use its `summary` field as the outcome's, not the raw wire text.
  it("completes the stage from the structured checkpoint the CLI returns", async () => {
    const checkpoints: unknown[] = [];
    const outcome = await runAgainstRecording("hello.jsonl", {
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });
    expect(outcome).toEqual({
      type: "COMPLETED",
      summary: "Captured the payments retry policy requirements and confirmed the existing retry code path.",
    });
    expect(checkpoints).toHaveLength(1);
  });

  // requestHandoff is declared unsupported; it must be a no-op that *resolves* rather than an
  // error, because the session loop calls it whenever the occupancy threshold is crossed and
  // cannot know which adapter it is talking to -- rejecting would break a loop behaving
  // correctly.
  it("accepts a handoff request without doing anything and without failing", async () => {
    await expect(createClaudeCodeProvider().requestHandoff("providerSession-1")).resolves.toBeUndefined();
  });

  it("removes its per-session working directory once the session ends", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const schemaFlagIndex = spawned.args.indexOf("--json-schema");
    expect(schemaFlagIndex).toBeGreaterThanOrEqual(0);
    const schemaPath = spawned.args[schemaFlagIndex + 1];
    if (schemaPath === undefined) {
      throw new Error("expected --json-schema to be followed by the schema file it names");
    }
    expect(existsSync(dirname(schemaPath))).toBe(false);
  });

  // Same cleanup, on the failure path: a session that ends in CONTEXT_EXHAUSTED (the auth-failure
  // recording) must not leak its working directory either.
  it("removes its per-session working directory even when the session fails", async () => {
    const recordingPath = fileURLToPath(new URL("./recordings/not-logged-in.jsonl", import.meta.url));
    let capturedDir: string | undefined;
    await withEnv("FAKE_CLAUDE_OUTPUT_FILE", recordingPath, async () => {
      const spawned = recordSpawn();
      await withEnv("FAKE_CLAUDE_RECORD_PATH", spawned.recordPath, () =>
        createClaudeCodeProvider({ command: fakeClaudePath }).start(fixtureInvocation(), noopListener()),
      );
      const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as { args: string[] };
      const schemaFlagIndex = recorded.args.indexOf("--json-schema");
      const schemaPath = recorded.args[schemaFlagIndex + 1];
      if (schemaPath === undefined) {
        throw new Error("expected --json-schema to be followed by the schema file it names");
      }
      capturedDir = dirname(schemaPath);
    });
    if (capturedDir === undefined) throw new Error("working directory was never captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  // A spawn failure (missing executable) must become a session failure, not an unhandled
  // rejection that would take the daemon down with it.
  it("reports a session failure, not an unhandled rejection, when the executable cannot be spawned", async () => {
    const adapter = createClaudeCodeProvider({
      command: join(tmpdir(), "loomrail-claude-code-test-does-not-exist"),
    });
    await expect(adapter.start(fixtureInvocation(), noopListener())).resolves.toEqual({
      type: "CONTEXT_EXHAUSTED",
    });
  });

  // The defect provider-codex's milestone was named for closing, and this adapter must not
  // reopen: the OS process table, not this module's own bookkeeping, is the ground truth (mirrors
  // provider-core's own test of `runProcess.stop` for the same reason).
  it("waits for the child to actually exit before resolving abortSession", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "loomrail-claude-test-"));
    const markerPath = join(markerDir, "hang-marker.json");
    process.env["FAKE_CLAUDE_HANG_MARKER_PATH"] = markerPath;

    const adapter = createClaudeCodeProvider({ command: fakeClaudePath });
    const sessionId = "session-abort-1";
    const started = adapter.start(fixtureInvocation(sessionId), noopListener());

    const pid = await waitForHangMarker(markerPath);
    expect(isAlive(pid)).toBe(true);

    await adapter.abortSession(sessionId);
    expect(isAlive(pid)).toBe(false);

    await started;
  });
});
