import { mockProviderOutcomeSchema } from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  type ProviderAdapter,
  type ProviderInvocation,
} from "@loomrail/provider-core";

const discoveryQuestion = () =>
  mockProviderOutcomeSchema.parse({
    type: "NEEDS_HUMAN",
    request: {
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Choose the discovery depth",
      context:
        "The mock delivery pipeline needs one product decision before it can turn the brief into a plan.",
      recommendation:
        "Use the focused pass for a bounded task. Choose the extended pass when unknowns could change the approach.",
      options: [
        {
          id: "focused-pass",
          label: "Focused pass",
          consequence: "Validate the brief and proceed with the smallest sufficient plan.",
          recommended: true,
        },
        {
          id: "extended-pass",
          label: "Extended pass",
          consequence: "Spend another discovery round mapping constraints and edge cases.",
          recommended: false,
        },
      ],
      allowOther: true,
    },
  });

const complete = (invocation: ProviderInvocation) =>
  mockProviderOutcomeSchema.parse({
    type: "COMPLETED",
    summary:
      invocation.stageAttempt.stage === "DISCOVERY"
        ? "Discovery resumed from the recorded human decision."
        : invocation.stageAttempt.stage === "PLAN"
          ? "The bounded mock plan was produced from the accepted discovery direction."
          : "The mock implementation completed inside the approved budget revision.",
  });

const exhaustInitialImplementationBudget = () =>
  mockProviderOutcomeSchema.parse({
    type: "BUDGET_LIMIT_REACHED",
    usageIncrements: [50, 30, 15, 5],
    quality: "LOOMRAIL_ESTIMATE",
  });

const outcomeFor = (invocation: ProviderInvocation) => {
  if (invocation.stageAttempt.stage === "DISCOVERY" && invocation.dispatch.mode === "START") {
    return discoveryQuestion();
  }
  if (invocation.stageAttempt.stage === "IMPLEMENT" && invocation.stageAttempt.attempt === 1) {
    return exhaustInitialImplementationBudget();
  }
  return complete(invocation);
};

export const createMockProvider = (): ProviderAdapter => ({
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider: "MOCK",
      start: true,
      resume: true,
      interrupt: true,
      eventStream: true,
      usageReporting: true,
    }),
  start: (invocation) => Promise.resolve(outcomeFor(invocation)),
  resume: (invocation) => Promise.resolve(outcomeFor(invocation)),
});
