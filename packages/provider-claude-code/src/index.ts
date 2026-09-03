import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type { ProviderOutcome, ProviderUsage, WorkflowStage } from "@loomrail/contracts";
import {
  decodeProviderStageResult,
  describeUnproductiveSession,
  providerStageResultSchemaFor,
  providerMcpConnectionSchema,
  providerCapabilitiesSchema,
  runProcess,
  ProcessSpawnError,
  type DecodedProviderStageResult,
  type ProcessExitOutcome,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
  type ProviderStageResultPolicy,
} from "@loomrail/provider-core";
import { z } from "zod";

export { claudeCodeProviderDiagnostics } from "./diagnostics.js";

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
// assemble packs this provider then has no room for. PLAINLY: this is a conservative guess, not a
// figure checked against the real CLI -- nothing in this milestone's reconnaissance confirmed it.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// This CLI enforces its own spend cap (`--max-budget-usd`) instead of Loomrail's estimate being
// the only limit -- BD-001. Until "remaining budget" is threaded through `ProviderInvocation`
// (it is not, as of this milestone: the type carries `dispatch`/`session`/`contextPack` only),
// this is a fixed ceiling supplied once at construction, the same way
// DEFAULT_CONTEXT_WINDOW_TOKENS is a fixed declared figure rather than a per-session one. PLAINLY:
// this $5 figure is a conservative guess of "unlikely to bite a real DISCOVERY/PLAN/REVIEW
// session before it finishes", not a number measured against the real CLI or a spend policy
// anyone signed off on -- treat it as a placeholder a real policy should replace.
const DEFAULT_MAX_BUDGET_USD = 5;

export type CreateClaudeCodeProviderOptions = {
  // The `claude` executable to spawn. Overridable so tests can point it at a stand-in without
  // touching PATH.
  command?: string;
  // Trusted argv placed before the adapter-built Claude arguments. This keeps executable wrappers
  // shell-free (tests use `node <fixture>`) while leaving the default CLI invocation unchanged.
  commandArgsPrefix?: readonly string[];
  contextWindowTokens?: number;
  maxBudgetUsd?: number;
};

type ResolvedOptions = {
  command: string;
  commandArgsPrefix: readonly string[];
  contextWindowTokens: number;
  maxBudgetUsd: number;
};

const resolveOptions = (options: CreateClaudeCodeProviderOptions): ResolvedOptions => ({
  command: options.command ?? "claude",
  commandArgsPrefix: options.commandArgsPrefix ?? [],
  contextWindowTokens: options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
});

// Spec §9, first line: `capabilities()` must not promise a provider whose CLI is not on this
// machine -- see provider-codex's identical helper of this name for the full reasoning (a bare
// command like the default "claude" is resolved against `PATH` the same way
// `child_process.spawn` would, rather than checked as a literal relative path; a path, absolute
// or containing a separator, is checked directly; `X_OK` rather than mere existence, because a
// file that cannot be executed is exactly as unusable to `runProcess` as one that is absent).
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

