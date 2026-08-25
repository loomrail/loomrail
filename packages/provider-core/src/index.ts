import type {
  CheckpointDraft,
  ContextPack,
  ContextWindowUsage,
  ProviderOutcome,
  WorkflowDispatch,
  WorkflowStage,
} from "@loomrail/contracts";
import { z } from "zod";

// `contextWindowTokens` is required, not optional: the pack budget (spec §4.3) is computed as a
// share of the window before the session starts, so an adapter that cannot declare its window
// size cannot be started at all -- assembling a pack against an unknown budget means guessing.
export const providerCapabilitiesSchema = z
  .object({
    provider: z.literal("MOCK"),
    start: z.boolean(),
    interrupt: z.boolean(),
    eventStream: z.boolean(),
    usageReporting: z.boolean(),
    contextWindowReporting: z.boolean(),
    checkpointOnRequest: z.boolean(),
    contextWindowTokens: z.number().int().positive(),
  })
  .strict()
  .refine(
    (capabilities) => !capabilities.checkpointOnRequest || capabilities.eventStream,
    "Winding down on request needs an event stream to deliver the checkpoint on",
  );

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

// `stage` is kept on the session reference on purpose: choosing a model tier and a tool set is
// legitimate adapter work and needs something to key on.
export type ProviderSessionRef = {
  id: string;
  ordinal: number;
  stageAttemptId: string;
  stage: WorkflowStage;
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
};

export type ProviderAdapter = {
  capabilities: () => ProviderCapabilities;
  start: (invocation: ProviderInvocation, listener: ProviderSessionListener) => Promise<ProviderOutcome>;
  requestHandoff: (sessionId: string) => Promise<void>;
};
