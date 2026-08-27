import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

import {
  checkpointDraftSchema,
  type CheckpointDraft,
  type ProviderOutcome,
  type ProviderUsage,
} from "@loomrail/contracts";
import {
  describeUnproductiveSession,
  providerCapabilitiesSchema,
  runProcess,
  ProcessSpawnError,
  type ProcessExitOutcome,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
} from "@loomrail/provider-core";
import { z } from "zod";

import { parseCodexEvent } from "./stream.js";

export type { CodexEvent } from "./stream.js";
export { parseCodexEvent } from "./stream.js";

// Between the terminate signal and the unconditional kill, mirroring provider-core's own default
// (spec's named constant): long enough for `codex exec` to unwind, short enough that abortSession
// does not wait forever on a child that will not.
const PROCESS_TERMINATION_GRACE_MS = 5_000;

// The outer bound on one provider session, independent of anything Codex itself reports. A stuck
// `codex exec` (network stall, a model that never emits a final turn) must not pin a session open
// forever -- `runProcess` enforces this by stopping the child once the deadline passes.
const SESSION_DEADLINE_MS = 600_000;

// Declared, not measured: before A2 ships a real capability probe, this is the number the pack
// budget (spec §4.3) is computed against. Deliberately conservative -- an adapter that overstates
// its window teaches the budget to assemble packs the provider then rejects (spec §7's
// ProviderPackTooLargeError branch), which is a worse failure than assembling a pack smaller than
// the window actually allows.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export type CreateCodexProviderOptions = {
  // The `codex` executable to spawn. Overridable so tests can point it at a stand-in without
  // touching PATH.
  command?: string;
  contextWindowTokens?: number;
};

type ResolvedOptions = {
  command: string;
  contextWindowTokens: number;
};

const resolveOptions = (options: CreateCodexProviderOptions): ResolvedOptions => ({
  command: options.command ?? "codex",
  contextWindowTokens: options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
});

