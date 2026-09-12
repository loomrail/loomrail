import type { WorkflowStage } from "@loomrail/contracts";

// Pack estimates only. These are not promises about provider spend or cache hits.
// Keep room for tool replies and output; required data over the floor pauses durably.
export const stageContextTokenCaps: Readonly<Record<WorkflowStage, number>> = {
  DISCOVERY: 8_000,
  PLAN: 12_000,
  IMPLEMENT: 16_000,
  REVIEW: 24_000,
  QA: 16_000,
  ACCEPTANCE: 20_000,
};
