import type {
  Decision,
  MockProviderOutcome,
  StageAttempt,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { z } from "zod";

export const providerCapabilitiesSchema = z
  .object({
    provider: z.literal("MOCK"),
    start: z.boolean(),
    resume: z.boolean(),
    interrupt: z.boolean(),
    eventStream: z.boolean(),
    usageReporting: z.boolean(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export type ProviderInvocation = {
  dispatch: WorkflowDispatch;
  stageAttempt: StageAttempt;
  workItem: WorkItem;
  decision: Decision | null;
};

export type ProviderAdapter = {
  capabilities: () => ProviderCapabilities;
  start: (invocation: ProviderInvocation) => Promise<MockProviderOutcome>;
  resume: (invocation: ProviderInvocation) => Promise<MockProviderOutcome>;
};
