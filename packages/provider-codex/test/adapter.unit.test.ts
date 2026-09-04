import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CheckpointDraft,
  ContextWindowUsage,
  HumanRequestDraft,
  ModelTier,
  ProviderOutcome,
  ProviderUsage,
} from "@loomrail/contracts";
import type {
  ProviderAdapter,
  ProviderInvocation,
  ProviderMcpConnection,
  ProviderModelMapping,
  ProviderSessionListener,
  ProviderWorkspace,
} from "@loomrail/provider-core";
import { providerStageResultSchemaFor } from "@loomrail/provider-core";
import { contextWindowUsageSchema } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexProvider, TERMINAL_TURN_EVENT } from "../src/index.js";

const fakeCodexPath = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

// A `.mjs` file is directly executable through its shebang on POSIX, but Windows has no such
// contract. Run the same fixture through this test process's Node binary on every platform so the
// process boundary is real and the adapter's argv still arrives untouched after the script path.
const createFakeCodexProvider = (
  options: { contextWindowTokens?: number; models?: Partial<ProviderModelMapping> } = {},
): ProviderAdapter =>
  createCodexProvider({
    command: process.execPath,
    commandArgsPrefix: [fakeCodexPath],
    ...options,
  });

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
// `isAllowedConfigAssignment` below.
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

// Codex has no dedicated MCP-config flag in the locally verified CLI. C1 uses only the closed `-c`
// assignments below, so these remain forbidden routes around that allowlist.
const FORBIDDEN_MCP_FLAGS: readonly string[] = ["--mcp-config", "--strict-mcp-config"];

// E1 first required one fixed workspace-network value; C1 adds a typed three-field grammar for each
// Loomrail proxy connector. Those are the reasons `-c` cannot stay on the spelling list. Allowing the
// spelling without validating its value would also allow `sandbox_permissions`, so every assignment
// is checked against the fixed value or the closed MCP key/value shapes below.
const isAllowedConfigAssignment = (assignment: string): boolean => {
  if (assignment === "sandbox_workspace_write.network_access=true") return true;
  const match = /^mcp_servers\.([a-z0-9_]{1,64})\.(command|args|enabled_tools)=(.+)$/u.exec(assignment);
  if (match === null) return false;
  const [, , field, encoded] = match;
  try {
    const value: unknown = JSON.parse(encoded ?? "");
    if (field === "command") return typeof value === "string" && isAbsolute(value);
    if (field === "args") {
      return Array.isArray(value) && value.length <= 8 && value.every((arg) => typeof arg === "string");
    }
    return (
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 64 &&
      value.every((tool) => typeof tool === "string" && tool.length > 0)
    );
  } catch {
    return false;
  }
};

// Whether one argv token carries `flag`, in every spelling a clap-based CLI (both of these are)
// accepts for it: the bare token, the long attached form `--flag=value`, and -- for a one-letter
// short flag -- the attached form `-cvalue` with no separator at all.
//
// This exists because matching only the exact token left the guard below open on the one flag it
// was written to guard. `configAssignments` read a token only when its predecessor was exactly
// `-c`, the completeness count filtered for exactly `-c`, and `--config` was checked with
// `not.toContain`, which is an exact element match -- so `-csandbox_permissions=["disk-full-read-
// access"]` and `--config=sandbox_permissions=...`, the documented sandbox escape written as ONE
// token, passed all three assertions untouched. That is the whole hole the value allow-list was
// introduced to close.
//
// Still read off the argv ARRAY, never `args.join(" ")`: the context pack is a positional
// argument, so a joined-line check would pass or fail on prompt text containing "-c".
const flagSpelling = (arg: string, flag: string): "EXACT" | "ATTACHED" | null => {
  if (arg === flag) return "EXACT";
  if (arg.startsWith(`${flag}=`)) return "ATTACHED";
  // A short flag is `-x`: two characters, one dash. A long flag never matches this branch, so
  // `--config` is not mistaken for `-c` carrying the attached value "-onfig".
  const isShort = flag.length === 2 && flag.startsWith("-") && !flag.startsWith("--");
  return isShort && arg.length > flag.length && arg.startsWith(flag) ? "ATTACHED" : null;
};

const attachedValue = (arg: string, flag: string): string =>
  arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : arg.slice(flag.length);

// Every config key this argv sets, however it is spelled. A trailing `-c` with nothing after it
// yields the empty string rather than nothing at all, so it fails the allow-list below instead of
// slipping past a reader that only inspects what follows a flag.
const configAssignments = (args: readonly string[]): string[] =>
  args.flatMap((arg, index) => {
    const spelling = flagSpelling(arg, "-c");
    if (spelling === null) return [];
    return [spelling === "EXACT" ? (args[index + 1] ?? "") : attachedValue(arg, "-c")];
  });

