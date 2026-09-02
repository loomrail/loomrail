import {
  acceptanceCriterionClaimSchema,
  checkpointDraftSchema,
  humanRequestDraftSchema,
  providerOutcomeSchema,
  reviewReportDraftSchema,
  type CheckpointDraft,
  type ProviderOutcome,
  type WorkflowStage,
} from "@loomrail/contracts";
import { z } from "zod";

const needsHumanSchema = z
  .object({
    type: z.literal("NEEDS_HUMAN"),
    request: humanRequestDraftSchema,
  })
  .strict()
  .describe(
    "Use this result only when missing owner information makes a correct non-human result impossible and the answer cannot be inferred from recorded Decisions. The request must pose one concrete answerable question. Never use this result for a progress update, intention, inspection status, summary, or announcement. If no owner input is needed, this result is invalid; use the normal stage result. Never ask for permission to proceed, for a stage handoff, for approval of a plan or implementation, for confirmation of an existing Decision, or for acceptance. Loomrail owns stage transitions and the acceptance gate. Work autonomously. Do not return until the current stage is complete or a required owner answer is genuinely missing.",
  );

const ordinaryCompletionSchema = checkpointDraftSchema.extend({ type: z.literal("COMPLETED") }).strict();

const qaArtifactSchema = z
  .object({
    kind: z.literal("QA_REPORT"),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(4_000),
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  })
  .strict();

const reviewCompletionSchema = ordinaryCompletionSchema
  .extend({ artifact: reviewReportDraftSchema })
  .strict()
  .describe(
    "Review the repository change without modifying it. Complete only after recording one structured REVIEW_REPORT.",
  );

const qaCompletionSchema = ordinaryCompletionSchema
  .extend({ artifact: qaArtifactSchema })
  .strict()
  .describe(
    "Verify the repository change in the available worktree. Complete only after recording one structured QA_REPORT.",
  );

const acceptanceReadySchema = z
  .object({
    type: z.literal("READY_FOR_ACCEPTANCE"),
    releaseNote: z.string().trim().min(1).max(4_000),
    verifyInstructions: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
    criteria: z.array(acceptanceCriterionClaimSchema).min(1).max(50),
  })
  .strict()
  .describe(
    "Summarize the completed delivery for its owner. This does not accept the work; only the owner can do that.",
  );

// OpenAI Structured Outputs accepts `anyOf` below the root but requires the root itself to be an
// object. Zod's discriminatedUnion emits `oneOf`, including when it is nested, while a plain union
// emits the supported `anyOf`. Keep the provider choice under one required `result` property so
// every stage schema has an object root, all fields remain required, and the exact branch contract
// stays visible to the model instead of being reimplemented as a collection of nullable fields.
const resultEnvelope = <T extends z.ZodType>(result: T, description: string) =>
  z.object({ result }).strict().describe(description);

const ordinaryStageResults = {
  DISCOVERY: ordinaryCompletionSchema.describe(
    "Investigate the work item and repository, resolve bounded unknowns, and report what remains.",
  ),
  PLAN: ordinaryCompletionSchema.describe(
    "Produce a bounded implementation plan that follows the repository constraints and acceptance criteria.",
  ),
  IMPLEMENT: ordinaryCompletionSchema.describe(
    "Implement the requested change in the supplied worktree and report the work actually completed.",
  ),
  REVIEW: reviewCompletionSchema,
  QA: qaCompletionSchema,
  ACCEPTANCE: acceptanceReadySchema,
} as const;

const stageDescriptions = {
  DISCOVERY: "Result of the DISCOVERY stage.",
  PLAN: "Result of the PLAN stage.",
  IMPLEMENT: "Result of the IMPLEMENT stage.",
  REVIEW: "Result of the REVIEW stage.",
  QA: "Result of the QA stage.",
  ACCEPTANCE: "Result of the ACCEPTANCE preparation stage.",
} as const;

const stageSchemas = {
  DISCOVERY: resultEnvelope(
    z.union([ordinaryStageResults.DISCOVERY, needsHumanSchema]),
    stageDescriptions.DISCOVERY,
  ),
  PLAN: resultEnvelope(z.union([ordinaryStageResults.PLAN, needsHumanSchema]), stageDescriptions.PLAN),
  IMPLEMENT: resultEnvelope(
    z.union([ordinaryStageResults.IMPLEMENT, needsHumanSchema]),
    stageDescriptions.IMPLEMENT,
  ),
  REVIEW: resultEnvelope(z.union([ordinaryStageResults.REVIEW, needsHumanSchema]), stageDescriptions.REVIEW),
  QA: resultEnvelope(z.union([ordinaryStageResults.QA, needsHumanSchema]), stageDescriptions.QA),
  ACCEPTANCE: resultEnvelope(
    z.union([ordinaryStageResults.ACCEPTANCE, needsHumanSchema]),
    stageDescriptions.ACCEPTANCE,
  ),
} as const;