// `--json-schema <inline JSON>` (established by task 1's reconnaissance, and corrected by a later
// review that verified against the installed CLI: the flag's value is the schema text itself, not
// a path -- `claude --help` shows this in the flag's own usage text, and passing a path instead
// makes the real CLI exit 0 with no output at all, silently) is what lets a single `claude -p`
// turn deliver a structured answer instead of free prose: on success the terminal `result`
// event's text is expected to be JSON conforming to the current stage-result schema. Untrusted process
// output either way -- a line that fails to parse or fails the shape check returns `null` rather
// than throwing, exactly like `tryParseStructuredResult` in provider-codex.
const tryParseStructuredResult = (
  text: string,
  stage: WorkflowStage,
  policy: ProviderStageResultPolicy,
): DecodedProviderStageResult | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return null;
  }
  return decodeProviderStageResult(stage, candidate, policy);
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
  // Checked once, here, at construction -- not inside `capabilities()`, which is called
  // repeatedly, including on paths where the answer must be cheap -- see provider-codex's
  // identical check for the identical reason.
  const cliAvailable = isExecutableOnDisk(resolved.command);
  // Keyed by ProviderSession id, not stage-attempt id -- see provider-codex's identical map for
  // the identical reason: this exists only so `abortSession` can find the child a given `start()`
  // call is still waiting on.
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CLAUDE_CODE",
        // Established by the same reasoning as provider-codex's `stages`: this adapter runs in an
        // empty temporary directory with no repository, so IMPLEMENT and QA -- which need one --
        // are not offered. E1 did not change that, and its fix round made the omission load-bearing
        // in a second way: the daemon cuts no worktree at all for an adapter that declares no stage
        // requiring one (`adapterWorksInWorkspace`, `@loomrail/domain`), so this adapter's sessions
        // cost the owner's repository nothing rather than having a branch and a carry-in commit
        // written for a workspace it would never read. Declared the same whether or not the CLI is currently on
        // this machine -- see provider-codex's identical comment: `stages` says what this
        // adapter would serve if it could run, `start` below is the separate claim that it
        // currently can, and task 9's gate (session-loop.ts's `decideDispatchStage`) reads
        // `start` directly to refuse an unavailable adapter regardless of what it declares here.
        stages: ["DISCOVERY", "PLAN", "REVIEW"],
        // Spec §9, first line: false when the executable this adapter would spawn is not on this
        // machine, checked once above at construction. `providerCapabilitiesSchema.parse()` runs
        // unconditionally on this object either way -- there is no branch that skips validation.
        start: cliAvailable,
        // A running child can always be killed -- see `abortSession` below, which awaits the
        // real exit rather than merely sending a signal.
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        // Spec §7 lists this adapter with `contextWindowReporting: true`, on the grounds that
        // usage arrives in both `assistant` and `result` events -- and `parseClaudeEvent`'s
        // `result` event now carries real `inputTokens` (see `stream.ts`) to satisfy it.
        // `eventStream: true` above is what the contract's own refine (provider-core) requires
        // before this can be `true` at all: occupancy has exactly one channel, `onContextWindow`
        // on the session listener, and an adapter with no stream would have nothing to deliver it
        // on. This one does -- see the `onContextWindow` call below, mirroring provider-codex's
        // `turn.completed` handler.
        contextWindowReporting: true,
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
      // Per-session and removed in `finally`, including on failure -- this adapter has no
      // repository access at all, E1 included, and an empty directory plus `--permission-mode plan`
      // is what enforces that. `invocation.workspace` is read nowhere here, deliberately: the write
      // path has never been run against this CLI on this machine. Leaking a directory would leak
      // whatever the agent wrote into it.
      const workingDir = await mkdtemp(join(tmpdir(), "loomrail-claude-"));
      try {
        const mcpConnections = providerMcpConnectionSchema.array().max(64).parse(invocation.mcpConnections);
        const mcpConfigPath = join(workingDir, "mcp-config.json");
        await writeFile(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: Object.fromEntries(
              mcpConnections.map((connection) => [
                connection.id,
                {
                  type: "stdio",
                  command: connection.proxyCommand,
                  args: connection.proxyArgs,
                },
              ]),
            ),
          }),
          { encoding: "utf8", mode: 0o600 },
        );
        // Inline JSON text, not a path -- see the doc comment on `tryParseStructuredResult`
        // above for why. Nothing writes this to `workingDir`: there is no reader left for a file
        // version of it, and a file created for no reader is one more thing to leak.
        const stageResultJsonSchema = JSON.stringify(
          z.toJSONSchema(
            providerStageResultSchemaFor(invocation.session.stage, {
              humanRequests: invocation.humanRequests,
            }),
          ),
        );

        // Verbatim, exactly as task 1's reconnaissance established it against the real CLI --
        // with one correction: `claude --help` documents `-p, --print` as a boolean flag ("Print
        // response and exit"), not an option that takes the prompt as its own value. The prompt
        // is a separate positional argument; it is placed last, after every named flag, so the
        // flag block above stays exactly the order reconnaissance recorded and the positional
        // cannot be misread as belonging to `-p` (or to any flag before it) by a future reader --
        // `child_process.spawn` receives this as an argv array, not a shell string, so there is no
        // quoting hazard in appending arbitrary prompt text here either way.
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
          "--output-format",
          "stream-json",
          "--verbose",
          "--mcp-config",
          mcpConfigPath,
          "--strict-mcp-config",
          "--permission-mode",
          "plan",
          "--no-session-persistence",
          "--max-budget-usd",
          String(resolved.maxBudgetUsd),
          "--json-schema",
          stageResultJsonSchema,
          invocation.contextPack.text,
        ];

        // Deliberately `undefined`, not a valid business result. Initialising this to
        // `CONTEXT_EXHAUSTED` -- which `claude -p` never reports -- meant that every silent way a
        // session could end (a wrong flag, a stream the parser could make nothing of, a CLI that
        // exited before saying anything) arrived at the daemon labelled as a measured fact. The
        // decision is made once, at the end of `start()`, from what actually happened.
        let outcome: ProviderOutcome | undefined;
        // The CLI's own last diagnostic, kept so a failed session can quote it -- this is the
        // "Not logged in · Please run /login" text spec §9 line 291 promised the owner and never
        // delivered.
        let providerFailureText: string | undefined;
        // Spec §9's "invalid JSON -> the line is dropped with a record". `parseClaudeEvent` stays
        // pure (no logger), so the record is a count kept here and stated in the session's own
        // diagnosis. Note this counts every line the parser surfaced nothing for, which includes
        // the `system` and `assistant` events it drops by design -- the wording in
        // `describeUnproductiveSession` says exactly that, and the number is only ever shown for a
        // session that produced no result at all.
        let linesReceived = 0;
        let linesUnused = 0;

        const run = runProcess({
          command: resolved.command,
          args: [...resolved.commandArgsPrefix, ...args],
          cwd: workingDir,
          onLine: (line) => {
            linesReceived += 1;
            const event = parseClaudeEvent(line);
            if (event === null) {
              linesUnused += 1;
              return;
            }

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
              // Real figures from the wire `result` event's own `usage` object -- see
              // `stream.ts`'s doc comments on `ClaudeEvent`/`rawResultEventSchema` for exactly
              // which wire fields these are and why `cachedInputTokens` maps to
              // `cache_read_input_tokens` specifically (the tokens served from a previous cache
              // entry) and not `cache_creation_input_tokens` (a distinct, separately-billed
              // quantity with no field of its own here). `quality: "ACTUAL"` is honest for every
              // field in this record now, not just `costUsd`.
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cachedInputTokens: event.cachedInputTokens,
              costUsd: event.costUsd,
              quality: "ACTUAL",
            };
            listener.onUsage(usage);
            // The whole reason this can be ACTUAL rather than an estimate: `event.inputTokens`
            // is the real prompt-token count the CLI itself reported on this turn, not a guess
            // Loomrail made about it (spec §5.2's LOOMRAIL_ESTIMATE is for adapters with nothing
            // better). Mirrors provider-codex's identical `turn.completed` -> `onContextWindow`
            // call.
            // Clamped, for the reason spelled out in provider-codex's identical call: the contract
            // rejects `usedTokens > windowTokens` and the daemon silently drops what it cannot
            // parse, so an understated declared window would disable occupancy reporting outright
            // rather than merely skew it. Reporting "full" is the safe direction -- it hands off
            // early instead of never.
            listener.onContextWindow({
              usedTokens: Math.min(event.inputTokens, resolved.contextWindowTokens),
              windowTokens: resolved.contextWindowTokens,
              quality: "ACTUAL",
            });

            if (!event.ok) {
              // Spec §9 line 291: an unauthenticated CLI becomes a Human Request carrying the
              // provider's own text. This is the "Not logged in · Please run /login" case -- the
              // one string that tells the owner what to do, and the one this adapter used to
              // discard in favour of a CONTEXT_EXHAUSTED it had measured nothing to support.
              providerFailureText = event.text;
              outcome = undefined;
              return;
            }

            const stageResult = tryParseStructuredResult(event.text, invocation.session.stage, {
              humanRequests: invocation.humanRequests,
            });
            if (stageResult !== null) {
              if (stageResult.checkpoint !== null) listener.onCheckpoint(stageResult.checkpoint);
              outcome = stageResult.outcome;
              return;
            }
            // A successful CLI turn is not a successful workflow stage unless its output satisfies
            // that stage's contract. Falling back to prose here would let Review skip evidence or
            // Acceptance skip the owner gate, so the session remains without an outcome and takes
            // the existing fail-closed Human Request path below.
          },
          // The CLI's own diagnostics, not an event stream Loomrail parses. Untrusted process
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
          // `runProcess` rejects `exited` with `ProcessSpawnError` when the executable itself
          // could never be started (e.g. missing). That must become a session failure, not an
          // unhandled rejection that would take the daemon down -- and the request names the
          // executable, because "install this, or fix your PATH" is the only fix and Loomrail
          // cannot make it.
          return describeUnproductiveSession({
            provider: "CLAUDE_CODE",
            command: resolved.command,
            reason: "SPAWN_FAILED",
            exitCode: null,
            signal: null,
            linesReceived,
            linesUnused,
            providerText: err.message,
          });
        }

        if (outcome !== undefined) return outcome;
        return describeUnproductiveSession({
          provider: "CLAUDE_CODE",
          command: resolved.command,
          reason: providerFailureText === undefined ? "NO_STRUCTURED_RESULT" : "PROVIDER_REPORTED_FAILURE",
          exitCode: exit.code,
          signal: exit.signal,
          linesReceived,
          linesUnused,
          providerText: providerFailureText ?? null,
        });
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
