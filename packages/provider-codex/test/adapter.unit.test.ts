import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ContextWindowUsage,
  HumanRequestDraft,
  ProviderOutcome,
  ProviderUsage,
} from "@loomrail/contracts";
import type { ProviderAdapter, ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { contextWindowUsageSchema } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexProvider } from "../src/index.js";

const fakeCodexPath = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

// SD-001 forbids Loomrail from ever enabling a provider's permission-bypass mode automatically. This
// is the named, closed list: adding a spelling later is then a decision someone makes here, not
// something that quietly never happens. Shared verbatim with provider-claude-code's own copy (no
// test-only module is common to both packages yet, so -- per this task's convention for helpers
// needed by two packages -- duplicating a constant is preferable to creating one for this alone), so
// it carries both CLIs' flags regardless of which one this file tests.
//
// The list is NOT every route out of the sandbox, and `docs/security/THREAT-MODEL.md` T16 no longer
// claims it is. It covers flags whose NAME carries a danger warning, plus the specific
// non-danger-named flags known to widen what the child can reach:
//
//   `--add-dir` (both CLIs) grants tool access outside the empty temporary directory -- the one that
//   actually defeats D1's containment, and the one the original list missed entirely;
//   `-c` / `--config` (Codex) is an arbitrary config override -- `codex exec --help` documents
//   `-c 'sandbox_permissions=["disk-full-read-access"]'`, a sandbox escape with no dangerous word in
//   it anywhere;
//   `--settings` and `--tools` (Claude) are the equivalent widening levers on that side.
//
// What a name list can never cover is a VALUE-shaped relaxation: `-s danger-full-access` and
// `--permission-mode dontAsk` are legitimate flags carrying dangerous values, and a name check would
// never usefully match them. Those are guarded positively instead, by asserting the value each
// adapter actually sends -- see "always runs the sandbox read-only" below, and provider-claude-code's
// "runs in plan mode".
//
// Checked against the argv ARRAY, never a joined command line: the context pack is a positional
// argument, so a substring check over the whole line passes or fails for reasons that have nothing to
// do with the flags -- prompt text containing "-c" would fail it, and that failure would say nothing
// true.
const FORBIDDEN_PERMISSION_BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "-c",
  "--config",
  "--settings",
  "--tools",
];

// The bypass expressed as a value rather than a spelling, checked as an adjacent argv pair.
const FORBIDDEN_FLAG_VALUES: readonly (readonly [string, string])[] = [
  ["--permission-mode", "bypassPermissions"],
];

// Spec D6: no MCP connection before milestone C1. Nothing enforced that -- it was a property of the
// argv nobody asserted. Named separately from the bypass list because it is a different rule.
const FORBIDDEN_MCP_FLAGS: readonly string[] = ["--mcp-config", "--strict-mcp-config"];

const expectNoForbiddenArguments = (args: readonly string[]): void => {
  for (const flag of FORBIDDEN_PERMISSION_BYPASS_FLAGS) expect(args).not.toContain(flag);
  for (const [flag, value] of FORBIDDEN_FLAG_VALUES) {
    const at = args.indexOf(flag);
    if (at >= 0) expect(args[at + 1]).not.toBe(value);
  }
};

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

