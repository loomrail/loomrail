import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextWindowUsage, ProviderOutcome, ProviderUsage } from "@loomrail/contracts";
import type { ProviderAdapter, ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexProvider } from "../src/index.js";

const fakeCodexPath = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

// --- Test scaffolding -------------------------------------------------------------------------
//
// These helpers (`recordSpawn`, `startWith`, `runAgainstRecording`, `fakeCodexPath`) do not exist
// anywhere else in the repository yet; they are written here, in the test file of the task that
// first needs them, as the project's convention directs. A later task that needs the same thing
// reuses this module rather than copying it.

// Reads back what `fakeCodexPath` recorded about the one invocation it saw (see
// FAKE_CODEX_RECORD_PATH in the fixture). `args`/`stdinClosed` start empty/false and are filled in
// by `startWith` once the adapter's `start()` call has actually finished.
type Spawned = { args: string[]; stdinClosed: boolean; readonly recordPath: string };

const recordSpawn = (): Spawned => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-codex-test-"));
  return { args: [], stdinClosed: false, recordPath: join(dir, "spawn-record.json") };
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

// Runs `adapter.start()` once against `fakeCodexPath` with `spawned.recordPath` wired in, then
// fills `spawned.args`/`spawned.stdinClosed` in from what the fake process recorded about itself.
const startWith = async (spawned: Spawned, adapter: ProviderAdapter): Promise<ProviderOutcome> => {
  const outcome = await withEnv("FAKE_CODEX_RECORD_PATH", spawned.recordPath, () =>
    adapter.start(fixtureInvocation(), noopListener()),
  );
  const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as {
    args: string[];
    stdinClosed: boolean;
  };
  spawned.args = recorded.args;
  spawned.stdinClosed = recorded.stdinClosed;
  return outcome;
};

// Runs the adapter against a JSONL stream recorded from a real `codex exec --json` run (never a
// made-up fixture -- see recordings/), by pointing `fakeCodexPath` at it instead of spawning the
// live CLI.
const runAgainstRecording = async (
  file: string,
  listener: Partial<ProviderSessionListener> = {},
  options: { contextWindowTokens?: number } = {},
): Promise<ProviderOutcome> => {
  const recordingPath = fileURLToPath(new URL(`./recordings/${file}`, import.meta.url));
  const adapter = createCodexProvider({
    command: fakeCodexPath,
    ...(options.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: options.contextWindowTokens }),
  });
  return withEnv("FAKE_CODEX_OUTPUT_FILE", recordingPath, () =>
    adapter.start(fixtureInvocation(), { ...noopListener(), ...listener }),
  );
};

// Polls a file the fake process writes on its own, synchronously, as soon as it starts hanging
// (see FAKE_CODEX_HANG_MARKER_PATH in the fixture) -- there is no other signal available for
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
  throw new Error("fake-codex.mjs never announced its pid");
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

describe("createCodexProvider", () => {
  afterEach(() => {
    delete process.env["FAKE_CODEX_RECORD_PATH"];
    delete process.env["FAKE_CODEX_OUTPUT_FILE"];
    delete process.env["FAKE_CODEX_HANG_MARKER_PATH"];
  });

  it("declares itself as Codex and serves only the stages it can serve without a repository", () => {
    const capabilities = createCodexProvider().capabilities();
    expect(capabilities.provider).toBe("CODEX");
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "REVIEW"]);
    expect(capabilities.checkpointOnRequest).toBe(false);
  });

  // Established by probing the real CLI: without these two the adapter either hangs or is
  // refused.
  it("runs with stdin closed and the trusted-directory check skipped", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    expect(spawned.args).toContain("--skip-git-repo-check");
    expect(spawned.stdinClosed).toBe(true);
  });

  // SD-001 forbids enabling a permission bypass automatically; this is the test, not the
  // convention.
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

  // requestHandoff is declared unsupported; it must be a no-op rather than an error, because the
  // loop calls it whenever the threshold is crossed and cannot know which adapter it is talking
  // to.
  it("accepts a handoff request without doing anything and without failing", async () => {
    await expect(createCodexProvider().requestHandoff("providerSession-1")).resolves.toBeUndefined();
  });

  // `--output-schema` is what lets a one-shot `codex exec` deliver a structured answer instead of
  // free prose. `completed.jsonl` reuses `hello.jsonl`'s real recorded lines and appends one
  // final line shaped by `checkpointDraftSchema` itself (no repository recording of a real
  // `--output-schema` run exists in this environment to capture one from) -- not wrapped in the
  // `--json` stream's own event envelope, exactly as the CLI's structured-output behaviour is
  // documented to produce.
  it("completes the stage from the structured final answer, when one arrives", async () => {
    const outcome = await runAgainstRecording("completed.jsonl");
    expect(outcome).toEqual({
      type: "COMPLETED",
      summary: "Reviewed the proposed diff and found no blocking issues.",
    });
  });

  // `hello.jsonl` ends on a plain `turn.completed`, with no structured final line -- the honest
  // outcome for a one-shot process that produced nothing to hand off.
  it("reports context exhaustion when the process ends without a structured answer", async () => {
    const outcome = await runAgainstRecording("hello.jsonl");
    expect(outcome).toEqual({ type: "CONTEXT_EXHAUSTED" });
  });

  it("removes its per-session working directory once the session ends", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    const dirFlagIndex = spawned.args.indexOf("-C");
    expect(dirFlagIndex).toBeGreaterThanOrEqual(0);
    const workingDir = spawned.args[dirFlagIndex + 1];
    if (workingDir === undefined) {
      throw new Error("expected -C to be followed by the working directory it names");
    }
    expect(existsSync(workingDir)).toBe(false);
  });

  // The defect this milestone is named for closing: the previous milestone's adapter resolved
  // `abortSession` without the process actually having stopped. The OS process table, not this
  // module's own bookkeeping, is the ground truth (mirrors provider-core's own test of
  // `runProcess.stop` for the same reason).
  it("waits for the child to actually exit before resolving abortSession", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "loomrail-codex-test-"));
    const markerPath = join(markerDir, "hang-marker.json");
    process.env["FAKE_CODEX_HANG_MARKER_PATH"] = markerPath;

    const adapter = createCodexProvider({ command: fakeCodexPath });
    const sessionId = "session-abort-1";
    const started = adapter.start(fixtureInvocation(sessionId), noopListener());

    const pid = await waitForHangMarker(markerPath);
    expect(isAlive(pid)).toBe(true);

    await adapter.abortSession(sessionId);
    expect(isAlive(pid)).toBe(false);

    await started;
  });
});