const stageSchemasWithoutHumanRequest = {
  DISCOVERY: resultEnvelope(ordinaryStageResults.DISCOVERY, stageDescriptions.DISCOVERY),
  PLAN: resultEnvelope(ordinaryStageResults.PLAN, stageDescriptions.PLAN),
  IMPLEMENT: resultEnvelope(ordinaryStageResults.IMPLEMENT, stageDescriptions.IMPLEMENT),
  REVIEW: resultEnvelope(ordinaryStageResults.REVIEW, stageDescriptions.REVIEW),
  QA: resultEnvelope(ordinaryStageResults.QA, stageDescriptions.QA),
  ACCEPTANCE: resultEnvelope(ordinaryStageResults.ACCEPTANCE, stageDescriptions.ACCEPTANCE),
} as const;

export type ProviderStageResultPolicy = {
  humanRequests: "ALLOWED" | "DISALLOWED";
};

const defaultStageResultPolicy: ProviderStageResultPolicy = { humanRequests: "ALLOWED" };

export const providerStageResultSchemaFor = (
  stage: WorkflowStage,
  policy: ProviderStageResultPolicy = defaultStageResultPolicy,
): z.ZodType =>
  policy.humanRequests === "ALLOWED" ? stageSchemas[stage] : stageSchemasWithoutHumanRequest[stage];

export type DecodedProviderStageResult = {
  outcome: ProviderOutcome;
  checkpoint: CheckpointDraft | null;
};

const checkpointFrom = (value: CheckpointDraft): CheckpointDraft =>
  checkpointDraftSchema.parse({
    summary: value.summary,
    completed: value.completed,
    remaining: value.remaining,
    deadEnds: value.deadEnds,
    openQuestions: value.openQuestions,
  });

/**
 * Turn one provider-neutral structured result into Loomrail's durable stage outcome.
 *
 * Envelope parsing stays in each adapter because Codex and Claude put the JSON in different wire
 * events. Everything after JSON.parse is shared here so their Review, QA and Acceptance semantics
 * cannot drift apart.
 */
export const decodeProviderStageResult = (
  stage: WorkflowStage,
  candidate: unknown,
  policy: ProviderStageResultPolicy = defaultStageResultPolicy,
): DecodedProviderStageResult | null => {
  switch (stage) {
    case "DISCOVERY":
    case "PLAN":
    case "IMPLEMENT": {
      const schema =
        policy.humanRequests === "ALLOWED" ? stageSchemas[stage] : stageSchemasWithoutHumanRequest[stage];
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) {
        // A2 recordings predate the explicit `type` discriminant. Keep their bare checkpoint
        // shape readable on the three stages where a plain completion is semantically sufficient;
        // Review/QA deliberately get no such compatibility path because it would drop their typed
        // evidence, and Acceptance gets none because it would bypass the owner gate.
        const historical = checkpointDraftSchema.safeParse(candidate);
        if (!historical.success) return null;
        return {
          outcome: providerOutcomeSchema.parse({
            type: "COMPLETED",
            summary: historical.data.summary,
          }),
          checkpoint: historical.data,
        };
      }
      if (parsed.data.result.type === "NEEDS_HUMAN") {
        return { outcome: providerOutcomeSchema.parse(parsed.data.result), checkpoint: null };
      }
      return {
        outcome: providerOutcomeSchema.parse({
          type: "COMPLETED",
          summary: parsed.data.result.summary,
        }),
        checkpoint: checkpointFrom(parsed.data.result),
      };
    }
    case "REVIEW": {
      const schema =
        policy.humanRequests === "ALLOWED" ? stageSchemas.REVIEW : stageSchemasWithoutHumanRequest.REVIEW;
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) return null;
      if (parsed.data.result.type === "NEEDS_HUMAN") {
        return { outcome: providerOutcomeSchema.parse(parsed.data.result), checkpoint: null };
      }
      return {
        outcome: providerOutcomeSchema.parse({
          type: "COMPLETED",
          summary: parsed.data.result.summary,
          artifacts: [
            {
              kind: parsed.data.result.artifact.kind,
              title: parsed.data.result.artifact.title,
              summary: parsed.data.result.artifact.summary,
              checks: parsed.data.result.artifact.checks,
            },
          ],
          reviewReport: parsed.data.result.artifact,
        }),
        checkpoint: checkpointFrom(parsed.data.result),
      };
    }
    case "QA": {
      const schema =
        policy.humanRequests === "ALLOWED" ? stageSchemas.QA : stageSchemasWithoutHumanRequest.QA;
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) return null;
      if (parsed.data.result.type === "NEEDS_HUMAN") {
        return { outcome: providerOutcomeSchema.parse(parsed.data.result), checkpoint: null };
      }
      return {
        outcome: providerOutcomeSchema.parse({
          type: "COMPLETED",
          summary: parsed.data.result.summary,
          artifacts: [parsed.data.result.artifact],
        }),
        checkpoint: checkpointFrom(parsed.data.result),
      };
    }
    case "ACCEPTANCE": {
      const schema =
        policy.humanRequests === "ALLOWED"
          ? stageSchemas.ACCEPTANCE
          : stageSchemasWithoutHumanRequest.ACCEPTANCE;
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) return null;
      return {
        outcome: providerOutcomeSchema.parse(parsed.data.result),
        checkpoint: null,
      };
    }
  }
};