// Runs the adapter against an ad-hoc stream written out as a temporary file. Used ONLY where the
// point of the test is a wire shape no CLI observed here actually emits (a tolerated legacy shape,
// a deliberately hostile stream); anything asserting what a CLI really does goes through
// `runAgainstRecording` and a file in recordings/, per spec §11.
const runAgainstLines = async (
  lines: readonly string[],
  listener: Partial<ProviderSessionListener> = {},
): Promise<ProviderOutcome> => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-codex-stream-"));
  const streamPath = join(dir, "stream.jsonl");
  writeFileSync(streamPath, lines.map((line) => `${line}\n`).join(""), "utf8");
  const adapter = createCodexProvider({ command: fakeCodexPath });
  return withEnv("FAKE_CODEX_OUTPUT_FILE", streamPath, () =>
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

// Asserts -- rather than merely narrows -- that the outcome is the owner-facing question, and hands
// back its request. A bare `if (...) throw` would report a regression as a thrown Error instead of
// as a failed assertion, which is the difference between a test that fails and a test that crashes.
const expectNeedsHuman = (outcome: ProviderOutcome): HumanRequestDraft => {
  expect(outcome).toMatchObject({ type: "NEEDS_HUMAN" });
  if (outcome.type !== "NEEDS_HUMAN") throw new Error("unreachable: asserted immediately above");
  return outcome.request;
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

  // The value-shaped half of SD-001, alongside the spelling-shaped check below: `-s` takes a
  // sandbox mode, and `danger-full-access` is exactly as dangerous as any flag in
  // FORBIDDEN_PERMISSION_BYPASS_FLAGS, but it is a value, not a spelling, so a substring check
  // over the command line would never usefully name it (nothing stops a legitimate arg from
  // containing the same characters). Asserted positively -- the value actually sent is
  // "read-only" -- rather than negatively, so a future change to a different unsafe value still
  // fails this test even if nobody thought to add its exact spelling to a list first.
  it("always runs the sandbox read-only, never a more permissive mode", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    const sandboxFlagIndex = spawned.args.indexOf("-s");
    expect(sandboxFlagIndex).toBeGreaterThanOrEqual(0);
    expect(spawned.args[sandboxFlagIndex + 1]).toBe("read-only");
  });

  // SD-001 forbids enabling a permission bypass automatically; this is the test, not the
  // convention. Every named spelling is checked, not just the one this adapter happens to build
  // today -- adding a flag to FORBIDDEN_PERMISSION_BYPASS_FLAGS is what makes a future regression
  // here fail loudly, instead of a check that only ever knew about one flag.
  it("never builds a command carrying a permission-bypass flag (SD-001)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    expectNoForbiddenArguments(spawned.args);
  });

  // Spec D6 forbids MCP before milestone C1, and nothing enforced it -- an adapter that connected a
  // server would have broken the rule silently. `--mcp-config` also reaches straight past the empty
  // temporary directory that is this milestone's whole containment story.
  it("never connects an MCP server (D6)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    for (const forbidden of FORBIDDEN_MCP_FLAGS) expect(spawned.args).not.toContain(forbidden);
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

  // M7: `contextWindowUsageSchema` rejects `usedTokens > windowTokens`, and the daemon `safeParse`s
  // an occupancy report and drops what fails -- so an understated declared window disables
  // occupancy reporting entirely rather than merely skewing it. `hello.jsonl` really did measure
  // 17 854 input tokens; a declared window below that must still produce a usable report.
  it("clamps occupancy to the declared window instead of reporting past it", async () => {
    const seen: ContextWindowUsage[] = [];
    await runAgainstRecording(
      "hello.jsonl",
      { onContextWindow: (usage) => seen.push(usage) },
      { contextWindowTokens: 1_000 },
    );
    expect(seen.at(-1)).toEqual({ usedTokens: 1_000, windowTokens: 1_000, quality: "ACTUAL" });
    // The point of the clamp: what it produces is a report the contract accepts.
    expect(() => contextWindowUsageSchema.parse(seen.at(-1))).not.toThrow();
  });

  // requestHandoff is declared unsupported; it must be a no-op rather than an error, because the
  // loop calls it whenever the threshold is crossed and cannot know which adapter it is talking
  // to.
  it("accepts a handoff request without doing anything and without failing", async () => {
    await expect(createCodexProvider().requestHandoff("providerSession-1")).resolves.toBeUndefined();
  });

  // `--output-schema` is what lets a one-shot `codex exec` deliver a structured answer instead of
  // free prose, and WHERE that answer comes back was this milestone's Critical. `completed.jsonl`
  // is a real capture of this adapter's exact argv against codex v0.144.1 (see recordings/
  // README.md): the answer is the `text` of an `item.completed` / `agent_message` event, a line
  // `parseCodexEvent` parses successfully. The adapter used to try the checkpoint parser only on
  // lines that FAILED to parse as an event, so it never saw this one -- every real session
  // reported CONTEXT_EXHAUSTED. This test runs against the capture, so it fails under that defect
  // rather than confirming it.
  it("completes the stage from the structured answer inside the final agent message", async () => {
    const checkpoints: unknown[] = [];
    const outcome = await runAgainstRecording("completed.jsonl", {
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });
    expect(outcome).toEqual({ type: "COMPLETED", summary: "I reviewed nothing." });
    expect(checkpoints).toHaveLength(1);
  });

  // The bare, un-enveloped shape the adapter originally assumed is still accepted -- kept so a CLI
  // version that stops wrapping the answer does not silently reopen the Critical above. Asserted
  // against a synthetic line, not a recording, because no CLI observed here emits this shape: it is
  // a deliberate tolerance, and the test says so rather than pretending to be evidence.
  it("also completes from a bare structured line, should a CLI version print one", async () => {
    const outcome = await runAgainstLines([
      '{"type":"turn.started"}',
      '{"summary":"Bare-line answer.","completed":[],"remaining":[],"deadEnds":[],"openQuestions":[]}',
    ]);
    expect(outcome).toEqual({ type: "COMPLETED", summary: "Bare-line answer." });
  });

  // "The last such match wins": a turn that emits several agent messages ends on the one the
  // schema constrained, not the first thing that happened to parse.
  it("takes the last structured answer in the stream, not the first", async () => {
    const outcome = await runAgainstLines([
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"summary\\":\\"First.\\",\\"completed\\":[],\\"remaining\\":[],\\"deadEnds\\":[],\\"openQuestions\\":[]}"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"summary\\":\\"Last.\\",\\"completed\\":[],\\"remaining\\":[],\\"deadEnds\\":[],\\"openQuestions\\":[]}"}}',
    ]);
    expect(outcome).toEqual({ type: "COMPLETED", summary: "Last." });
  });

  // `hello.jsonl` ends on a plain `turn.completed` whose agent message is prose, not a checkpoint.
  // This used to report CONTEXT_EXHAUSTED -- a business result `codex exec` never measures and
  // never reports, and the label that made this milestone's Critical silent. The honest answer is a
  // blocking question that names what actually happened, including how many lines arrived and how
  // many of them the adapter could make nothing of.
  it("asks the owner, naming the exit and the line counts, when no structured answer arrives", async () => {
    const outcome = await runAgainstRecording("hello.jsonl");
    const request = expectNeedsHuman(outcome);
    expect(request.blocking).toBe(true);
    expect(request.title).toContain("CODEX");
    // Four lines arrive and every one of them PARSES: `thread.started`, `turn.started`, an
    // `item.completed` whose agent message is prose rather than a checkpoint, and `turn.completed`.
    // Only the last carries anything this session used (the usage figures), so three are unused --
    // which is the number that says something. Counting only unparseable lines reported "0 carried
    // nothing this adapter could use" here, word for word what a healthy session reports, and left
    // the counter unable to describe the very failure it was built for.
    expect(request.context).toContain("Lines received from the CLI: 4");
    expect(request.context).toContain("3 carried nothing this adapter could use");
    expect(request.context).toContain("exited with code 0");
  });

  // M1/R25: `turn.failed` is where a rate limit, an auth refusal or a model error arrives. The
  // parser used to drop it and the adapter used to absorb the session into CONTEXT_EXHAUSTED, so
  // the one text that says what went wrong never reached the owner. `turn-failed.jsonl` is a real
  // capture (a bogus `-m` value against the authenticated CLI); the assertion is on the provider's
  // own words, which only reach the request if they were actually carried.
  it("carries the provider's own error text when the CLI reports a failed turn", async () => {
    const outcome = await runAgainstRecording("turn-failed.jsonl");
    const request = expectNeedsHuman(outcome);
    expect(request.title).toContain("failed turn");
    expect(request.context).toContain("is not supported when using Codex with a ChatGPT account");
  });

  // M4: the sibling adapter has always caught `ProcessSpawnError`; this one let it reject out of
  // `start()`. The session loop does contain it, but as a generic PROVIDER_START_FAILED pause that
  // never names the executable -- which is the only actionable fact there is.
  it("asks the owner, naming the executable, when the CLI cannot be spawned at all", async () => {
    const missing = join(tmpdir(), "loomrail-codex-test-does-not-exist");
    const started = createCodexProvider({ command: missing }).start(fixtureInvocation(), noopListener());
    // Asserted through `resolves`, not a bare `await`: the defect this guards against is `start()`
    // REJECTING instead of answering, and a bare await would surface that as a thrown spawn error
    // rather than as a failed assertion about the outcome.
    await expect(started).resolves.toMatchObject({ type: "NEEDS_HUMAN" });
    const outcome = await started;
    const request = expectNeedsHuman(outcome);
    expect(request.context).toContain(missing);
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

  // Spec §9, first line: an adapter must not promise a provider whose CLI is not on this machine.
  // `start` alone carries that claim -- `stages` stays the adapter's normal declaration (what it
  // would serve if it could run), because `providerCapabilitiesSchema`'s `stages.min(1)` exists
  // to guarantee a *working* adapter always declares somewhere to dispatch, a guarantee that
  // says nothing about an adapter that cannot start at all. `packages/domain/src/workflow.ts`'s
  // `decideDispatchStage` reads `start` directly (task 10.5) to refuse this adapter regardless of
  // what `stages` says.
  it("declares itself unavailable when its CLI is not installed, but still declares its stages", () => {
    const capabilities = createCodexProvider({ command: "/nonexistent/codex" }).capabilities();
    expect(capabilities.start).toBe(false);
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "REVIEW"]);
  });

  // A1's D1 removed the second execution path deliberately (a session is always rebuilt from
  // durable state, never continued as a conversation): reinstating it through a CLI flag would
  // undo that decision without anyone deciding to.
  //
  // Checked against the flag array, not `args.join(" ")`: the context pack is a positional
  // argument, so a substring check over the joined command line passes or fails for reasons that
  // have nothing to do with the flags -- realistic prompt text containing the word "resume" would
  // fail it, and that failure would say nothing true.
  it("never resumes a provider-side session", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    const flags = spawned.args.filter((arg) => arg.startsWith("-"));
    expect(flags).not.toContain("--continue");
    expect(flags).not.toContain("--fork-session");
    expect(spawned.args).not.toContain("resume");
    expect(flags.some((flag) => flag.includes("resume"))).toBe(false);
  });

  // The only reliable protection against ever recording a raw wire line is not to keep one at
  // all. `hello.jsonl`'s first line carries a real `thread_id` UUID that appears nowhere in any
  // parsed shape this adapter produces (usage/context-window/checkpoint all use camelCase fields
  // derived from the event, never the wire line itself) -- so its presence in anything this
  // adapter hands back is direct evidence a raw line leaked through. Collected across every
  // observable surface (the outcome AND everything delivered to the listener), not just the
  // outcome alone: an outcome-only check would still pass if a raw line leaked through
  // `onUsage`/`onCheckpoint`/`onContextWindow` instead, since `ProviderOutcome` has no field a raw
  // line could occupy in the first place.
  it("keeps no raw provider output after the session ends", async () => {
    const observed: unknown[] = [];
    const outcome = await runAgainstRecording("hello.jsonl", {
      onUsage: (usage) => observed.push(usage),
      onContextWindow: (usage) => observed.push(usage),
      onCheckpoint: (checkpoint) => observed.push(checkpoint),
    });
    observed.push(outcome);
    expect(JSON.stringify(observed)).not.toContain("thread_id");
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
