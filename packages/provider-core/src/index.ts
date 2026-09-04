import type {
  CheckpointDraft,
  ContextPack,
  ContextWindowUsage,
  ModelTier,
  ProviderAllowanceSnapshot,
  ProviderOutcome,
  ProviderId,
  ProviderModelMapping,
  ProviderUsage,
  WorkflowDispatch,
  WorkflowStage,
} from "@loomrail/contracts";
import {
  providerIdSchema,
  providerModelIdSchema,
  providerModelMappingSchema,
  workflowStageSchema,
} from "@loomrail/contracts";
import { z } from "zod";

import type { ProviderAcceptanceInput, ProviderStageResultPolicy } from "./stage-result.js";

export type { ProcessExitOutcome, ProcessRun, RunProcessOptions } from "./process-runner.js";
export { ProcessSpawnError, runProcess } from "./process-runner.js";
export type { UnproductiveSessionReason, UnproductiveSessionReport } from "./session-diagnosis.js";
export { describeUnproductiveSession } from "./session-diagnosis.js";
export type {
  DecodedProviderStageResult,
  ProviderAcceptanceInput,
  ProviderStageResultPolicy,
} from "./stage-result.js";
export { decodeProviderStageResult, providerStageResultSchemaFor } from "./stage-result.js";
export type {
  CliProviderDiagnostics,
  ProviderDiagnosticProbeOptions,
  ProviderRuntimeTarget,
  ProviderVersionObservation,
  VerifiedProviderTarget,
} from "./diagnostics.js";
export { createCliProviderDiagnostics } from "./diagnostics.js";
export {
  PROVIDER_ALLOWANCE_FUTURE_SKEW_MS,
  PROVIDER_ALLOWANCE_LIVE_TTL_MS,
  projectProviderAllowanceAdvisory,
  projectProviderAllowanceFreshness,
} from "./allowance.js";

// The set of adapters Loomrail can dispatch to. A live adapter is not a MOCK wearing a different
// label -- it is a distinct identity the daemon and the audit trail key on, so the enum is closed
// rather than left as a bare string an adapter could misspell.
export { providerIdSchema };
export type { ProviderId };
export { providerModelIdSchema, providerModelMappingSchema };
export type { ProviderModelMapping };

// `contextWindowTokens` is required, not optional: the pack budget (spec §4.3) is computed as a
// share of the window before the session starts, so an adapter that cannot declare its window
// size cannot be started at all -- assembling a pack against an unknown budget means guessing.
export const providerCapabilitiesSchema = z
  .object({
    provider: providerIdSchema,
    start: z.boolean(),
    interrupt: z.boolean(),
    eventStream: z.boolean(),
    usageReporting: z.boolean(),
    contextWindowReporting: z.boolean(),
    checkpointOnRequest: z.boolean(),
    contextWindowTokens: z.number().int().positive(),
    // Before E1 a live adapter runs its CLI in an empty temporary directory: it has no
    // filesystem access and therefore nothing to change, so it cannot serve IMPLEMENT. Without
    // this declaration the dispatcher would send it that stage anyway, it would return prose,
    // and the stage would look done with no work behind it. `.min(1)` is deliberate: an adapter
    // that serves no stage at all can never be dispatched to, so declaring at least one is not
    // optional the way an empty list would otherwise imply.
    stages: z.array(workflowStageSchema).min(1),
    // Whether the adapter can report what a session cost. Distinct from `usageReporting`, which
    // is about context-window consumption, not spend -- an adapter can know how full its window
    // got without knowing what that turn billed, and vice versa.
    costReporting: z.boolean(),
    canReportRateLimits: z.boolean().optional(),
  })
  .strict()
  .refine(
    (capabilities) => !capabilities.checkpointOnRequest || capabilities.eventStream,
    "Winding down on request needs an event stream to deliver the checkpoint on",
  )
  // Occupancy has exactly one channel: `onContextWindow` on the session listener (spec §4.3
  // amended -- occupancy arrives only in the stream, not with the outcome too; no outcome member
  // carries a ContextWindowUsage). An adapter that cannot stream has no way to satisfy this
  // capability, so claiming it without `eventStream` is exactly as unsatisfiable as claiming
  // `checkpointOnRequest` without `eventStream` above. An adapter that cannot report occupancy at
  // all should leave `contextWindowReporting: false`; Loomrail then estimates and tags the result
  // `LOOMRAIL_ESTIMATE` (spec §5.2).
  .refine(
    (capabilities) => !capabilities.contextWindowReporting || capabilities.eventStream,
    "Reporting context-window occupancy needs an event stream to deliver it on",
  );

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