// Spec §9, first line: `capabilities()` must not promise a provider whose CLI is not on this
// machine. A bare command (the default "codex", relying on PATH) is resolved against `PATH` the
// same way the shell/`child_process.spawn` would, rather than checked as a literal relative path
// -- otherwise the default would misreport itself as missing on every machine where "codex" is
// not a file in the daemon's own working directory. A path (absolute, or containing a separator)
// is checked directly. `accessSync(..., X_OK)` is used over `existsSync` because a file that
// exists but is not executable is exactly as unusable to `runProcess` as one that is absent.
const isExecutableOnDisk = (command: string): boolean => {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (process.env["PATH"] ?? "")
          .split(delimiter)
          .filter((dir) => dir.length > 0)
          .map((dir) => join(dir, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

// `codex exec --output-schema <file>` makes the CLI constrain the final turn's answer to the given
// JSON Schema. WHERE that answer comes back was the milestone's Critical: this adapter originally
// assumed a bare, un-enveloped JSON line on stdout, and therefore only tried this parser on lines
// that had already *failed* to parse as a known event -- so it never saw the answer at all, every
// real session ended with no checkpoint, and two in a row HARD-paused the attempt.
//
// Established by running this adapter's exact argv against the real CLI (codex v0.144.1): the
// structured answer arrives as the `text` of an `item.completed` / `agent_message` event, which
// `parseCodexEvent` matches. That enveloped path is the documented one and is tried first in
// `onLine` below. The bare-line attempt is kept as well -- it costs nothing, and a CLI version that
// prints the answer unenveloped would otherwise silently reopen the same Critical.
const tryParseStructuredCheckpoint = (line: string): CheckpointDraft | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return null;
  }
  const result = checkpointDraftSchema.safeParse(candidate);
  return result.success ? result.data : null;
};

// Whether the CLI can actually be launched in `path`. Asked before the spawn, because `spawn`
// answers a missing cwd with the SAME failure it gives a missing executable (ENOENT on the child),
// and this adapter's SPAWN_FAILED diagnosis names the executable -- so a worktree that went away
// between the daemon's dispatch check and this launch reached the owner as "codex is not
// installed", which is false and points at the wrong repair entirely.
//
// A file at the path is as unusable as nothing at all, so `isDirectory` is the question rather than
// mere existence. Any other error (a permissions problem on a parent) answers "not usable" too:
// this is a pre-flight, and the launch below is what reports the real failure if this was wrong.
const isUsableWorkingDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

type SessionRuntime = {
  // `.exited` is awaited directly by abortSession, not merely started -- resolving `stop()`
  // without waiting for it is the A1 defect this milestone is named for closing.
  stop: () => Promise<void>;
};

// The one live adapter this milestone ships. `codex exec` is a one-shot CLI: it takes a prompt,
// runs to a single final answer, and exits -- there is no channel back into a running instance,
// which is why `checkpointOnRequest` is false and `requestHandoff` below is a no-op rather than a
// promise the daemon could hang on.
export const createCodexProvider = (options: CreateCodexProviderOptions = {}): ProviderAdapter => {
  const resolved = resolveOptions(options);
  // Checked once, here, at construction -- not inside `capabilities()`, which is called
  // repeatedly, including on paths where the answer must be cheap. The filesystem does not
  // change under a running daemon in a way that matters for this decision, so one probe per
  // adapter instance is enough.
  const cliAvailable = isExecutableOnDisk(resolved.command);
  // Keyed by ProviderSession id, not stage-attempt id: A2 runs one live session per `start()`
  // call, and this map exists only so `abortSession` can find the child that call is still
  // waiting on. An entry is removed the moment its session ends, aborted or not.
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CODEX",
        // All six, as of E1. IMPLEMENT and QA were withheld for one reason only -- this adapter
        // ran its CLI in an empty temporary directory and so had nothing to change -- and that
        // reason is gone: given a workspace it runs `codex exec` inside the work item's own
        // worktree under `-s workspace-write` (see `start` below).
        //
        // This declaration is static, and deliberately says nothing about whether any particular
        // session will be handed a workspace. Whether one exists is the caller's business, and this
        // adapter has no way to check it: nothing in an invocation distinguishes "no workspace,
        // because this project has no usable repository" from "no workspace, because the caller
        // forgot", and for a while the daemon did forget -- it provisioned the worktree, took its lease, and then
        // built an invocation without it, so IMPLEMENT ran `-s read-only` in an empty temporary
        // directory and reported a stage it never touched. The gate that now prevents it lives
        // where the invocation is built (`decideSessionWorkspace`, `@loomrail/domain`, applied in
        // the daemon's session loop), not here. Making `stages` depend on a per-session fact would
        // be a capability that changes under the caller between the moment it is read and the
        // moment it is acted on.
        //
        // Declared the same whether or not the CLI is currently on this machine -- `stages` says
        // what this adapter would serve if it could run, `start` below is the separate claim that
        // it currently can. Overloading `stages` to also mean "unavailable" (an earlier version of
        // this adapter emptied it) collided with `providerCapabilitiesSchema`'s own
        // `stages.min(1)`, which exists to guarantee a *working* adapter always declares somewhere
        // to dispatch -- a guarantee that has nothing to say about an adapter that cannot start at
        // all. Task 9's gate (session-loop.ts's `decideDispatchStage`) reads `start` directly for
        // that case now.
        //
        // The sibling adapter is NOT changed to match. provider-claude-code's write path has never
        // been run against its real CLI here (that CLI is unauthenticated on this machine), and
        // asserting symmetry between two adapters on evidence gathered from only one of them is
        // exactly what produced two Criticals in the previous milestone.
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        // Spec §9, first line: false when the executable this adapter would spawn is not on this
        // machine, checked once above at construction. `providerCapabilitiesSchema.parse()` runs
        // unconditionally on this object either way -- there is no branch that skips validation.
        start: cliAvailable,
        // A running child can always be killed, which is what `interrupt` promises here -- a
        // harder guarantee than `checkpointOnRequest`, which asks the CLI to wind down on its
        // own and which `codex exec` has no channel to honour.
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        contextWindowReporting: true,
        // No cost figure appears anywhere in the JSONL stream.
        costReporting: false,
        // SD-001 note lives on `requestHandoff` below, not here: this field just states the fact
        // that follows from it -- a one-shot process cannot be asked to wind down early.
        checkpointOnRequest: false,
        contextWindowTokens: resolved.contextWindowTokens,
      }),

    start: async (
      invocation: ProviderInvocation,
      listener: ProviderSessionListener,
    ): Promise<ProviderOutcome> => {
      const sessionId = invocation.session.id;
      const workspace = invocation.workspace;
      // Created for every session and removed in `finally`, including on failure (point 7). It
      // holds the generated output schema, which must not be written into a worktree: what a
      // session changed is read back from git against that directory, and a file Loomrail itself
      // dropped there would show up as the agent's own work.
      const scratchDir = await mkdtemp(join(tmpdir(), "loomrail-codex-"));
      try {
        const outputSchemaPath = join(scratchDir, "checkpoint-output-schema.json");
        await writeFile(outputSchemaPath, JSON.stringify(z.toJSONSchema(checkpointDraftSchema)), "utf8");

        // With no workspace the scratch directory doubles as the working directory, and an EMPTY
        // directory plus `-s read-only` is the whole containment story (spec D1): the agent has
        // nothing to reach. Given a workspace, the CLI runs in the work item's own worktree
        // instead, which is the point of this milestone.
        const workingDir = workspace?.path ?? scratchDir;
        // Only ever a question about a workspace: the other branch of `workingDir` is this
        // function's own `mkdtemp` at the top of the try, which exists by construction. The daemon
        // checks the worktree before it dispatches, so what this covers is the window between that
        // check and this launch. Reported as its own reason rather than left to surface as a spawn
        // failure -- see `isUsableWorkingDirectory` above.
        if (!(await isUsableWorkingDirectory(workingDir))) {
          return describeUnproductiveSession({
            provider: "CODEX",
            command: resolved.command,
            reason: "WORKING_DIRECTORY_MISSING",
            workingDirectory: workingDir,
            exitCode: null,
            signal: null,
            linesReceived: 0,
            linesUnused: 0,
            linesUnreadable: 0,
            providerText: null,
          });
        }

        // Every flag below was established by probing the real CLI, not by reading its help. Never
        // `--dangerously-bypass-approvals-and-sandbox` or any other permission-bypass flag --
        // SD-001 forbids Loomrail from enabling one automatically, on any code path.
        const sandboxArgs =
          workspace === undefined
            ? [
                // `codex exec` refuses to start outside a trusted directory, and a fresh temporary
                // directory is not one. Needed only here: a worktree IS a repository, so the
                // workspace path below can leave the check in place and get a free assertion that
                // the directory it was handed really is one.
                "--skip-git-repo-check",
                "-s",
                "read-only",
              ]
            : [
                // The sandbox mode that lets the agent write, and only where it is pointed: the
                // worktree named by `-C` below. Spec D8.
                "-s",
                "workspace-write",
                // The ONE config key this adapter ever opens, and the single exception to the
                // threat model's closed list of forbidden `-c` overrides (T16) -- which otherwise
                // stands, `-c` being an arbitrary config override and `-c
                // 'sandbox_permissions=["disk-full-read-access"]'` a documented sandbox escape.
                // `workspace-write` denies network access by default, and an IMPLEMENT or QA
                // session that cannot reach the network cannot install a dependency or run a suite
                // that fetches one. The key widens exactly that and nothing else; it is asserted as
                // a closed list over the argv array in this package's tests.
                "-c",
                "sandbox_workspace_write.network_access=true",
                // NOT an approval flag. `codex exec` has no `--ask-for-approval`, and passing one
                // is a hard argument error that fails the launch outright (spec §2.3) -- the
                // sandbox mode above is the whole of what this adapter gets to say about what the
                // agent may do.
              ];

        const args = [
          "exec",
          "--json",
          // `codex exec` launched without this flag inherits the OWNER'S OWN entire
          // `~/.codex/config.toml`, not just the harmless bits: `approval_policy`, `sandbox_mode`,
          // hooks, plugins, model providers, and MCP servers all arrive from that file. `-s` below
          // does override `sandbox_mode` for the sandbox itself, so there is no "the agent could
          // write somewhere it should not" hole even without this flag -- but hooks, plugins and
          // MCP servers are not sandboxed at all, and spec D6 (this milestone's predecessor)
          // forbids MCP outright. Authentication lives in `CODEX_HOME`, not `config.toml`, so this
          // flag does not touch login.
          "--ignore-user-config",
          ...sandboxArgs,
          "-C",
          workingDir,
          "--output-schema",
          outputSchemaPath,
          invocation.contextPack.text,
        ];

        let finalCheckpoint: CheckpointDraft | undefined;
        // The provider's own last diagnostic, when it gave one. Kept so a failed session can name
        // what the CLI said instead of inventing a business result for it (see
        // `describeUnproductiveSession`).
        let providerFailureText: string | undefined;
        // Spec §9 promised that an unusable line is dropped "with a record". The parser stays pure
        // -- it takes no logger -- so the record is a count kept here and reported in the session's
        // own diagnosis. A session that received four hundred lines and understood none of them is
        // exactly the fact that would have made this milestone's Critical loud instead of silent.
        let linesReceived = 0;
        let linesUnused = 0;
        // A subset of `linesUnused`: the lines this adapter could not read AT ALL, as opposed to
        // the ones it read and had no use for. Kept apart because a writing session makes the
        // combined figure misleading -- six of the eleven lines of a real successful
        // workspace-write run are `item.started`/`command_execution`/`file_change`, understood and
        // deliberately unused. Reported as one number, a failed session of that shape accuses the
        // parser; reported as two, it clears it (see `linesUnreadable` in provider-core).
        let linesUnreadable = 0;
        // The CLI's own statement that the turn it was given ran to its end. `turn.completed` is
        // the last line of every successful run recorded in test/recordings/, and the only event
        // that carries the turn's real token usage -- a session that never emits it did not finish,
        // whatever else arrived before it. Read below as one half of "this session ended normally".
        let turnCompleted = false;

        const run = runProcess({
          command: resolved.command,
          args,
          cwd: workingDir,
          onLine: (line) => {
            linesReceived += 1;
            const event = parseCodexEvent(line);
            if (event !== null) {
              // "Unused" means this session got nothing out of the line -- no checkpoint, no usage,
              // no failure text -- NOT merely that the parser could not read it. The distinction is
              // the whole point of the counter: in the shape that produced this milestone's
              // Critical every line parses fine (the checkpoint was simply somewhere this adapter
              // never looked), so counting only parse failures made a real `hello.jsonl` run report
              // "4 lines received; 0 carried nothing this adapter could use" -- word for word what a
              // healthy session reports. It now reads "4 received, 3 unused", which says something.
              // This is also the reading provider-claude-code has always had, where the only event
              // the parser surfaces at all is the one the adapter consumes.
              let consumed = false;
              if (event.type === "turn.failed") {
                providerFailureText = event.errorMessage;
                consumed = true;
              }
              if (event.type === "item.completed") {
                // The documented path for `--output-schema`'s answer (see
                // `tryParseStructuredCheckpoint` above). The LAST match in the stream wins: a turn
                // can emit several `agent_message` items, and the final one is the answer the
                // schema constrained.
                const checkpoint = tryParseStructuredCheckpoint(event.item.text);
                if (checkpoint !== null) {
                  finalCheckpoint = checkpoint;
                  listener.onCheckpoint(checkpoint);
                  consumed = true;
                }
              }
              if (event.type === "turn.completed") {
                turnCompleted = true;
                const usage: ProviderUsage = {
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  cachedInputTokens: event.usage.cachedInputTokens,
                  reasoningOutputTokens: event.usage.reasoningOutputTokens,
                  // The whole reason this adapter can report ACTUAL rather than an estimate:
                  // `turn.completed` carries real token usage from the provider itself.
                  quality: "ACTUAL",
                };
                listener.onUsage(usage);
                // Clamped to the declared window, not reported raw. `contextWindowUsageSchema`
                // REJECTS `usedTokens > windowTokens`, and the daemon `safeParse`s an occupancy
                // report and silently drops what fails -- so an understated window does not merely
                // misreport occupancy, it disables occupancy reporting entirely, and with it the
                // handoff threshold that depends on it. Codex declares 128 000 while a trivial
                // prompt already measured 17 838 input tokens against a larger real window; the
                // clamp is what keeps a conservative declaration from silently costing the owner
                // the whole signal. It reads as "full", which is the safe direction: it triggers a
                // handoff early rather than never.
                listener.onContextWindow({
                  usedTokens: Math.min(event.usage.inputTokens, resolved.contextWindowTokens),
                  windowTokens: resolved.contextWindowTokens,
                  quality: "ACTUAL",
                });
                consumed = true;
              }
              if (!consumed) linesUnused += 1;
              return;
            }
            const checkpoint = tryParseStructuredCheckpoint(line);
            if (checkpoint !== null) {
              finalCheckpoint = checkpoint;
              listener.onCheckpoint(checkpoint);
              return;
            }
            linesUnused += 1;
            linesUnreadable += 1;
          },
          // Codex's own diagnostics, not an event stream Loomrail parses. Untrusted process
          // output either way, so nothing here is fed to a structured logger unexamined.
          onStderr: () => undefined,
          deadlineMs: SESSION_DEADLINE_MS,
          graceMs: PROCESS_TERMINATION_GRACE_MS,
        });

        runningSessions.set(sessionId, { stop: run.stop });
        // `run.pid` is `undefined` only if the child failed to spawn at all -- `runProcess`
        // reports that by rejecting `exited`, not by leaving `pid` unset while carrying on, so
        // this branch only skips the (impossible in practice) case of a runtime that returns no
        // pid for a process that did start.
        if (run.pid !== undefined) listener.onProcessStarted?.(run.pid);
        let exit: ProcessExitOutcome;
        try {
          exit = await run.exited;
        } catch (err) {
          if (!(err instanceof ProcessSpawnError)) throw err;
          // `runProcess` rejects `exited` with `ProcessSpawnError` when the executable could never
          // be started -- it vanished between this adapter's construction-time
          // `isExecutableOnDisk` probe and the spawn. Symmetric with provider-claude-code, which
          // has always caught this: two sibling adapters answering the same event differently is
          // the divergence that bites later.
          return describeUnproductiveSession({
            provider: "CODEX",
            command: resolved.command,
            reason: "SPAWN_FAILED",
            exitCode: null,
            signal: null,
            linesReceived,
            linesUnused,
            linesUnreadable,
            providerText: err.message,
          });
        }

        // `codex exec` is one-shot: the single turn it ran either produced a structured answer
        // conforming to the checkpoint schema we asked for, or it did not. What it must NOT do is
        // report a business result nobody measured -- this branch used to return
        // `CONTEXT_EXHAUSTED`, which `codex exec` never reports and which was therefore a lie in
        // every situation that reached it, this milestone's Critical included. Nothing is
        // initialised to a valid outcome any more: the decision is made here, at the end, from
        // what actually happened.
        //
        // A CHECKPOINT IS NOT ENOUGH, and this is the second Critical on the same line. `codex
        // exec` streams its `agent_message` items as it works, and on a real recorded run
        // (test/recordings/workspace-write.jsonl, line 3) the FIRST of them is the agent saying
        // what it is about to do -- schema-valid, with `completed: []`, indistinguishable in shape
        // from the real answer eight lines later. Last-wins (D9) only helps when the real answer
        // arrives. If the process dies after line 3 -- the owner pressing Ctrl+C on the daemon
        // (which kills the child through `abortSession`, while the resolved outcome is still
        // applied to the attempt), the 600-second session deadline, or any non-zero exit -- line 3
        // IS the last match, and returning COMPLETED on it closes the stage with the agent's
        // opening sentence as the result of work that never happened.
        //
        // So "the session ended normally" is asked as well, and both halves of it are asked because
        // they answer different failure modes. `turnCompleted` is the CLI's own account of the turn:
        // it excludes a stream that stopped mid-work and a turn the CLI itself reported as failed
        // after an intention message. The process exit is the OS's account of the same session: it
        // excludes a kill (a signal -- shutdown, deadline, `abortSession`) and a CLI that gave up
        // with a non-zero code. Neither one subsumes the other, and each on its own leaves a route
        // by which an intention becomes a stage result. The cost of asking both is a session that
        // finished but whose CLI stopped saying so being reported as unfinished -- which asks the
        // owner a question instead of inventing an answer, the direction this project chooses.
        //
        // `provider-claude-code` needs none of this: its outcome comes from the CLI's own terminal
        // `result` event, so a killed session simply never produces one.
        const endedNormally = exit.signal === null && exit.code === 0;
        if (finalCheckpoint !== undefined && turnCompleted && endedNormally) {
          return { type: "COMPLETED", summary: finalCheckpoint.summary };
        }
        // A turn the CLI said failed is named as that even when a checkpoint arrived first: it is
        // the more specific fact, and it is the one carrying the provider's own message.
        const reason =
          providerFailureText !== undefined
            ? "PROVIDER_REPORTED_FAILURE"
            : finalCheckpoint !== undefined
              ? "SESSION_ENDED_UNFINISHED"
              : "NO_STRUCTURED_RESULT";
        return describeUnproductiveSession({
          provider: "CODEX",
          command: resolved.command,
          reason,
          exitCode: exit.code,
          signal: exit.signal,
          linesReceived,
          linesUnused,
          linesUnreadable,
          providerText: providerFailureText ?? null,
        });
      } finally {
        runningSessions.delete(sessionId);
        // The scratch directory, never the worktree: the worktree outlives this session (it belongs
        // to the WorkItem, and the next attempt is meant to find the work still there), and its
        // removal is the daemon's, on its own schedule.
        await rm(scratchDir, { recursive: true, force: true });
      }
    },

    // Declared unsupported in capabilities, and a no-op here rather than an error: the session
    // loop calls this whenever the occupancy threshold is crossed and has no way to know which
    // adapter it is talking to, so throwing would break a loop that is behaving correctly.
    // Resolving without acting is what tells the loop honestly that no wind-down request could be
    // delivered -- the loop already has a hard cut (`abortSession`) for when that matters.
    requestHandoff: (_sessionId: string): Promise<void> => Promise.resolve(),

    // Idempotent, and awaits the real exit (point 6): `run.stop()` -- reused directly from
    // `runProcess`, not reimplemented -- only resolves once the child has actually gone, so this
    // does too.
    abortSession: async (sessionId: string): Promise<void> => {
      const runtime = runningSessions.get(sessionId);
      if (runtime === undefined) return;
      await runtime.stop();
    },
  };
};
