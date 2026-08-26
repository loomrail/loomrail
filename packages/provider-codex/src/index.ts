import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

import {
  checkpointDraftSchema,
  type CheckpointDraft,
  type ProviderOutcome,
  type ProviderUsage,
} from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  runProcess,
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

// `codex exec --output-schema <file>` makes the CLI print one line, distinct from the `--json`
// event stream, that is the final turn's answer constrained to the given JSON Schema -- not
// wrapped in a `{"type": ...}` envelope, so `parseCodexEvent` (which only knows the four wire
// event shapes) never matches it and correctly drops it. This is the second thing every line is
// tried against once it fails as a known event.
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
        // Established by probing the real CLI, not by policy: before E1 this adapter runs in an
        // empty temporary directory with no repository, so IMPLEMENT and QA -- which need one --
        // are not offered. Declared the same whether or not the CLI is currently on this machine
        // -- `stages` says what this adapter would serve if it could run, `start` below is the
        // separate claim that it currently can. Overloading `stages` to also mean "unavailable"
        // (an earlier version of this adapter emptied it) collided with
        // `providerCapabilitiesSchema`'s own `stages.min(1)`, which exists to guarantee a
        // *working* adapter always declares somewhere to dispatch -- a guarantee that has nothing
        // to say about an adapter that cannot start at all. Task 9's gate
        // (session-loop.ts's `decideDispatchStage`) reads `start` directly for that case now.
        stages: ["DISCOVERY", "PLAN", "REVIEW"],
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
      // Per-session and removed in `finally`, including on failure (point 7): before E1 this
      // adapter has no repository access at all, and an empty directory plus `-s read-only` is
      // what enforces that. Leaking one would leak whatever the agent wrote into it.
      const workingDir = await mkdtemp(join(tmpdir(), "loomrail-codex-"));
      try {
        const outputSchemaPath = join(workingDir, "checkpoint-output-schema.json");
        await writeFile(outputSchemaPath, JSON.stringify(z.toJSONSchema(checkpointDraftSchema)), "utf8");

        // Verbatim, including the flags established by probing the real CLI (not documentation):
        // `--skip-git-repo-check` because `codex exec` refuses to start outside a trusted
        // directory, and this adapter always runs in a fresh empty one. Never
        // `--dangerously-bypass-approvals-and-sandbox` or any other permission-bypass flag --
        // SD-001 forbids Loomrail from enabling one automatically, on any code path.
        const args = [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-C",
          workingDir,
          "-s",
          "read-only",
          "--output-schema",
          outputSchemaPath,
          invocation.contextPack.text,
        ];

        let finalCheckpoint: CheckpointDraft | undefined;

        const run = runProcess({
          command: resolved.command,
          args,
          cwd: workingDir,
          onLine: (line) => {
            const event = parseCodexEvent(line);
            if (event !== null) {
              if (event.type === "turn.completed") {
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
                listener.onContextWindow({
                  usedTokens: event.usage.inputTokens,
                  windowTokens: resolved.contextWindowTokens,
                  quality: "ACTUAL",
                });
              }
              return;
            }
            const checkpoint = tryParseStructuredCheckpoint(line);
            if (checkpoint !== null) {
              finalCheckpoint = checkpoint;
              listener.onCheckpoint(checkpoint);
            }
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
        await run.exited;

        // `codex exec` is one-shot: the single turn it ran either produced a structured answer
        // conforming to the checkpoint schema we asked for, or it did not (a crash, a refusal, an
        // abort). There is no partial-progress state to distinguish from a clean stage
        // completion, so this is the whole decision -- CONTEXT_EXHAUSTED is the honest label for
        // "the session ended without one", matching the mock adapter's own use of that outcome
        // for a session that produced no checkpoint.
        return finalCheckpoint === undefined
          ? { type: "CONTEXT_EXHAUSTED" }
          : { type: "COMPLETED", summary: finalCheckpoint.summary };
      } finally {
        runningSessions.delete(sessionId);
        await rm(workingDir, { recursive: true, force: true });
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
