import { z } from "zod";

import {
  actorSchema,
  opaqueIdSchema,
  providerIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { MAX_TOTAL_QA_CORRECTION_RUNS } from "./qa.js";

export const MAX_REVIEW_FINDINGS_PER_REPORT = 20;
export const MAX_OPEN_REVIEW_FINDINGS = 200;
export const MAX_AUTOMATIC_REVIEW_ROUNDS = 2;
export const MAX_OWNER_AUTHORIZED_REVIEW_ROUNDS = 1;
export const MAX_TOTAL_REVIEW_ROUNDS = MAX_AUTOMATIC_REVIEW_ROUNDS + MAX_OWNER_AUTHORIZED_REVIEW_ROUNDS;
export const MAX_REVIEW_REPORT_HISTORY = MAX_TOTAL_REVIEW_ROUNDS * (1 + MAX_TOTAL_QA_CORRECTION_RUNS);

export const reviewVerdictSchema = z.enum(["PASSED", "CHANGES_REQUESTED"]);
export const reviewFindingSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const reviewFindingStatusSchema = z.enum(["OPEN", "RESOLVED", "WAIVED", "FALSE_POSITIVE"]);
export const reviewFindingOwnerDispositionSchema = z.enum(["WAIVED", "FALSE_POSITIVE"]);
export const reviewProviderRelationSchema = z.enum(["CROSS_PROVIDER", "SAME_PROVIDER"]);

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().min(1).max(4_000);
const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const reviewFindingPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "Path must be relative")
  .refine((value) => !value.includes("\\"), "Path must use portable forward slashes")
  .refine(
    (value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Path must not contain empty, current-directory, or parent-directory segments",
  );

const reviewFindingDraftFields = {
  severity: reviewFindingSeveritySchema,
  title: titleSchema,
  description: descriptionSchema,
  path: reviewFindingPathSchema.nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  reproduction: descriptionSchema,
  criterion: z.string().trim().min(1).max(500).nullable(),
  suggestedFix: descriptionSchema.nullable(),
} as const;

const refineFindingLocation = (
  finding: { path: string | null; startLine: number | null; endLine: number | null },
  context: z.core.$RefinementCtx,
): void => {
  const hasLocation = finding.path !== null;
  const hasStart = finding.startLine !== null;
  const hasEnd = finding.endLine !== null;
  if (!hasLocation && (hasStart || hasEnd)) {
    context.addIssue({ code: "custom", message: "A line range requires a file path" });
  }
  if (hasStart !== hasEnd) {
    context.addIssue({ code: "custom", message: "A line range requires both start and end" });
  }
  if (finding.startLine !== null && finding.endLine !== null && finding.endLine < finding.startLine) {
    context.addIssue({ code: "custom", message: "The finding line range is reversed" });
  }
};

export const reviewFindingDraftSchema = z
  .object(reviewFindingDraftFields)
  .strict()
  .superRefine(refineFindingLocation);

const reviewReportDraftFields = {
  kind: z.literal("REVIEW_REPORT"),
  title: titleSchema,
  summary: descriptionSchema,
  checks: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
} as const;

// Keep the verdict invariant structural rather than hiding it in `superRefine`. Both live
// providers receive the JSON Schema generated from this contract before they answer; a refinement
// is enforced only after the response returns and therefore lets a CLI accept a contradictory
// `PASSED` report with findings (or an empty `CHANGES_REQUESTED` report) that Loomrail must then
// discard. A plain union emits JSON Schema `anyOf`, supported by both provider adapters, while
// preserving the same inferred discriminated data shape for domain consumers.
export const reviewReportDraftSchema = z.union([
  z
    .object({
      ...reviewReportDraftFields,
      verdict: z.literal("PASSED"),
      findings: z.array(reviewFindingDraftSchema).max(0),
    })
    .strict(),
  z
    .object({
      ...reviewReportDraftFields,
      verdict: z.literal("CHANGES_REQUESTED"),
      findings: z.array(reviewFindingDraftSchema).min(1).max(MAX_REVIEW_FINDINGS_PER_REPORT),
    })
    .strict(),
]);

export const reviewFindingSchema = z
  .object({
    ...reviewFindingDraftFields,
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    correctionRunId: opaqueIdSchema.nullable(),
    reviewArtifactId: opaqueIdSchema,
    reviewedTree: treeShaSchema,
    ordinal: z.number().int().positive().max(MAX_REVIEW_FINDINGS_PER_REPORT),
    status: reviewFindingStatusSchema,
    resolutionReason: descriptionSchema.nullable(),
    resolvedBy: actorSchema.nullable(),
    createdAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine(refineFindingLocation)
  .superRefine((finding, context) => {
    const resolved = finding.status !== "OPEN";
    if (
      resolved !==
      (finding.resolutionReason !== null && finding.resolvedBy !== null && finding.resolvedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A terminal finding requires complete resolution attribution and an open one requires none",
      });
    }
  });

export const reviewReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    correctionRunId: opaqueIdSchema.nullable(),
    authorAgentRunId: opaqueIdSchema,
    reviewerAgentRunId: opaqueIdSchema,
    providerRelation: reviewProviderRelationSchema,
    reviewedTree: treeShaSchema,
    round: z.number().int().positive().max(MAX_TOTAL_REVIEW_ROUNDS),
    title: titleSchema,
    summary: descriptionSchema,
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    verdict: reviewVerdictSchema,
    findingIds: z.array(opaqueIdSchema).max(MAX_REVIEW_FINDINGS_PER_REPORT),
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.authorAgentRunId === report.reviewerAgentRunId) {
      context.addIssue({ code: "custom", message: "A reviewer AgentRun cannot be the author AgentRun" });
    }
    if (report.verdict === "PASSED" && report.findingIds.length !== 0) {
      context.addIssue({ code: "custom", message: "A passed review cannot reference findings" });
    }
    if (report.verdict === "CHANGES_REQUESTED" && report.findingIds.length === 0) {
      context.addIssue({ code: "custom", message: "A changes-requested review requires finding IDs" });
    }
    if (new Set(report.findingIds).size !== report.findingIds.length) {
      context.addIssue({ code: "custom", message: "A review report cannot repeat a finding ID" });
    }
  });