const expectNoForbiddenArguments = (args: readonly string[]): void => {
  for (const flag of [...FORBIDDEN_PERMISSION_BYPASS_FLAGS, ...FORBIDDEN_MCP_FLAGS]) {
    expect(args.filter((arg) => flagSpelling(arg, flag) !== null)).toEqual([]);
  }
  for (const assignment of configAssignments(args)) {
    expect(isAllowedConfigAssignment(assignment)).toBe(true);
  }
  for (const [flag, value] of FORBIDDEN_FLAG_VALUES) {
    for (const [index, arg] of args.entries()) {
      const spelling = flagSpelling(arg, flag);
      if (spelling === null) continue;
      expect(spelling === "EXACT" ? args[index + 1] : attachedValue(arg, flag)).not.toBe(value);
    }
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
type Spawned = {
  args: string[];
  stdinClosed: boolean;
  outputSchema: string | null;
  readonly recordPath: string;
};

const recordSpawn = (): Spawned => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-codex-test-"));
  return { args: [], stdinClosed: false, outputSchema: null, recordPath: join(dir, "spawn-record.json") };
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

// `access` is passed at every call site rather than defaulted: what a session may do in the
// worktree is the thing several tests below are about, and a default would let a test assert
// "workspace-write" while silently saying nothing about which stages get it -- which is how the
// reading stages came to run with write access in the first place.
const fixtureWorkspace = (
  path: string,
  access: ProviderWorkspace["access"],
  networkAccess = access === "READ_WRITE",
): ProviderWorkspace => ({
  path,
  branch: "loomrail/work-item-1-payments-retry-policy",
  baseCommit: "b".repeat(40),
  access,
  networkAccess,
});

const fixtureInvocation = (
  sessionId = "session-1",
  workspace?: ProviderWorkspace,
  stage: ProviderInvocation["session"]["stage"] = "DISCOVERY",
  humanRequests: ProviderInvocation["humanRequests"] = "ALLOWED",
  mcpConnections: readonly ProviderMcpConnection[] = [],
  modelTier: ModelTier = "STANDARD",
  modelId?: string,
): ProviderInvocation => ({
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
    stage,
    attempt: 1,
  },
  contextPack: {
    schemaVersion: 1,
    text: "Discover the requirements for the payments retry policy.",
    contentHash: `sha256:${"0".repeat(64)}`,
  },
  modelTier,
  ...(modelId === undefined ? {} : { modelId }),
  acceptanceInput: null,
  humanRequests,
  mcpConnections,
  authoritySignal: new AbortController().signal,
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
  humanRequests: ProviderInvocation["humanRequests"] = "ALLOWED",
  mcpConnections: readonly ProviderMcpConnection[] = [],
  modelTier: ModelTier = "STANDARD",
  modelId?: string,
): Promise<ProviderOutcome> => {
  const outcome = await withEnv("FAKE_CODEX_RECORD_PATH", spawned.recordPath, () =>
    adapter.start(
      fixtureInvocation(
        "session-1",
        workspace,
        "DISCOVERY",
        humanRequests,
        mcpConnections,
        modelTier,
        modelId,
      ),
      noopListener(),
    ),
  );
  const recorded = JSON.parse(readFileSync(spawned.recordPath, "utf8")) as {
    args: string[];
    stdinClosed: boolean;
    outputSchema: string | null;
  };
  spawned.args = recorded.args;
  spawned.stdinClosed = recorded.stdinClosed;
  spawned.outputSchema = recorded.outputSchema;
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
  const adapter = createFakeCodexProvider(options);
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
  const adapter = createFakeCodexProvider();
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
  stage: ProviderInvocation["session"]["stage"] = "DISCOVERY",
  humanRequests: ProviderInvocation["humanRequests"] = "ALLOWED",
): Promise<ProviderOutcome> => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-codex-stream-"));
  const streamPath = join(dir, "stream.jsonl");
  writeFileSync(streamPath, lines.map((line) => `${line}\n`).join(""), "utf8");
  const adapter = createFakeCodexProvider();
  return withEnv("FAKE_CODEX_OUTPUT_FILE", streamPath, () =>
    adapter.start(fixtureInvocation("session-1", undefined, stage, humanRequests), {
      ...noopListener(),
      ...listener,
    }),
  );
};

// The terminal event of a `codex exec` turn, copied from the shape every recording in recordings/
// ends on. A stream that is otherwise synthetic still has to carry it to stand for a FINISHED
// session: the adapter closes a stage only on a turn the CLI itself reported complete, because a
// checkpoint alone is published mid-work and says what the agent meant to do next (see "does not
// close a stage on the checkpoint a killed session left behind" below).
const COMPLETED_TURN_LINE =
  '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}';

// How a run under test ENDS, independently of what it streamed. `fake-codex.mjs` honours both
// (see its header): an exit code instead of 0, or a SIGKILL once the output has reached the pipe.
type SessionEnding = { exitCode: number } | { killed: true };

// The first `lines` lines of a real recording, which is exactly what a process killed mid-session
// leaves on the pipe: the lines that had already arrived, and nothing after them. Sliced off the
// capture rather than written out here, so the checkpoint these tests are about is the CLI's own
// intention message verbatim -- recordings/README.md's rule is that a hand-written line is a
// fixture wearing a recording's name, and this stays the recording's bytes.
//
// The length is asserted rather than assumed: a recording that shrank would otherwise silently
// hand these tests a stream with no checkpoint in it at all, and they would pass for the wrong
// reason -- a session that published nothing is refused by a branch that predates this fix.
const recordingPrefix = (file: string, lines: number): string => {
  const recordingPath = fileURLToPath(new URL(`./recordings/${file}`, import.meta.url));
  const prefix = readFileSync(recordingPath, "utf8").split("\n").slice(0, lines);
  expect(prefix).toHaveLength(lines);
  return `${prefix.join("\n")}\n`;
};

const wholeRecording = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./recordings/${file}`, import.meta.url)), "utf8");

const finalStructuredResultFromRecording = (file: string): unknown => {
  const event = wholeRecording(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } })
    .findLast((candidate) => candidate.type === "item.completed" && candidate.item?.type === "agent_message");
  if (event?.item?.text === undefined) throw new Error("expected a final recorded agent message");
  return JSON.parse(event.item.text) as unknown;
};

// Runs the adapter against a given stream and a given ending. The stream is written to a temporary
// file and delivered by `fake-codex.mjs` exactly as `runAgainstRecording` delivers a whole
// recording; only the ending differs.
const runAgainstStreamEnding = async (
  stream: string,
  ending: SessionEnding,
  listener: Partial<ProviderSessionListener> = {},
): Promise<ProviderOutcome> => {
  const dir = mkdtempSync(join(tmpdir(), "loomrail-codex-ending-"));
  const streamPath = join(dir, "stream.jsonl");
  writeFileSync(streamPath, stream, "utf8");
  const adapter = createFakeCodexProvider();
  const environment =
    "killed" in ending
      ? { name: "FAKE_CODEX_KILL_SELF", value: "1" }
      : { name: "FAKE_CODEX_EXIT_CODE", value: String(ending.exitCode) };
  return withEnv("FAKE_CODEX_OUTPUT_FILE", streamPath, () =>
    withEnv(environment.name, environment.value, () =>
      adapter.start(fixtureInvocation(), { ...noopListener(), ...listener }),
    ),
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
    delete process.env["FAKE_CODEX_EXIT_CODE"];
    delete process.env["FAKE_CODEX_KILL_SELF"];
  });

  it("does not spawn when AgentRun authority is revoked during preparation", async () => {
    const authority = new AbortController();
    authority.abort();
    await expect(
      createFakeCodexProvider().start(
        { ...fixtureInvocation(), authoritySignal: authority.signal },
        noopListener(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  // IMPLEMENT and QA were withheld for exactly one reason -- the adapter ran in an empty temporary
  // directory and so had nothing to change -- and E1 removes it. The two named explicitly because
  // they are the pair `stagesRequiringWorkspace` (`@loomrail/domain`) refuses to dispatch without a
  // workspace: an adapter that never offers them makes that gate unreachable and this milestone
  // pointless.
  it("declares itself as Codex and now serves every stage, including the two that need a repository", () => {
    const capabilities = createCodexProvider().capabilities();
    expect(capabilities.provider).toBe("CODEX");
    expect(capabilities.canReportRateLimits).toBe(true);
    expect(capabilities.stages).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
    expect(capabilities.checkpointOnRequest).toBe(false);
  });

  // Established by probing the real CLI: without these two the adapter either hangs or is
  // refused.
  it("runs with stdin closed and the trusted-directory check skipped", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider());
    expect(spawned.args).toContain("--skip-git-repo-check");
    expect(spawned.stdinClosed).toBe(true);
  });

  it("maps every immutable model tier to the configured explicit CLI model", async () => {
    const models = {
      FAST: "codex-fast-test",
      STANDARD: "codex-standard-test",
      DEEP: "codex-deep-test",
    } as const satisfies ProviderModelMapping;
    for (const tier of ["FAST", "STANDARD", "DEEP"] as const) {
      const spawned = recordSpawn();
      await startWith(spawned, createFakeCodexProvider({ models }), undefined, "ALLOWED", [], tier);
      expect(spawned.args[spawned.args.indexOf("--model") + 1]).toBe(models[tier]);
    }
    expect(() => createCodexProvider({ models: { FAST: "--unsafe-flag" } })).toThrow();
  });

  it("uses the exact model pinned in the AgentRun snapshot even if the adapter mapping changed", async () => {
    const spawned = recordSpawn();
    await startWith(
      spawned,
      createFakeCodexProvider(),
      undefined,
      "ALLOWED",
      [],
      "FAST",
      "gpt-snapshot-pinned",
    );
    expect(spawned.args[spawned.args.indexOf("--model") + 1]).toBe("gpt-snapshot-pinned");
  });

  // The value-shaped half of SD-001, alongside the spelling-shaped check below: `-s` takes a
  // sandbox mode, and `danger-full-access` is exactly as dangerous as any flag in
  // FORBIDDEN_PERMISSION_BYPASS_FLAGS, but it is a value, not a spelling, so a substring check
  // over the command line would never usefully name it (nothing stops a legitimate arg from
  // containing the same characters). Asserted positively -- the value actually sent is
  // "read-only" -- rather than negatively, so a future change to a different unsafe value still
  // fails this test even if nobody thought to add its exact spelling to a list first.
  it("runs read-only without a workspace and workspace-write with a writable one, never a wider mode", async () => {
    const withoutWorkspace = recordSpawn();
    await startWith(withoutWorkspace, createFakeCodexProvider());
    const withWorkspace = recordSpawn();
    await startWith(
      withWorkspace,
      createFakeCodexProvider(),
      fixtureWorkspace(workspaceDirectory(), "READ_WRITE"),
    );
    for (const spawned of [withoutWorkspace, withWorkspace]) {
      expect(spawned.args.indexOf("-s")).toBeGreaterThanOrEqual(0);
    }
    expect(withoutWorkspace.args[withoutWorkspace.args.indexOf("-s") + 1]).toBe("read-only");
    expect(withWorkspace.args[withWorkspace.args.indexOf("-s") + 1]).toBe("workspace-write");
  });

  // The shape R11 created and nothing asserted: a worktree handed to a stage that only READS it.
  // Giving every agent stage the workspace was right, but this adapter chose its sandbox mode from
  // the mere presence of one, so DISCOVERY, PLAN and REVIEW launched under `-s workspace-write`
  // with `sandbox_workspace_write.network_access=true` -- a review able to rewrite the code it is
  // judging, and a discovery able to reach the network, neither of which those stages need or were
  // ever meant to have.
  //
  // Asserted over the argv ARRAY and as adjacent pairs, never over `args.join(" ")`: the context
  // pack is a positional argument, so a joined-line check passes or fails on prompt text. Both
  // halves are pinned -- the mode that IS sent, and the config key that is not -- because a
  // read-only sandbox that still opened the network would satisfy only one of them.
  it("gives a reading stage the same worktree without write access or an opened network", async () => {
    const worktree = workspaceDirectory();
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(worktree, "READ_ONLY"));

    // The worktree itself is unchanged by the access mode: this stage reads the work item's own
    // branch, with whatever an earlier stage changed on it.
    expect(spawned.args[spawned.args.indexOf("-C") + 1]).toBe(worktree);
    expect(spawned.args[spawned.args.indexOf("-s") + 1]).toBe("read-only");
    // Not one `-c`, in any spelling: the one key this adapter may open exists so an IMPLEMENT or QA
    // can install what it needs to run a suite, and a stage that may not write has nothing to
    // install into.
    expect(configAssignments(spawned.args)).toEqual([]);
    expect(spawned.args.filter((arg) => flagSpelling(arg, "-c") !== null)).toEqual([]);
    // And the rest of the launch is unchanged -- still the worktree's own repository check, still
    // no bypass flag anywhere.
    expect(spawned.args).not.toContain("--skip-git-repo-check");
    expectNoForbiddenArguments(spawned.args);
  });

  // SD-001 forbids enabling a permission bypass automatically; this is the test, not the
  // convention. Every named spelling is checked, not just the one this adapter happens to build
  // today -- adding a flag to FORBIDDEN_PERMISSION_BYPASS_FLAGS is what makes a future regression
  // here fail loudly, instead of a check that only ever knew about one flag.
  it("never builds a command carrying a permission-bypass flag (SD-001)", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider());
    expectNoForbiddenArguments(spawned.args);
    const withWorkspace = recordSpawn();
    await startWith(
      withWorkspace,
      createFakeCodexProvider(),
      fixtureWorkspace(workspaceDirectory(), "READ_WRITE"),
    );
    expectNoForbiddenArguments(withWorkspace.args);
  });

  // `expectNoForbiddenArguments` is the guard that replaced a blanket ban on `-c`, so it is now a
  // piece of logic with a failure mode of its own and is tested rather than only used. The argv it
  // is handed here is synthetic on purpose: the point is what the guard would CATCH, and this
  // adapter is never going to build a smuggled flag for it to catch.
  //
  // Every spelling below is one a clap-based CLI accepts and the previous guard missed entirely:
  // the key attached to a short flag with no separator, and the key attached to the long flag with
  // `=`. Both were exactly the sandbox escape `codex exec --help` documents.
  it("catches a forbidden config key smuggled into a single argv token", () => {
    // The shape this adapter really builds, minus the parts that do not concern the guard. The last
    // element stands in for the context pack: a positional argument whose text happens to mention a
    // flag, which is why the guard reads the array and not a joined command line. (A prompt that
    // BEGAN with "-c" would be a false positive here; a guard on a sandbox escape is allowed to err
    // that way, and nothing assembles a pack that starts with a flag.)
    const base = [
      "exec",
      "--json",
      "--ignore-user-config",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-C",
      "/tmp/loomrail-worktree",
      "Implement the retry policy; do not pass -c to anything.",
    ];
    expect(() => {
      expectNoForbiddenArguments(base);
    }).not.toThrow();

    for (const smuggled of [
      '-csandbox_permissions=["disk-full-read-access"]',
      '--config=sandbox_permissions=["disk-full-read-access"]',
      "-csandbox_workspace_write.network_access=false",
      "--permission-mode=bypassPermissions",
      "--mcp-config=/tmp/servers.json",
    ]) {
      expect(() => {
        expectNoForbiddenArguments([...base, smuggled]);
      }).toThrow();
    }

    // A trailing `-c` with nothing after it is not a way past the allow list either: it is recorded
    // as an empty assignment, which is not on it.
    expect(() => {
      expectNoForbiddenArguments([...base, "-c"]);
    }).toThrow();
  });

  it("adds no MCP config assignments when the session connector set is empty", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider());
    expect(configAssignments(spawned.args).filter((value) => value.startsWith("mcp_servers."))).toEqual([]);
  });

  it("injects only the closed Loomrail proxy connector and its granted tools", async () => {
    const spawned = recordSpawn();
    const connector: ProviderMcpConnection = {
      id: "loomrail_profile_1",
      proxyCommand: "/opt/loomrail/bin/mcp-proxy",
      proxyArgs: ["connect", "session-token"],
      enabledTools: ["fetch", "search"],
    };
    await startWith(spawned, createFakeCodexProvider(), undefined, "ALLOWED", [connector]);

    expect(spawned.args).toContain("--ignore-user-config");
    expect(configAssignments(spawned.args)).toEqual([
      'mcp_servers.loomrail_profile_1.command="/opt/loomrail/bin/mcp-proxy"',
      'mcp_servers.loomrail_profile_1.args=["connect","session-token"]',
      'mcp_servers.loomrail_profile_1.enabled_tools=["fetch","search"]',
    ]);
    expect(spawned.args.join("\n")).not.toContain("real-server.mjs");
    expectNoForbiddenArguments(spawned.args);
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

  // C1 permits only the session-scoped Loomrail proxy. `--ignore-user-config` asks the CLI not to
  // add MCP servers from the owner's `~/.codex/config.toml`. This test establishes the argv Loomrail
  // builds; whether the CLI honours its documented flag remains the CLI's own behaviour.
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

  it.each([
    ["codex-0.153.0-alpha.5-success-macos-arm64.jsonl", "Discovery result recorded as requested."],
    [
      "codex-0.153.0-alpha.5-workspace-macos-arm64.jsonl",
      'Changed the exported status to "verified" and confirmed the check passes. No commit was created.',
    ],
    [
      "codex-0.153.0-alpha.5-mcp-macos-arm64.jsonl",
      "The loomrail_q14 evidence_echo tool returned the marker `echo:macos-arm64`.",
    ],
  ])("replays and independently validates the current macOS recording %s", async (file, summary) => {
    expect(
      providerStageResultSchemaFor("DISCOVERY", { humanRequests: "DISALLOWED" }).parse(
        finalStructuredResultFromRecording(file),
      ),
    ).toBeDefined();
    await expect(runAgainstRecording(file)).resolves.toMatchObject({ type: "COMPLETED", summary });
  });

  it("keeps the current real invalid-model recording on the typed failure path", async () => {
    const outcome = await runAgainstRecording("codex-0.153.0-alpha.5-failure-macos-arm64.jsonl");
    const request = expectNeedsHuman(outcome);
    expect(request.context).toContain("loomrail-invalid-model-q14");
  });

  // The bare, un-enveloped shape the adapter originally assumed is still accepted -- kept so a CLI
  // version that stops wrapping the answer does not silently reopen the Critical above. Asserted
  // against a synthetic line, not a recording, because no CLI observed here emits this shape: it is
  // a deliberate tolerance, and the test says so rather than pretending to be evidence.
  it("also completes from a bare structured line, should a CLI version print one", async () => {
    const outcome = await runAgainstLines([
      '{"type":"turn.started"}',
      '{"summary":"Bare-line answer.","completed":[],"remaining":[],"deadEnds":[],"openQuestions":[]}',
      COMPLETED_TURN_LINE,
    ]);
    expect(outcome).toEqual({ type: "COMPLETED", summary: "Bare-line answer." });
  });

  it("rejects a second provider-authored owner question even if the CLI ignores its output schema", async () => {
    const duplicateQuestion = {
      result: {
        type: "NEEDS_HUMAN",
        request: {
          kind: "FREE_TEXT",
          blocking: true,
          title: "Ask the owner again",
          context: "This attempt already received its owner answer.",
          recommendation: "Repeat the answer.",
          options: [],
          allowOther: true,
        },
      },
    };
    const outcome = await runAgainstLines(
      [
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-duplicate-gate", type: "agent_message", text: JSON.stringify(duplicateQuestion) },
        }),
        COMPLETED_TURN_LINE,
      ],
      {},
      "DISCOVERY",
      "DISALLOWED",
    );

    const request = expectNeedsHuman(outcome);
    expect(request.title).not.toBe("Ask the owner again");
    expect(request.context).toContain("without the structured result Loomrail asked it for");
  });

  it("returns typed Review evidence from the Review stage schema", async () => {
    const stageResult = {
      result: {
        type: "COMPLETED",
        summary: "The independent review passed.",
        completed: ["Acceptance criteria traced"],
        remaining: [],
        deadEnds: [],
        openQuestions: [],
        artifact: {
          kind: "REVIEW_REPORT",
          title: "Independent review",
          summary: "No blocking findings remain.",
          checks: ["Requirements traced to the diff"],
          verdict: "PASSED",
          findings: [],
        },
      },
    };
    const outcome = await runAgainstLines(
      [
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-review", type: "agent_message", text: JSON.stringify(stageResult) },
        }),
        COMPLETED_TURN_LINE,
      ],
      {},
      "REVIEW",
    );
    expect(outcome).toMatchObject({
      type: "COMPLETED",
      artifacts: [{ kind: "REVIEW_REPORT" }],
      reviewReport: { verdict: "PASSED", findings: [] },
    });
  });

  it("can only prepare Acceptance for the owner, never complete it directly", async () => {
    const ready = await runAgainstLines(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-acceptance",
            type: "agent_message",
            text: JSON.stringify({
              result: {
                type: "READY_FOR_ACCEPTANCE",
                releaseNote: "The bounded delivery is ready for owner review.",
                verifyInstructions: ["Run the repository test."],
                criteria: [
                  {
                    criterion: "The retry policy is verified.",
                    implementation: "The bounded retry policy was implemented.",
                    reviewCheck: "Policy reviewed",
                    qaCheck: "Retry scenario passed",
                    ownerVerification: "Inspect the recorded retry evidence.",
                    knownRisk: null,
                  },
                ],
              },
            }),
          },
        }),
        COMPLETED_TURN_LINE,
      ],
      {},
      "ACCEPTANCE",
    );
    expect(ready).toMatchObject({ type: "READY_FOR_ACCEPTANCE" });

    const invalidCompletion = await runAgainstLines(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-invalid-acceptance",
            type: "agent_message",
            text: JSON.stringify({
              result: {
                type: "COMPLETED",
                summary: "Accepted by the provider.",
                completed: [],
                remaining: [],
                deadEnds: [],
                openQuestions: [],
              },
            }),
          },
        }),
        COMPLETED_TURN_LINE,
      ],
      {},
      "ACCEPTANCE",
    );
    expectNeedsHuman(invalidCompletion);
  });

  // "The last such match wins": a turn that emits several agent messages ends on the one the
  // schema constrained, not the first thing that happened to parse.
  it("takes the last structured answer in the stream, not the first", async () => {
    const outcome = await runAgainstLines([
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"summary\\":\\"First.\\",\\"completed\\":[],\\"remaining\\":[],\\"deadEnds\\":[],\\"openQuestions\\":[]}"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"summary\\":\\"Last.\\",\\"completed\\":[],\\"remaining\\":[],\\"deadEnds\\":[],\\"openQuestions\\":[]}"}}',
      COMPLETED_TURN_LINE,
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

  // The other half of the same defect, and the one last-wins (D9) cannot reach. Last-wins picks the
  // final match in the stream -- which only helps when the real answer arrived. `workspace-write`'s
  // line 3 is a schema-valid `agent_message` emitted BEFORE any tool work, stating an intention with
  // `completed: []`; if the process dies after it, line 3 IS the last match, and an adapter that
  // reads a checkpoint as a finished session closes the stage COMPLETED carrying the agent's opening
  // sentence as the result of work that never happened.
  //
  // Reachable three ways in the product, all of them ordinary: the owner pressing Ctrl+C on the
  // daemon (shutdown -> `worker.stop()` -> `abortSession`, which kills the child while the resolved
  // outcome is still applied to the attempt), the 600-second session deadline, and any non-zero
  // exit. The stream is the recording's own first three lines and the ending is a real kill of a
  // real child process, so what is asserted is the adapter's answer to the event, not to a fixture
  // describing one.
  it("does not close a stage on the checkpoint a killed session left behind", async () => {
    const checkpoints: CheckpointDraft[] = [];
    const outcome = await runAgainstStreamEnding(
      recordingPrefix("workspace-write.jsonl", 3),
      { killed: true },
      { onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
    );

    // Asserted first: this is what makes the rest of the test mean anything. The adapter really did
    // receive a schema-valid checkpoint -- the intention, with nothing completed -- so a NEEDS_HUMAN
    // outcome below is the adapter refusing to close on it, not an empty stream being refused by the
    // branch that has always refused empty streams.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.completed).toEqual([]);
    const intention = checkpoints[0]?.summary ?? "";
    expect(intention).toContain("inspect");

    const request = expectNeedsHuman(outcome);
    // The defect, stated directly: the agent's opening sentence must appear nowhere in the outcome
    // this stage is closed on.
    expect(JSON.stringify(outcome)).not.toContain(intention);
    expect(request.title).toContain("cut off before it finished");
    // Windows has no POSIX signal outcome for this self-kill fixture and reports exit code 1;
    // POSIX reports the SIGKILL itself. Both are real abnormal endings, and the invariant under
    // test is that neither one promotes the last checkpoint into a completed stage.
    expect(request.context).toContain(
      process.platform === "win32" ? "exited with code 1" : "killed by SIGKILL",
    );
    // And the checkpoint is not disowned either -- it was published as it arrived, the daemon has
    // persisted it, and a resumed attempt starts from it.
    expect(request.context).toContain("checkpoint this session published is kept");
  });

  // The same rule for the ending a CLI reaches on its own. `exit.code` was assigned by this adapter
  // and then read nowhere on the success path: an exit of 3 after the intention message produced
  // `{"type":"COMPLETED","summary":"I'll inspect ..."}` exactly as the kill above did.
  it("does not close a stage on the checkpoint a session that exited non-zero left behind", async () => {
    const checkpoints: CheckpointDraft[] = [];
    const outcome = await runAgainstStreamEnding(
      recordingPrefix("workspace-write.jsonl", 3),
      { exitCode: 3 },
      { onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
    );

    expect(checkpoints).toHaveLength(1);
    const intention = checkpoints[0]?.summary ?? "";
    expect(intention).toContain("inspect");

    const request = expectNeedsHuman(outcome);
    expect(JSON.stringify(outcome)).not.toContain(intention);
    expect(request.context).toContain("exited with code 3");
  });

  // Both halves of "ended normally" are asked, and each one answers a failure the other misses, so
  // each is pinned on its own here.
  //
  // First run: the WHOLE capture -- the turn ran to `turn.completed` and the final answer is the
  // real one -- ending on a non-zero exit. A CLI that gives up after answering is telling Loomrail
  // something went wrong, and the honest response is the owner's question, not a closed stage.
  //
  // Second run: the truncated stream ending at exit 0, which is what a CLI that stopped saying
  // `turn.completed` looks like from outside. The exit says nothing is wrong; the missing terminal
  // event says the turn was never reported finished. The stage is still not closed -- which is the
  // property this test is about -- and the question the owner gets is the one for that specific
  // shape (see the test below it).
  it("needs both the CLI's own completed turn and a clean exit before it closes a stage", async () => {
    const afterCompletedTurn = await runAgainstStreamEnding(wholeRecording("workspace-write.jsonl"), {
      exitCode: 3,
    });
    expect(JSON.stringify(afterCompletedTurn)).not.toContain("Added and verified");
    expect(expectNeedsHuman(afterCompletedTurn).context).toContain("exited with code 3");

    const withoutCompletedTurn = await runAgainstStreamEnding(recordingPrefix("workspace-write.jsonl", 3), {
      exitCode: 0,
    });
    const request = expectNeedsHuman(withoutCompletedTurn);
    expect(request.title).toContain("never reported the turn finished");
    expect(request.context).toContain("exited with code 0");
  });

  // A checkpoint, a clean exit, and no `turn.completed`: what a future `codex` that renamed its
  // terminal event -- or renamed a field inside the `usage` it carries, which stops it parsing just
  // as completely -- looks like on every stage of every work item.
  //
  // Reported as SESSION_ENDED_UNFINISHED, the owner was told "CODEX was cut off before it finished
  // this stage" one sentence above "The process exited with code 0", with nothing naming the
  // missing event and an instruction to resume that reproduced the identical question every time.
  // Cut off and exited cleanly cannot both be true, and the pair is worse than either alone: it
  // sends the reader looking for a crash that did not happen.
  it("names the missing terminal event, and does not tell the owner to resume, when the CLI exits cleanly without one", async () => {
    const checkpoints: CheckpointDraft[] = [];
    const outcome = await runAgainstStreamEnding(
      recordingPrefix("workspace-write.jsonl", 3),
      { exitCode: 0 },
      { onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
    );

    // Asserted first, as in the kill test above: a checkpoint really did arrive, so what follows is
    // the adapter refusing to close on it rather than the empty-stream branch answering.
    expect(checkpoints).toHaveLength(1);
    const intention = checkpoints[0]?.summary ?? "";
    expect(intention).toContain("inspect");

    const request = expectNeedsHuman(outcome);
    expect(JSON.stringify(outcome)).not.toContain(intention);

    // The contradiction, gone: nothing claims the session was cut off.
    expect(request.title).not.toContain("cut off");
    expect(request.context).not.toContain("cut off");
    expect(request.context).toContain("exited with code 0");
    // The missing signal is named, by the name the parser actually matches on, so the owner has
    // something to grep their CLI's output for.
    expect(request.context).toContain(TERMINAL_TURN_EVENT);
    // And the diagnosis says which kind of fact this is -- the CLI's vocabulary, not this session.
    expect(request.context).toContain("renamed");
    // The advice that made this a loop. Resuming reruns a session that already exited 0 and ends
    // exactly here again, so the recommendation must not send the owner back around it.
    expect(request.recommendation).not.toContain("resume the attempt");
    expect(request.recommendation).toContain("Retrying will not change this");
    // The checkpoint is still kept: it was published as it arrived and the daemon has persisted it.
    expect(request.context).toContain("checkpoint this session published is kept");
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

  it("returns a typed owner action only for a structured provider 429", async () => {
    const outcome = await runAgainstLines([
      JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ status: 429 }) } }),
    ]);

    expect(outcome).toMatchObject({ type: "NEEDS_HUMAN", reason: "PROVIDER_RATE_LIMITED" });
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

  // The worktree is checked by the daemon before it dispatches, and can still go away in the window
  // between that check and this launch -- an owner cleaning up, a script, the agent of another
  // attempt. `spawn` answers a missing cwd with the SAME ENOENT it gives a missing executable, so
  // the outcome named `codex` and the owner was told to install a CLI that was there all along.
  // Asserted in both directions: the directory has to be named, and the executable has to be
  // cleared, because a diagnosis that merely omits the wrong fact still leaves the owner guessing.
  it("names the vanished worktree, not the CLI, when the directory it was given is gone", async () => {
    const worktree = workspaceDirectory();
    rmSync(worktree, { recursive: true, force: true });
    const started = createFakeCodexProvider().start(
      fixtureInvocation("session-1", fixtureWorkspace(worktree, "READ_WRITE")),
      noopListener(),
    );
    // Through `resolves`, like the spawn-failure case below it: the failure mode being guarded
    // against is `start()` REJECTING instead of answering, and a bare await would report that as a
    // thrown error rather than as a failed assertion about the outcome.
    await expect(started).resolves.toMatchObject({ type: "NEEDS_HUMAN" });
    const request = expectNeedsHuman(await started);
    expect(request.context).toContain(worktree);
    expect(request.title).toContain("no directory to run in");
    expect(request.recommendation).toContain(worktree);
    expect(request.title).not.toContain("could not start its CLI");
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
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(worktree, "READ_WRITE"));
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
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(workspaceDirectory(), "READ_WRITE"));
    const configValues = spawned.args.filter((arg, index) => spawned.args[index - 1] === "-c");
    expect(configValues).toEqual(["sandbox_workspace_write.network_access=true"]);
  });

  it("keeps a writable workspace offline when the run policy denies network", async () => {
    const spawned = recordSpawn();
    await startWith(
      spawned,
      createFakeCodexProvider(),
      fixtureWorkspace(workspaceDirectory(), "READ_WRITE", false),
    );
    expect(spawned.args[spawned.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(configAssignments(spawned.args)).toEqual([]);
  });

  // And none at all on the read-only path, which has nothing to widen.
  it("opens no config key when it has no workspace to write in", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider());
    expect(spawned.args.filter((arg, index) => spawned.args[index - 1] === "-c")).toEqual([]);
    expect(spawned.args).not.toContain("-c");
  });

  // §2.7. `--skip-git-repo-check` exists because `codex exec` refuses to start outside a trusted
  // directory and a fresh temporary directory is not one. A worktree IS a repository, so leaving
  // the flag off costs nothing and buys a check: if the daemon ever hands this adapter a path that
  // is not a repository, the CLI says so instead of running the session anyway.
  it("keeps the CLI's own repository check when it was given a worktree", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(workspaceDirectory(), "READ_WRITE"));
    expect(spawned.args).not.toContain("--skip-git-repo-check");
  });

  // §2.3. `codex exec` has no `--ask-for-approval`; passing one is a hard argument error that fails
  // the launch outright rather than degrading it. Checked over the flags alone, not the whole argv,
  // so realistic prompt text mentioning approval cannot fail this for a reason that says nothing
  // true.
  it("never passes an approval flag, which codex exec rejects outright", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(workspaceDirectory(), "READ_WRITE"));
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
    await startWith(spawned, createFakeCodexProvider(), fixtureWorkspace(worktree, "READ_WRITE"));
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

  it("removes NEEDS_HUMAN from the schema after this attempt has used its owner gate", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider(), undefined, "DISALLOWED");
    if (spawned.outputSchema === null) throw new Error("expected the fake CLI to capture the schema file");

    expect(spawned.outputSchema).toContain('"const":"COMPLETED"');
    expect(spawned.outputSchema).not.toContain('"const":"NEEDS_HUMAN"');
  });

  it("removes its per-session working directory once the session ends", async () => {
    const spawned = recordSpawn();
    await startWith(spawned, createFakeCodexProvider());
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
    await startWith(spawned, createFakeCodexProvider());
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

    const adapter = createFakeCodexProvider();
    const sessionId = "session-abort-1";
    const started = adapter.start(fixtureInvocation(sessionId), noopListener());

    const pid = await waitForHangMarker(markerPath);
    expect(isAlive(pid)).toBe(true);

    await adapter.abortSession(sessionId);
    expect(isAlive(pid)).toBe(false);

    await started;
  });
});
