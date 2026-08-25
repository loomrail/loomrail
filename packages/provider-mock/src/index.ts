import { providerOutcomeSchema } from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  type ProviderAdapter,
  type ProviderInvocation,
} from "@loomrail/provider-core";

const discoveryQuestion = () =>
  providerOutcomeSchema.parse({
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
  providerOutcomeSchema.parse({
    type: "COMPLETED",
    summary:
      invocation.stageAttempt.stage === "DISCOVERY"
        ? "Discovery resumed from the recorded human decision."
        : invocation.stageAttempt.stage === "PLAN"
          ? "The bounded mock plan was produced from the accepted discovery direction."
          : invocation.stageAttempt.stage === "IMPLEMENT"
            ? "The mock implementation completed inside the approved budget revision."
            : invocation.stageAttempt.stage === "REVIEW"
              ? "Independent mock review completed without open findings."
              : "Deterministic mock browser QA completed without regressions.",
    ...(invocation.stageAttempt.stage === "REVIEW"
      ? {
          artifacts: [
            {
              kind: "REVIEW_REPORT",
              title: "Independent mock review",
              summary:
                "The synthetic reviewer found no blocking correctness, security, or maintainability issues.",
              checks: ["Requirements traced", "No blocking findings", "Regression scope recorded"],
            },
          ],
        }
      : invocation.stageAttempt.stage === "QA"
        ? {
            artifacts: [
              {
                kind: "QA_REPORT",
                title: "Deterministic mock QA",
                summary:
                  "The synthetic browser and runtime checks passed for the bounded acceptance fixture.",
                checks: [
                  "Primary journey passed",
                  "Desktop and mobile checked",
                  "No application console errors",
                ],
              },
            ],
          }
        : {}),
  });

const requestAcceptance = () =>
  providerOutcomeSchema.parse({
    type: "READY_FOR_ACCEPTANCE",
    releaseNote: "Completes the deterministic mock delivery flow with budget, review, QA, and owner control.",
    verifyInstructions: [
      "Run pnpm verify.",
      "Run pnpm test:e2e.",
      "Inspect the acceptance evidence in Loomrail.",
    ],
  });

const exhaustInitialImplementationBudget = () =>
  providerOutcomeSchema.parse({
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
  if (invocation.stageAttempt.stage === "ACCEPTANCE") return requestAcceptance();
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
