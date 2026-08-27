import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CheckpointDraft,
  ContextWindowUsage,
  HumanRequestDraft,
  ProviderOutcome,
  ProviderUsage,
} from "@loomrail/contracts";
import type {
  ProviderAdapter,
  ProviderInvocation,
  ProviderSessionListener,
  ProviderWorkspace,
} from "@loomrail/provider-core";
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
//   `--add-dir` (both CLIs) grants tool access outside the directory the adapter pointed the CLI
//   at -- the one that actually defeats containment, and the one the original list missed entirely;
//   `--config` (Codex) is an arbitrary config override -- `codex exec --help` documents
//   `-c 'sandbox_permissions=["disk-full-read-access"]'`, a sandbox escape with no dangerous word in
//   it anywhere;
//   `--settings` and `--tools` (Claude) are the equivalent widening levers on that side.
//
// `-c` is deliberately NOT on the list any more, and is guarded harder instead: see
// ALLOWED_CONFIG_ASSIGNMENTS below.
//
// What a name list can never cover is a VALUE-shaped relaxation: `-s danger-full-access` and
// `--permission-mode dontAsk` are legitimate flags carrying dangerous values, and a name check would
// never usefully match them. Those are guarded positively instead, by asserting the value each
// adapter actually sends -- see "runs read-only without a workspace" below, and
// provider-claude-code's "runs in plan mode".
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

// The E1 exception to the rule above, and the reason `-c` left the spelling list. Given a workspace
// this adapter opens exactly one config key -- `workspace-write` denies network access by default,
// and an IMPLEMENT or QA session that cannot fetch cannot install a dependency or run a suite that
// does. Forbidding the spelling outright would forbid the launch this milestone exists for, and
// allowing the spelling would allow every other key with it, `sandbox_permissions` included. So the
// guard becomes a closed list of VALUES: every `-c` in the argv must carry one of these, and adding
// a second key is then a decision someone makes here rather than something that quietly happens.
const ALLOWED_CONFIG_ASSIGNMENTS: readonly string[] = ["sandbox_workspace_write.network_access=true"];

// Read off the argv ARRAY as adjacent pairs, never `args.join(" ")`: the context pack is a
// positional argument, and prompt text containing "-c" would make a joined-line check pass or fail
// for reasons that have nothing to do with the flags.
const configAssignments = (args: readonly string[]): string[] =>
  args.filter((arg, index) => args[index - 1] === "-c");

