import type {
  CheckpointDraft,
  ContextPack,
  ContextWindowUsage,
  ProviderOutcome,
  ProviderUsage,
  WorkflowDispatch,
  WorkflowStage,
} from "@loomrail/contracts";
import { workflowStageSchema } from "@loomrail/contracts";
import { z } from "zod";

export type { ProcessExitOutcome, ProcessRun, RunProcessOptions } from "./process-runner.js";
export { runProcess } from "./process-runner.js";

// The set of adapters Loomrail can dispatch to. A live adapter is not a MOCK wearing a different
// label -- it is a distinct identity the daemon and the audit trail key on, so the enum is closed
// rather than left as a bare string an adapter could misspell.
export const providerIdSchema = z.enum(["MOCK", "CODEX", "CLAUDE_CODE"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

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

// Decisions and the brief are now sections of `contextPack`, not separate fields: the adapter's
// input surface shrinks to "the pack plus identifiers for correlation". An adapter that cannot
// see the raw state cannot assemble context its own way, and therefore cannot diverge from what
// the audit recipe says it was given.
export type ProviderInvocation = {
  dispatch: WorkflowDispatch;
  session: ProviderSessionRef;
  contextPack: ContextPack;
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
  // combining them would oblige the consumer of one to parse the other.
  onUsage: (usage: ProviderUsage) => void;
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