export const reviewLoopActionSchema = z.enum(["ADVANCE_TO_QA", "QUEUE_FIX", "WAIT_FOR_OWNER"]);

export const reviewStateResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    reports: z
      .array(
        reviewReportSchema.extend({
          authorProvider: providerIdSchema,
          reviewerProvider: providerIdSchema,
        }),
      )
      .max(MAX_REVIEW_REPORT_HISTORY),
    findings: z.array(reviewFindingSchema).max(MAX_OPEN_REVIEW_FINDINGS),
  })
  .strict();

export const disposeReviewFindingRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    disposition: reviewFindingOwnerDispositionSchema,
    reason: descriptionSchema,
  })
  .strict();

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewFindingSeverity = z.infer<typeof reviewFindingSeveritySchema>;
export type ReviewFindingStatus = z.infer<typeof reviewFindingStatusSchema>;
export type ReviewFindingOwnerDisposition = z.infer<typeof reviewFindingOwnerDispositionSchema>;
export type ReviewProviderRelation = z.infer<typeof reviewProviderRelationSchema>;
export type ReviewFindingDraft = z.infer<typeof reviewFindingDraftSchema>;
export type ReviewReportDraft = z.infer<typeof reviewReportDraftSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
export type ReviewLoopAction = z.infer<typeof reviewLoopActionSchema>;
export type ReviewStateResponse = z.infer<typeof reviewStateResponseSchema>;
export type DisposeReviewFindingRequest = z.infer<typeof disposeReviewFindingRequestSchema>;