const expectNoForbiddenArguments = (args: readonly string[]): void => {
  for (const flag of FORBIDDEN_PERMISSION_BYPASS_FLAGS) expect(args).not.toContain(flag);
  // Every `-c` present is one whose value was read: a trailing `-c` with nothing after it would
  // otherwise slip past a check that only inspects what follows one.
  expect(configAssignments(args).length).toBe(args.filter((arg) => arg === "-c").length);
  for (const assignment of configAssignments(args)) {
    expect(ALLOWED_CONFIG_ASSIGNMENTS).toContain(assignment);
  }
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

// Stands in for a provisioned worktree: a real directory, because the child is spawned with its cwd
// there and would fail to start otherwise. Deliberately NOT a git repository -- `fake-codex.mjs`
// never runs git, and building one here would test git rather than the argv this file is about. The
// milestone's git behaviour is covered in packages/workspace against real repositories.
const workspaceDirectory = (): string => mkdtempSync(join(tmpdir(), "loomrail-codex-worktree-"));

const fixtureWorkspace = (path: string): ProviderWorkspace => ({
  path,
  branch: "loomrail/work-item-1-payments-retry-policy",
  baseCommit: "b".repeat(40),
});

const fixtureInvocation = (sessionId = "session-1", workspace?: ProviderWorkspace): ProviderInvocation => ({
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
  // Omitted rather than set to undefined: `exactOptionalPropertyTypes` makes those different
  // things, and the adapter reads absence as "this session was never meant to change anything".
  ...(workspace === undefined ? {} : { workspace }),
});

const noopListener = (): ProviderSessionListener => ({
  onContextWindow: () => undefined,
  onCheckpoint: () => undefined,
  onUsage: () => undefined,
});

// Runs `adapter.start()` once against `fakeCodexPath` with `spawned.recordPath` wired in, then
// fills `spawned.args`/`spawned.stdinClosed` in from what the fake process recorded about itself.
const startWith = async (
  spawned: Spawned,
  adapter: ProviderAdapter,
  workspace?: ProviderWorkspace,
): Promise<ProviderOutcome> => {
  const outcome = await withEnv("FAKE_CODEX_RECORD_PATH", spawned.recordPath, () =>
    adapter.start(fixtureInvocation("session-1", workspace), noopListener()),
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

// Runs the adapter against a real recording while ALSO capturing the argv it was spawned with.
// `runAgainstRecording` above only wires `FAKE_CODEX_OUTPUT_FILE`, and `startWith` only wires
// `FAKE_CODEX_RECORD_PATH` -- `fake-codex.mjs` honours both at once (see its own header comment),
// so this sets both and hands back the same `Spawned` shape `startWith` fills in, letting a test
// assert on `spawned.args` while running a real captured session end to end.
const runAdapterAgainstRecording = async (file: string): Promise<Spawned> => {
  const spawned = recordSpawn();
  const recordingPath = fileURLToPath(new URL(`./recordings/${file}`, import.meta.url));
  const adapter = createCodexProvider({ command: fakeCodexPath });
  await withEnv("FAKE_CODEX_RECORD_PATH", spawned.recordPath, () =>
    withEnv("FAKE_CODEX_OUTPUT_FILE", recordingPath, () =>
      adapter.start(fixtureInvocation(), noopListener()),
    ),
  );
  const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as {
    args: string[];
    stdinClosed: boolean;
  };
  spawned.args = recorded.args;
  spawned.stdinClosed = recorded.stdinClosed;
  return spawned;
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

  // IMPLEMENT and QA were withheld for exactly one reason -- the adapter ran in an empty temporary
  // directory and so had nothing to change -- and E1 removes it. The two named explicitly because
  // they are the pair `stagesRequiringWorkspace` (`@loomrail/domain`) refuses to dispatch without a
  // workspace: an adapter that never offers them makes that gate unreachable and this milestone
  // pointless.
  it("declares itself as Codex and now serves every stage, including the two that need a repository", () => {
    const capabilities = createCodexProvider().capabilities();
    expect(capabilities.provider).toBe("CODEX");
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
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
  it("runs read-only without a workspace and workspace-write with one, never a wider mode", async () => {
    const withoutWorkspace = recordSpawn();
    await startWith(withoutWorkspace, createCodexProvider({ command: fakeCodexPath }));
    const withWorkspace = recordSpawn();
    await startWith(
      withWorkspace,
      createCodexProvider({ command: fakeCodexPath }),
      fixtureWorkspace(workspaceDirectory()),
    );
    for (const spawned of [withoutWorkspace, withWorkspace]) {
      expect(spawned.args.indexOf("-s")).toBeGreaterThanOrEqual(0);
    }
    expect(withoutWorkspace.args[withoutWorkspace.args.indexOf("-s") + 1]).toBe("read-only");
    expect(withWorkspace.args[withWorkspace.args.indexOf("-s") + 1]).toBe("workspace-write");
  });

  // SD-001 forbids enabling a permission bypass automatically; this is the test, not the
  // convention. Every named spelling is checked, not just the one this adapter happens to build
  // today -- adding a flag to FORBIDDEN_PERMISSION_BYPASS_FLAGS is what makes a future regression
  // here fail loudly, instead of a check that only ever knew about one flag.
  it("never builds a command carrying a permission-bypass flag (SD-001)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    expectNoForbiddenArguments(spawned.args);
    const withWorkspace = recordSpawn();
    await startWith(
      withWorkspace,
      createCodexProvider({ command: fakeCodexPath }),
      fixtureWorkspace(workspaceDirectory()),
    );
    expectNoForbiddenArguments(withWorkspace.args);
  });

  // Spec D6 forbids MCP before milestone C1, and nothing enforced it -- an adapter that connected a
  // server would have broken the rule silently. `--mcp-config` also reaches straight past the empty
  // temporary directory that is this milestone's whole containment story.
  it("never connects an MCP server (D6)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    for (const forbidden of FORBIDDEN_MCP_FLAGS) expect(spawned.args).not.toContain(forbidden);
  });

  // `codex exec` launched without this flag inherits the OWNER'S OWN `~/.codex/config.toml` --
  // approval_policy, sandbox_mode, hooks, plugins, model providers, and MCP servers, none of which
  // this adapter's own argv controls. `-s`/`--skip-git-repo-check` etc. above cover what THIS
  // adapter asks for; this is the flag that stops the machine's ambient config from silently
  // adding to it. Authentication lives in `CODEX_HOME`, not `config.toml`, so this does not touch
  // login.
  it("does not let the owner's own codex config decide what the agent may do", async () => {
    const spawned = await runAdapterAgainstRecording("hello.jsonl");
    expect(spawned.args).toContain("--ignore-user-config");
  });

  // Spec D6 forbids MCP before milestone C1. `--ignore-user-config` is the flag this adapter sends
  // to ask the CLI not to read the owner's `~/.codex/config.toml`. This test establishes only that:
  // this adapter's own argv never asks the CLI to read the machine's config file. Whether the CLI
  // then actually honours that flag -- rather than, say, connecting an MCP server from it anyway --
  // is the CLI's own behaviour, which no test in this file observes.
  it("cannot pick up an MCP server from the machine it runs on", async () => {
    const spawned = await runAdapterAgainstRecording("hello.jsonl");
    expect(spawned.args).toContain("--ignore-user-config");
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

  // The same rule, on a real capture rather than two hand-written lines -- and the reason it
  // matters. `workspace-write.jsonl` was recorded from the authenticated CLI on a run that really
  // edited a file and really ran a verification command. It carries TWO schema-valid agent
  // messages: line 3, emitted before any tool work, whose summary states an INTENTION ("I'll
  // inspect greet.js, add the export, then run...") with `completed: []`; and line 10, the answer
  // the turn finished with. Nothing but position separates them -- same `item.type`, same shape,
  // both valid against `checkpointDraftSchema`. A first-wins parser therefore closes the stage as
  // COMPLETED carrying a summary that reports intention as completion, and the pipeline moves on
  // from work that was only ever announced.
  it("returns the answer the agent finished with, not the one it started with", async () => {
    const checkpoints: CheckpointDraft[] = [];
    const outcome = await runAgainstRecording("workspace-write.jsonl", {
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });
    expect(outcome).toEqual({ type: "COMPLETED", summary: "Added and verified `farewell(name)`." });
    // Both are still PUBLISHED as they arrive -- streaming a checkpoint mid-session is what keeps a
    // crashed process from losing everything but its tail, and the intention is a real checkpoint of
    // its own. What must not happen is the OUTCOME being decided by the first of them.
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.completed).toEqual([]);
    expect(checkpoints[1]?.completed).toEqual([
      "Export added to `greet.js`.",
      "Command output: `Goodbye, world`.",
    ]);
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

  // R7, at the adapter rather than at the parser. The counter exists so an empty or unreadable
  // stream is loud, and it can only stay loud if "understood, nothing to do with it" and "could not
  // read this" are separate numbers -- a writing session emits six of the former in eleven lines. The
  // stream here is deliberately hostile rather than a recording, per this file's rule for shapes no
  // observed CLI emits: one line no parser could read, one `item.started` the adapter understands and
  // takes nothing from, and no structured answer anywhere, so the diagnosis is reached at all.
  it("counts a line it could not read apart from one it read and did not need", async () => {
    const outcome = await runAgainstLines([
      "Reading additional input from stdin…",
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"true","status":"in_progress"}}',
    ]);
    const request = expectNeedsHuman(outcome);
    expect(request.context).toContain("Lines received from the CLI: 2");
    expect(request.context).toContain("2 carried nothing this adapter could use");
    expect(request.context).toContain("1 of them could not be read at all");
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

  // Spec D8, and the launch this whole milestone exists for. Every flag was established by probing
  // the real CLI rather than by reading its help, and the capture in
  // recordings/workspace-write.jsonl was taken with this exact argv against the authenticated
  // binary. Asserted as adjacent pairs over the argv ARRAY, never `args.join(" ")`: the context
  // pack is a positional argument, so a joined-line check passes or fails for reasons that have
  // nothing to do with the flags.
  it("runs the CLI inside the worktree it was given, with write access to that directory", async () => {
    const worktree = workspaceDirectory();
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }), fixtureWorkspace(worktree));
    expect(spawned.args[spawned.args.indexOf("-C") + 1]).toBe(worktree);
    expect(spawned.args[spawned.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(spawned.args).toContain("--ignore-user-config");
    // The prompt goes as a positional argument, and `codex exec` hangs forever on an open stdin.
    expect(spawned.args.at(-1)).toBe("Discover the requirements for the payments retry policy.");
    expect(spawned.stdinClosed).toBe(true);
  });

  // The brief's own assertion, kept verbatim in shape. `workspace-write` denies network access, and
  // an IMPLEMENT or QA session that cannot fetch cannot install a dependency or run a suite that
  // does -- so exactly one key is opened. Everything about `-c` that made it a forbidden spelling
  // still holds for every OTHER key (`-c 'sandbox_permissions=["disk-full-read-access"]'` is a
  // documented sandbox escape), which is why this is an equality on the whole list rather than a
  // containment check: a second key riding along fails here.
  it("opens exactly one config key and no others", async () => {
    const spawned = recordSpawn();
    await startWith(
      spawned,
      createCodexProvider({ command: fakeCodexPath }),
      fixtureWorkspace(workspaceDirectory()),
    );
    const configValues = spawned.args.filter((arg, index) => spawned.args[index - 1] === "-c");
    expect(configValues).toEqual(["sandbox_workspace_write.network_access=true"]);
  });

  // And none at all on the read-only path, which has nothing to widen.
  it("opens no config key when it has no workspace to write in", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }));
    expect(spawned.args.filter((arg, index) => spawned.args[index - 1] === "-c")).toEqual([]);
    expect(spawned.args).not.toContain("-c");
  });

  // §2.7. `--skip-git-repo-check` exists because `codex exec` refuses to start outside a trusted
  // directory and a fresh temporary directory is not one. A worktree IS a repository, so leaving
  // the flag off costs nothing and buys a check: if the daemon ever hands this adapter a path that
  // is not a repository, the CLI says so instead of running the session anyway.
  it("keeps the CLI's own repository check when it was given a worktree", async () => {
    const spawned = recordSpawn();
    await startWith(
      spawned,
      createCodexProvider({ command: fakeCodexPath }),
      fixtureWorkspace(workspaceDirectory()),
    );
    expect(spawned.args).not.toContain("--skip-git-repo-check");
  });

  // §2.3. `codex exec` has no `--ask-for-approval`; passing one is a hard argument error that fails
  // the launch outright rather than degrading it. Checked over the flags alone, not the whole argv,
  // so realistic prompt text mentioning approval cannot fail this for a reason that says nothing
  // true.
  it("never passes an approval flag, which codex exec rejects outright", async () => {
    const spawned = recordSpawn();
    await startWith(
      spawned,
      createCodexProvider({ command: fakeCodexPath }),
      fixtureWorkspace(workspaceDirectory()),
    );
    const flags = spawned.args.filter((arg) => arg.startsWith("-"));
    expect(flags.filter((flag) => flag.includes("approval"))).toEqual([]);
  });

  // The worktree belongs to the WorkItem and outlives the session: the next attempt is meant to
  // find the work still there, and removing it here would delete the milestone's whole point. The
  // second half is the one that would go wrong quietly -- the adapter generates a JSON Schema file
  // for `--output-schema`, and writing it into the worktree would put a file Loomrail created into
  // the diff that is supposed to show what the AGENT changed. Asserted by reading the directory
  // rather than by checking the schema path alone, so any other stray write fails it too.
  it("leaves the worktree exactly as it found it and writes its own schema elsewhere", async () => {
    const worktree = workspaceDirectory();
    const spawned = recordSpawn();
    await startWith(spawned, createCodexProvider({ command: fakeCodexPath }), fixtureWorkspace(worktree));
    expect(existsSync(worktree)).toBe(true);
    expect(readdirSync(worktree)).toEqual([]);
    const schemaPath = spawned.args[spawned.args.indexOf("--output-schema") + 1];
    if (schemaPath === undefined) {
      throw new Error("expected --output-schema to be followed by the file it names");
    }
    // Removed with the scratch directory that held it, the same way the read-only path's working
    // directory is removed below.
    expect(existsSync(schemaPath)).toBe(false);
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
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
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
