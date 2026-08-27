import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type {
  ContextWindowUsage,
  HumanRequestDraft,
  ProviderOutcome,
  ProviderUsage,
} from "@loomrail/contracts";
import type { ProviderAdapter, ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeCodeProvider } from "../src/index.js";

const fakeClaudePath = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

// SD-001 forbids Loomrail from ever enabling a provider's permission-bypass mode automatically --
// every spelling either CLI accepts for that bypass is named here once, so that a future CLI
// version adding another one is a decision someone makes to this list, not something that quietly
// never happens. Shared verbatim with provider-codex's own copy of this list (no test-only module
// is common to both packages yet, so -- per this task's own convention for helpers needed by two
// packages -- duplicating a four-line constant is preferable to creating one for this alone).
//
// `--dangerously-bypass-hook-trust` (post-review addition, see provider-codex's own copy of this
// comment): a `codex exec --help` flag, not a `claude --help` one -- kept in this file's copy of
// the list anyway, verbatim with provider-codex's, per the same "shared verbatim" convention that
// already put Codex's `--dangerously-bypass-approvals-and-sandbox` here.
const FORBIDDEN_PERMISSION_BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--permission-mode bypassPermissions",
];

// --- Test scaffolding -------------------------------------------------------------------------
//
// `recordSpawn`, `startWith`, `runAgainstRecording`, `fakeClaudePath` mirror provider-codex's own
// helpers of the same names (packages/provider-codex/test/adapter.unit.test.ts) almost exactly --
// per the project's convention, they are written here because this is the first task that needs a
// `claude`-flavoured version of them (the record shape differs: no `stdinClosed`, since nothing in
// this adapter depends on stdin being closed the way provider-codex's does), and a later task that
// needs the same thing reuses this module rather than copying it again.

type Spawned = { args: string[]; cwd: string; readonly recordPath: string };

const recordSpawn = (): Spawned => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-claude-test-"));
  return { args: [], cwd: "", recordPath: join(dir, "spawn-record.json") };
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
  const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as { args: string[]; cwd: string };
  spawned.args = recorded.args;
  spawned.cwd = recorded.cwd;
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