// `stage` is kept on the session reference on purpose: choosing a model tier and a tool set is
// legitimate adapter work and needs something to key on. `attempt` is kept for the same reason,
// and for one more: it is the durable, persisted `StageAttempt.attempt` (spec §6.5), passed
// through structurally instead of being re-derived by an adapter parsing prose out of the
// rendered pack. Prose parsing coupled a mock's control flow to wording `context-assembly`'s
// render step owns and could change without warning; a typed field on the invocation cannot
// drift out from under an adapter the way a regex over rendered text can.
export type ProviderSessionRef = {
  id: string;
  ordinal: number;
  stageAttemptId: string;
  stage: WorkflowStage;
  attempt: number;
};

const absolutePathPattern = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/**
 * A provider can only see the session-scoped Loomrail connector, never the real MCP server launch
 * recipe. The gateway owns the token in `args`, applies the grant again and closes the connector
 * with the ProviderSession.
 */
export const providerMcpConnectionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,64}$/),
    proxyCommand: z.string().min(1).max(4_096).regex(absolutePathPattern),
    proxyArgs: z.array(z.string().min(1).max(2_048)).max(8),
    enabledTools: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((connection, context) => {
    if (new Set(connection.enabledTools).size !== connection.enabledTools.length) {
      context.addIssue({ code: "custom", message: "MCP connector tool names must be unique" });
    }
  });

export type ProviderMcpConnection = z.infer<typeof providerMcpConnectionSchema>;

// Decisions and the brief are now sections of `contextPack`, not separate fields: the adapter's
// input surface shrinks to "the pack plus identifiers for correlation". An adapter that cannot
// see the raw state cannot assemble context its own way, and therefore cannot diverge from what
// the audit recipe says it was given.
export type ProviderInvocation = {
  dispatch: WorkflowDispatch;
  session: ProviderSessionRef;
  contextPack: ContextPack;
  /** Immutable logical tier from the active AgentRun policy. */
  modelTier: ModelTier;
  /**
   * Exact validated model from the same immutable policy snapshot. Optional only for AgentRuns
   * written before model binding; adapters fall back to their current tier mapping for those.
   */
  modelId?: string | null;
  /**
   * A structured copy of the criterion/check text rendered into this same pack, present only for
   * Acceptance. It carries no authority IDs: adapters may propose a mapping without parsing prose,
   * while the domain still resolves and verifies every durable reference itself.
   */
  acceptanceInput: ProviderAcceptanceInput | null;
  /**
   * Whether this StageAttempt may open a provider-authored owner gate.
   *
   * The daemon derives this from durable HumanRequests attached to the attempt. Adapters must use
   * it both for the schema shown to the provider and for decoding the result: prompt wording alone
   * is not an enforcement boundary, and `dispatch.mode` also covers soft-pause recovery where no
   * owner gate has been used.
   */
  humanRequests: ProviderStageResultPolicy["humanRequests"];
  /** Required closed set. An empty array means this session has no MCP connections. */
  mcpConnections: readonly ProviderMcpConnection[];
  /**
   * Daemon-owned revocation signal for the durable AgentRun authority behind this invocation.
   * A trusted adapter must check it immediately before spawning provider work. The daemon also
   * calls `abortSession` when cancellation revokes an already-spawned session.
   */
  authoritySignal: AbortSignal;
  // The Git worktree this session may write in (spec E1 D8), or absent when there is none.
  //
  // Absent means the read-only path every session took before this milestone: the adapter runs its
  // CLI in an empty temporary directory with nothing to change. It is a real instruction, but it is
  // not a SAFE default, and an adapter must not read it as one. A stage in `stagesRequiringWorkspace`
  // (`@loomrail/domain`) that arrives here with this field absent is a caller bug, and treating it as
  // "this session was never meant to change anything" is how a stage closes COMPLETED carrying an
  // agent's plausible answer about work it had nowhere to do -- which is exactly what happened
  // between the Codex adapter declaring IMPLEMENT and the daemon being taught to pass this field.
  //
  // The daemon is what keeps that from recurring: it builds the only production invocation in this
  // repository, and `decideSessionWorkspace` (`@loomrail/domain`) refuses the dispatch -- as a
  // blocking question to the owner, before any session opens -- when a writing stage's invocation
  // would carry no workspace. What an adapter is entitled to assume is therefore exactly what that
  // gate guarantees, and no more.
  workspace?: ProviderWorkspace;
};

