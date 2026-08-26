import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkpointDraftSchema,
  type CheckpointDraft,
  type ProviderOutcome,
  type ProviderUsage,
} from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  runProcess,
  ProcessSpawnError,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
} from "@loomrail/provider-core";
import { z } from "zod";

import { parseClaudeEvent } from "./stream.js";

export type { ClaudeEvent } from "./stream.js";
export { parseClaudeEvent } from "./stream.js";

// Between the terminate signal and the unconditional kill -- same figure and same reasoning as
// provider-codex's own constant of this name: long enough for `claude -p` to unwind, short enough
// that abortSession does not wait forever on a child that will not.
const PROCESS_TERMINATION_GRACE_MS = 5_000;

// The outer bound on one provider session, independent of anything the CLI itself reports.
const SESSION_DEADLINE_MS = 600_000;

// Declared, not measured: no capability probe has established this provider's real window before
// A2 ships, so this is the figure the pack budget (spec §4.3) is computed against. Chosen to match
// the smallest window a current Claude model documents, for the same reason provider-codex picks
// a conservative default over an optimistic one -- overstating the window teaches the budget to
// assemble packs this provider then has no room for.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// This CLI enforces its own spend cap (`--max-budget-usd`) instead of Loomrail's estimate being
// the only limit -- BD-001. Until "remaining budget" is threaded through `ProviderInvocation`
// (it is not, as of this milestone: the type carries `dispatch`/`session`/`contextPack` only),
// this is a fixed ceiling supplied once at construction, the same way
// DEFAULT_CONTEXT_WINDOW_TOKENS is a fixed declared figure rather than a per-session one.
const DEFAULT_MAX_BUDGET_USD = 5;

export type CreateClaudeCodeProviderOptions = {
  // The `claude` executable to spawn. Overridable so tests can point it at a stand-in without
  // touching PATH.
  command?: string;
  contextWindowTokens?: number;
  maxBudgetUsd?: number;
};

type ResolvedOptions = {
  command: string;
  contextWindowTokens: number;
  maxBudgetUsd: number;
};

const resolveOptions = (options: CreateClaudeCodeProviderOptions): ResolvedOptions => ({
  command: options.command ?? "claude",
  contextWindowTokens: options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
});

// `--json-schema <file>` (established by task 1's reconnaissance against the real CLI) is what
// lets a single `claude -p` turn deliver a structured answer instead of free prose: on success the
// terminal `result` event's text is expected to be JSON conforming to `checkpointDraftSchema`.
// Untrusted process output either way -- a line that fails to parse or fails the shape check
// returns `null` rather than throwing, exactly like `tryParseStructuredCheckpoint` in
// provider-codex.
const tryParseStructuredCheckpoint = (text: string): CheckpointDraft | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return null;
  }
  const result = checkpointDraftSchema.safeParse(candidate);
  return result.success ? result.data : null;
};

type SessionRuntime = {
  // `.exited` is awaited directly by abortSession, not merely started -- resolving `stop()`
  // without waiting for it is the defect provider-codex's own milestone closed, and this adapter
  // must not reopen it.
  stop: () => Promise<void>;
};