// Runs the adapter against an ad-hoc stream written out as a temporary file. Used ONLY where the
// point of the test is a stream no CLI observed here produces (a wrong-flag stream carrying no
// JSONL at all, a result whose text is whitespace); anything asserting what the real CLI does goes
// through `runAgainstRecording` and a file in recordings/, per spec §11.
const runAgainstLines = async (
  lines: readonly string[],
  listener: Partial<ProviderSessionListener> = {},
): Promise<ProviderOutcome> => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-claude-stream-"));
  const streamPath = join(dir, "stream.jsonl");
  writeFileSync(streamPath, lines.map((line) => `${line}\n`).join(""), "utf8");
  const adapter = createClaudeCodeProvider({ command: fakeClaudePath });
  return withEnv("FAKE_CLAUDE_OUTPUT_FILE", streamPath, () =>
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

// Asserts -- rather than merely narrows -- that the outcome is the owner-facing question, and hands
// back its request. A bare `if (...) throw` would report a regression as a thrown Error instead of
// as a failed assertion, which is the difference between a test that fails and a test that crashes.
const expectNeedsHuman = (outcome: ProviderOutcome): HumanRequestDraft => {
  expect(outcome).toMatchObject({ type: "NEEDS_HUMAN" });
  if (outcome.type !== "NEEDS_HUMAN") throw new Error("unreachable: asserted immediately above");
  return outcome.request;
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

  // SD-001 again. Every named spelling is checked, not just the ones this adapter happens to
  // build today -- adding a flag to FORBIDDEN_PERMISSION_BYPASS_FLAGS is what makes a future
  // regression here fail loudly, instead of a check that only ever knew about two flags.
  it("never builds a command carrying a permission-bypass flag (SD-001)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const commandLine = spawned.args.join(" ");
    for (const forbidden of FORBIDDEN_PERMISSION_BYPASS_FLAGS) {
      expect(commandLine).not.toContain(forbidden);
    }
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

  // FINDING (post-review): neither flag was asserted by any test. Trace their absence: without
  // `--output-format stream-json` the CLI prints plain text instead of JSONL, `parseClaudeEvent`
  // returns `null` for every line, `onLine` fires and yields nothing, no `result` event is ever
  // seen -- and `start()` falls through to its initialised `CONTEXT_EXHAUSTED` default. Silent,
  // clean exit, session reported as failed, no error anywhere -- byte-for-byte the same failure
  // shape as the `--json-schema` defect this milestone already fixed once. `--verbose` is the
  // same story one step removed: the CLI requires it alongside `--print` for stream-json output,
  // so losing it produces the same silence.
  it("requests JSONL output, verbosely, so events are ever seen at all", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const outputFormatIndex = spawned.args.indexOf("--output-format");
    expect(outputFormatIndex).toBeGreaterThanOrEqual(0);
    expect(spawned.args[outputFormatIndex + 1]).toBe("stream-json");
    expect(spawned.args).toContain("--verbose");
  });

  // BD-001: the budget stops being a Loomrail estimate and becomes something the CLI enforces.
  it("passes the remaining budget to the CLI so the limit is enforced where the spending happens", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath, maxBudgetUsd: 1.25 }));
    expect(spawned.args).toContain("--max-budget-usd");
    expect(spawned.args[spawned.args.indexOf("--max-budget-usd") + 1]).toBe("1.25");
  });

  // Spec §9 line 291 promised the owner a Human Request carrying the provider's own text when the
  // CLI is not authenticated. It was never implemented: the session reported CONTEXT_EXHAUSTED, the
  // owner saw an unproductive session, and "Not logged in · Please run /login" -- the one string
  // that says what to do -- was discarded. Asserted on that string, so a request that reaches the
  // owner without the provider's words still fails.
  it("asks the owner with the CLI's own words when it reports an authentication failure", async () => {
    const outcome = await runAgainstRecording("not-logged-in.jsonl");
    const request = expectNeedsHuman(outcome);
    expect(request.blocking).toBe(true);
    expect(request.context).toContain("Not logged in");
    expect(request.context).toContain("Please run /login");
  });

  // M10: `|| "(no summary text)"` only caught the empty string. A result of "   " survived it and
  // then failed `providerOutcomeSchema`'s own `.trim().min(1)` deep inside the daemon's `execute`,
  // turning a stage the CLI had actually completed into a persistence error.
  it("completes a turn whose result text is nothing but whitespace", async () => {
    const outcome = await runAgainstLines([
      '{"type":"result","subtype":"success","is_error":false,"result":"   ","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":0}}',
    ]);
    expect(outcome).toEqual({ type: "COMPLETED", summary: "(no summary text)" });
  });

  // The other half of R25: a stream the adapter can make nothing of at all (a wrong flag makes the
  // CLI print plain text instead of JSONL) used to arrive as CONTEXT_EXHAUSTED -- a business result
  // `claude -p` never reports. The line counts are the diagnosis: three lines arrived, none of them
  // carried anything.
  it("asks the owner, naming the line counts, when nothing in the stream is usable", async () => {
    const outcome = await runAgainstLines(["not json at all", "still not json", "nor this"]);
    const request = expectNeedsHuman(outcome);
    expect(request.context).toContain("Lines received from the CLI: 3");
    expect(request.context).toContain("3 carried nothing this adapter could use");
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

  // `spawned.cwd` comes from `fake-claude.mjs`'s own `process.cwd()` (see the fixture's doc
  // comment) -- the fake process cannot report a cwd it was not actually spawned into, so this
  // is direct evidence the per-session directory existed while the "CLI" ran, not just an
  // inference from an argument's value. Nothing on the command line is a path any more (see the
  // `--json-schema` fix below), so this replaces the old approach of deriving the directory from
  // that flag's value.
  it("removes its per-session working directory once the session ends", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    expect(spawned.cwd).toContain("loomrail-claude-");
    expect(existsSync(spawned.cwd)).toBe(false);
  });

  // Same cleanup, on the failure path: a session that ends in CONTEXT_EXHAUSTED (the auth-failure
  // recording) must not leak its working directory either.
  it("removes its per-session working directory even when the session fails", async () => {
    const recordingPath = fileURLToPath(new URL("./recordings/not-logged-in.jsonl", import.meta.url));
    const spawned = recordSpawn();
    await withEnv("FAKE_CLAUDE_OUTPUT_FILE", recordingPath, () =>
      withEnv("FAKE_CLAUDE_RECORD_PATH", spawned.recordPath, () =>
        createClaudeCodeProvider({ command: fakeClaudePath }).start(fixtureInvocation(), noopListener()),
      ),
    );
    const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as { cwd: string };
    expect(recorded.cwd).toContain("loomrail-claude-");
    expect(existsSync(recorded.cwd)).toBe(false);
  });

  // FINDING (post-review): `--json-schema` takes the schema as inline JSON *text*, not a path --
  // confirmed against the installed CLI (v2.1.114): a path made it exit 0 with zero bytes on
  // stdout/stderr, silently, which `fake-claude.mjs` (it only records and replays argv; it has no
  // opinion about what the real binary does with those arguments) could never have caught on its
  // own. This test pins the *shape* of the value instead of merely its presence on disk -- it is
  // checkable without the real CLI, and it is exactly the check that would have caught the
  // original defect: the value must parse as JSON and describe a JSON Schema object, not a
  // filesystem path.
  it("passes the checkpoint schema inline, not as a file path", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const schemaFlagIndex = spawned.args.indexOf("--json-schema");
    expect(schemaFlagIndex).toBeGreaterThanOrEqual(0);
    const schemaValue = spawned.args[schemaFlagIndex + 1];
    if (schemaValue === undefined) {
      throw new Error("expected --json-schema to be followed by the schema itself");
    }
    const parsed: unknown = JSON.parse(schemaValue);
    expect(parsed).toMatchObject({ type: "object" });
    // Not a path: nothing in the working directory the adapter created should exist there for
    // this flag to have named.
    expect(existsSync(schemaValue)).toBe(false);
  });

  // A spawn failure (missing executable) must become a session failure, not an unhandled
  // rejection that would take the daemon down with it -- and the question must name the executable,
  // because installing it or fixing PATH is the only fix and Loomrail cannot make it.
  it("asks the owner, naming the executable, when it cannot be spawned", async () => {
    const missing = join(tmpdir(), "loomrail-claude-code-test-does-not-exist");
    const started = createClaudeCodeProvider({ command: missing }).start(fixtureInvocation(), noopListener());
    // Asserted through `resolves`, not a bare `await`: the defect this guards against is `start()`
    // REJECTING instead of answering, and a bare await would surface that as a thrown spawn error
    // rather than as a failed assertion about the outcome.
    await expect(started).resolves.toMatchObject({ type: "NEEDS_HUMAN" });
    const outcome = await started;
    const request = expectNeedsHuman(outcome);
    expect(request.context).toContain(missing);
  });

  // Spec §9, first line: an adapter must not promise a provider whose CLI is not on this machine.
  // `start` alone carries that claim -- `stages` stays the adapter's normal declaration (what it
  // would serve if it could run), because `providerCapabilitiesSchema`'s `stages.min(1)` exists
  // to guarantee a *working* adapter always declares somewhere to dispatch, a guarantee that
  // says nothing about an adapter that cannot start at all. `packages/domain/src/workflow.ts`'s
  // `decideDispatchStage` reads `start` directly (task 10.5) to refuse this adapter regardless of
  // what `stages` says.
  it("declares itself unavailable when its CLI is not installed, but still declares its stages", () => {
    const capabilities = createClaudeCodeProvider({ command: "/nonexistent/claude" }).capabilities();
    expect(capabilities.start).toBe(false);
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "REVIEW"]);
  });

  // A1's D1 removed the second execution path deliberately (a session is always rebuilt from
  // durable state, never continued as a conversation): reinstating it through a CLI flag --
  // `--resume`, `--continue`, or `--fork-session` -- would undo that decision without anyone
  // deciding to.
  it("never resumes a provider-side session", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createClaudeCodeProvider({ command: fakeClaudePath }));
    const line = spawned.args.join(" ");
    expect(line).not.toContain("resume");
    expect(line).not.toContain("--continue");
    expect(line).not.toContain("--fork-session");
  });

  // The only reliable protection against the owner's own hook stdout/stderr ending up in
  // Loomrail's diagnostics is to never keep the raw stream at all. `not-logged-in.jsonl` is used
  // here rather than `hello.jsonl` on purpose: `hello.jsonl` never carries a hook event to begin
  // with (its only lines are `system:init` and `result`), so a check against it would pass
  // whether or not this adapter actually drops hook lines -- it would not fail under the defect
  // it names. `not-logged-in.jsonl` is a real recording carrying genuine `hook_started` /
  // `hook_response` / `hook_progress` system events, each with a real `hook_id` UUID that appears
  // nowhere in any shape this adapter derives (`ClaudeEvent` only ever surfaces the terminal
  // `result` event -- see stream.ts), so its presence anywhere this adapter hands back is direct
  // evidence a raw line leaked through. Collected across every observable surface (the outcome
  // AND everything delivered to the listener), not just the outcome alone: an outcome-only check
  // would still pass if a raw line leaked through `onUsage`/`onCheckpoint`/`onContextWindow`
  // instead, since `ProviderOutcome` has no field a raw line could occupy in the first place.
  it("keeps no raw provider output after the session ends", async () => {
    const observed: unknown[] = [];
    const outcome = await runAgainstRecording("not-logged-in.jsonl", {
      onUsage: (usage) => observed.push(usage),
      onContextWindow: (usage) => observed.push(usage),
      onCheckpoint: (checkpoint) => observed.push(checkpoint),
    });
    observed.push(outcome);
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain("hook");
    expect(serialized).not.toContain("f467fbe7-7a9d-4d75-a74d-97d6b6dfe45f");
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
