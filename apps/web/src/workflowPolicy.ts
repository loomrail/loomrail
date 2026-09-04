import type { BudgetPolicy, ModelTier } from "@loomrail/contracts";

export const suggestedPipelineBudget = 1_000_000;
export const suggestedAgentRunBudget = 175_000;

export type WorkflowPolicyFormValues = {
  budgetLimitInput: string;
  agentRunLimitInput: string;
  modelTierOverride: ModelTier;
};

/** Keeps a paused run's editable cost policy anchored to its latest durable revision. */
export const workflowPolicyFormValues = (policy: BudgetPolicy): WorkflowPolicyFormValues => ({
  budgetLimitInput: String(policy.maxEstimatedTokens),
  agentRunLimitInput: String(policy.agentRunMaxEstimatedTokensOverride ?? suggestedAgentRunBudget),
  modelTierOverride: policy.modelTierOverride ?? "FAST",
});