// The second live adapter. `claude -p` is a single-turn print-mode invocation: it takes a prompt,
// runs to one terminal `result` event, and exits -- there is no channel back into a running
// instance that this milestone's reconnaissance could confirm (see the `checkpointOnRequest`
// comment below), which is why this adapter's session shape mirrors provider-codex's one-shot
// design even though the two CLIs are otherwise quite different.
export const createClaudeCodeProvider = (options: CreateClaudeCodeProviderOptions = {}): ProviderAdapter => {
  const resolved = resolveOptions(options);
  // Keyed by ProviderSession id, not stage-attempt id -- see provider-codex's identical map for
  // the identical reason: this exists only so `abortSession` can find the child a given `start()`
  // call is still waiting on.
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CLAUDE_CODE",
        // Established by the same reasoning as provider-codex's `stages`: before E1 this adapter
        // runs in an empty temporary directory with no repository, so IMPLEMENT and QA -- which
        // need one -- are not offered.
        stages: ["DISCOVERY", "PLAN", "REVIEW"],
        start: true,
        // A running child can always be killed -- see `abortSession` below, which awaits the real
        // exit rather than merely sending a signal.
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        // `parseClaudeEvent`'s one exposed event carries `costUsd` but no token breakdown (see
        // its own doc comment -- the wire event's `usage` object is deliberately not surfaced).
        // There is nothing to report window occupancy from, so Loomrail must estimate it for this
        // provider (spec §5.2, LOOMRAIL_ESTIMATE) rather than being told ACTUAL figures mid-
        // session.
        contextWindowReporting: false,
        // The one thing this adapter can report that provider-codex cannot: `total_cost_usd` on
        // the terminal `result` event is a real figure from the CLI, not something Loomrail has
        // to estimate.
        costReporting: true,
        // CONTROLLER RULING (task 8): the brief makes this conditional on reconnaissance
        // confirming that `--input-format stream-json` actually injects a message into an
        // already-running `claude -p` session. That reconnaissance could not be run in this
        // environment -- the `claude` CLI here is not authenticated (`is_error: true`, "Not
        // logged in · Please run /login"), and neither an agent nor the operator may authenticate
        // one on the owner's behalf. So the documented fallback applies: declared `false`, and
        // `requestHandoff` below is a no-op that resolves, exactly as it would be if the CLI had
        // no such channel at all. Nothing here speculates about how the injection would work --
        // raising this capability needs the recon run first, on an authenticated CLI, by the
        // owner.
        checkpointOnRequest: false,
        contextWindowTokens: resolved.contextWindowTokens,
      }),

    start: async (
      invocation: ProviderInvocation,
      listener: ProviderSessionListener,
    ): Promise<ProviderOutcome> => {
      const sessionId = invocation.session.id;
      // Per-session and removed in `finally`, including on failure -- before E1 this adapter has
      // no repository access at all, and an empty directory plus `--permission-mode plan` is what
      // enforces that. Leaking one would leak whatever the agent wrote into it.
      const workingDir = await mkdtemp(join(tmpdir(), "loomrail-claude-"));
      try {
        const jsonSchemaPath = join(workingDir, "checkpoint-json-schema.json");
        await writeFile(jsonSchemaPath, JSON.stringify(z.toJSONSchema(checkpointDraftSchema)), "utf8");

        // Verbatim, exactly as task 1's reconnaissance established it against the real CLI.
        // `--permission-mode plan` plus the empty `workingDir` above is what keeps this adapter
        // from touching a repository before E1 -- and, per SD-001, this is the only permission
        // mode this adapter ever passes. Never `--dangerously-skip-permissions`, never
        // `--allow-dangerously-skip-permissions`, never `--permission-mode bypassPermissions`:
        // SD-001 forbids Loomrail from enabling a permission bypass automatically, on any code
        // path, and the test suite's SD-001 case exists to catch a regression here, not merely to
        // document the rule. No `--input-format stream-json` -- see the `checkpointOnRequest`
        // comment in `capabilities` above for why that channel is not built.
        const args = [
          "-p",
          invocation.contextPack.text,
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "plan",
          "--no-session-persistence",
          "--max-budget-usd",
          String(resolved.maxBudgetUsd),
          "--json-schema",
          jsonSchemaPath,
        ];

        let outcome: ProviderOutcome = { type: "CONTEXT_EXHAUSTED" };

        const run = runProcess({
          command: resolved.command,
          args,
          cwd: workingDir,
          onLine: (line) => {
            const event = parseClaudeEvent(line);
            if (event === null) return;

            // The one event `parseClaudeEvent` ever surfaces is the terminal `result` (system
            // events, including the owner's hook output, are dropped upstream -- see that
            // module's own doc comment for why). `event.ok` is already the corrected reading of
            // it: computed from `is_error`, never from `subtype` -- reconnaissance against the
            // real CLI found an authentication failure reported as `subtype: "success"` with
            // `is_error: true`. This is the fact this adapter exists to get right: its outcome
            // below is driven by `event.ok` alone, never by whether `event.text` happens to look
            // like a checkpoint, so that a failed login cannot masquerade as a completed session
            // and silently defeat the session loop's guard against repeated failure.
            const usage: ProviderUsage = {
              // `parseClaudeEvent` does not surface a token breakdown (see the capabilities
              // comment above) -- 0 here is "not reported", not "measured as zero". `costUsd` is
              // the one figure in this record that is real, and `quality: "ACTUAL"` describes
              // that figure, not the token fields the contract otherwise requires.
              inputTokens: 0,
              outputTokens: 0,
              costUsd: event.costUsd,
              quality: "ACTUAL",
            };
            listener.onUsage(usage);

            if (!event.ok) {
              outcome = { type: "CONTEXT_EXHAUSTED" };
              return;
            }

            const checkpoint = tryParseStructuredCheckpoint(event.text);
            if (checkpoint !== null) {
              listener.onCheckpoint(checkpoint);
              outcome = { type: "COMPLETED", summary: checkpoint.summary };
              return;
            }
            // `--json-schema` is what is supposed to make a successful turn's result conform to
            // `checkpointDraftSchema`; if it somehow does not, the turn still succeeded --
            // `event.ok` said so, and that reading must not be re-derived from parseability here
            // -- so the outcome is still COMPLETED, just without a structured checkpoint to
            // publish, falling back to the CLI's own text as the summary.
            outcome = { type: "COMPLETED", summary: event.text.slice(0, 4_000) || "(no summary text)" };
          },
          // The CLI's own diagnostics, not an event stream Loomrail parses. Untrusted process
          // output either way, so nothing here is fed to a structured logger unexamined.
          onStderr: () => undefined,
          deadlineMs: SESSION_DEADLINE_MS,
          graceMs: PROCESS_TERMINATION_GRACE_MS,
        });

        runningSessions.set(sessionId, { stop: run.stop });
        try {
          await run.exited;
        } catch (err) {
          if (!(err instanceof ProcessSpawnError)) throw err;
          // `runProcess` rejects `exited` with `ProcessSpawnError` when the executable itself
          // could never be started (e.g. missing). That must become a session failure, not an
          // unhandled rejection that would take the daemon down -- CONTEXT_EXHAUSTED, with no
          // checkpoint, is the same honest label used everywhere else in this method for "the
          // session ended without one".
          return { type: "CONTEXT_EXHAUSTED" };
        }

        return outcome;
      } finally {
        runningSessions.delete(sessionId);
        await rm(workingDir, { recursive: true, force: true });
      }
    },

    // See the CONTROLLER RULING comment on `checkpointOnRequest` in `capabilities` above: no
    // injection path exists to request a wind-down through, so this resolves without doing
    // anything -- it must not reject, because the session loop calls it whenever the occupancy
    // threshold is crossed and cannot know which adapter it holds; rejecting would break a caller
    // that is behaving correctly. The loop already has a hard cut for when that matters --
    // `abortSession` below.
    requestHandoff: (_sessionId: string): Promise<void> => Promise.resolve(),

    // Idempotent, and awaits the real exit: `run.stop()` -- reused directly from `runProcess`,
    // not reimplemented -- only resolves once the child has actually gone, so this does too.
    abortSession: async (sessionId: string): Promise<void> => {
      const runtime = runningSessions.get(sessionId);
      if (runtime === undefined) return;
      await runtime.stop();
    },
  };
};