// `path` is the only field an adapter needs to launch: it is the directory the CLI is pointed at
// and the only place the session may write. `branch` and `baseCommit` are carried alongside it
// because they identify WHICH work this worktree holds -- the base a later step diffs against to
// find what the session actually changed, and the branch that change lives on. They are recorded on
// the workspace entity too; passing them structurally is what keeps a consumer from re-deriving
// them by shelling out to git against a directory that may since have moved on.
export type ProviderWorkspace = {
  path: string;
  branch: string;
  // Null for a repository with no commits yet -- an empty repository genuinely has no HEAD, and
  // absent would read as "not recorded" (mirrors `workItemWorkspaceSchema.baseCommit`).
  baseCommit: string | null;
  /**
   * What this session may DO in the worktree, which is a separate question from having one.
   *
   * Required, and required for a reason: an adapter that inferred write access from the mere
   * presence of a workspace is how DISCOVERY, PLAN and REVIEW came to launch under
   * `-s workspace-write` with network access opened. Giving every agent stage the worktree (R11)
   * was right -- a review that cannot read the change is useless -- but only IMPLEMENT may
   * change it, and a field with a default would have let the wider access go on being the silent
   * fallback. The caller states it; `stageWritesInWorkspace` (`@loomrail/domain`) is what the
   * daemon reads to answer it, so no adapter carries a list of stages of its own.
   *
   * An adapter maps this and `networkAccess` onto whatever its CLI understands. READ_ONLY still means the real
   * worktree at `path`: the session reads the work item's own branch, it just may not write to it.
   */
  access: "READ_ONLY" | "READ_WRITE";
  /** Whether the immutable AgentRun policy permits provider network access. */
  networkAccess: boolean;
};

// Neither method is speculative. Without a stream of window occupancy, Loomrail only learns how
// full the window was after the session ended, and the preventive cut degrades to a purely
// reactive one. Without checkpoints arriving during the session, a crashed process loses the
// whole session rather than its tail. Adapters that cannot stream deliver a single checkpoint in
// the outcome instead -- worse, but honest, and the difference is declared in `capabilities`.
export type ProviderSessionListener = {
  onContextWindow: (usage: ContextWindowUsage) => void;
  onCheckpoint: (draft: CheckpointDraft) => void;
  // Deliberately a separate channel from `onContextWindow`, not another field on
  // ContextWindowUsage (spec BD-001). Window occupancy drives session handoff; spend drives budget
  // thresholds and the HARD pause. Those are different quantities with different consumers, and
  // combining them would oblige the consumer of one to parse the other. This callback carries one
  // final cumulative report per session, not streaming deltas: persistence enforces that cardinality
  // so a provider retry cannot charge the same session twice.
  onUsage: (usage: ProviderUsage) => void;
  /** Optional external account-capacity observation; never a budget or workflow command. */
  onAllowance?: (snapshot: ProviderAllowanceSnapshot) => void;
  // Spec §8: the pid of the child process this session is actually driving, so a daemon that dies
  // without killing it can still find and kill that process on the next start
  // (@loomrail/persistence-sqlite's `provider_sessions.process_pid`). Optional, unlike the three
  // listeners above: most sessions have nothing to report here. MOCK spawns no process at all and
  // must simply never call this -- that silence is exactly what the column's nullability exists to
  // represent, not a gap to fill in. A live adapter that does spawn one calls it at most once, right
  // after its process runner returns a pid, not on every turn the way occupancy and usage stream.
  onProcessStarted?: (pid: number) => void;
};

// The one failure `start` can report that Loomrail knows how to act on by itself (spec §7): the
// pack was judged as fitting from a LOOMRAIL_ESTIMATE and the provider disagreed. Every other
// rejection is a provider failure, and treating the two alike would answer a transient network
// error by shrinking the pack and then asking the owner the wrong question. A class rather than a
// string match, so an adapter states the diagnosis instead of Loomrail guessing it from prose.
export class ProviderPackTooLargeError extends Error {
  readonly sessionId: string;
  readonly estimatedTokens: number | null;

  constructor(sessionId: string, message: string, estimatedTokens: number | null = null) {
    super(message);
    this.name = "ProviderPackTooLargeError";
    this.sessionId = sessionId;
    this.estimatedTokens = estimatedTokens;
  }
}

export type ProviderAdapter = {
  capabilities: () => ProviderCapabilities;
  // The owner-facing policy editor needs the same validated mapping the adapter will use. Keeping
  // it on the adapter prevents the web app from maintaining a second, drifting model catalogue.
  // MOCK and third-party test adapters may omit it when no real provider model is selected.
  modelMapping?: () => ProviderModelMapping;
  /** Bounded read-only provider surface. Present only when the adapter capability is implemented. */
  readAllowance?: () => Promise<ProviderAllowanceSnapshot>;
  start: (invocation: ProviderInvocation, listener: ProviderSessionListener) => Promise<ProviderOutcome>;
  requestHandoff: (sessionId: string) => Promise<void>;
  // Spec §7 promises a *hard* cut when a wind-down request is ignored, and `requestHandoff` cannot
  // deliver one: it is a request the agent is free to keep ignoring. Without this method Loomrail
  // would stop waiting on `start()` and open the next session while the abandoned one is still
  // running and still billing -- two concurrent sessions on one StageAttempt, which Task 7's
  // storage invariant forbids and which the database would nevertheless show as satisfied.
  // Idempotent, and safe for a session that has already ended.
  abortSession: (sessionId: string) => Promise<void>;
};
