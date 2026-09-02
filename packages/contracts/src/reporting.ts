import { z } from "zod";

import { schemaVersionSchema } from "./shared.js";

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percentageSchema = z.number().int().min(0).max(100).nullable();

export const reportingRuntimeSchema = z
  .object({
    productVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    operatingSystem: z.enum(["MACOS", "WINDOWS", "LINUX", "OTHER"]),
    architecture: z.enum(["X64", "ARM64", "OTHER"]),
    nodeMajor: z.number().int().positive().max(999),
  })
  .strict();

export const reportingFactsSchema = z
  .object({
    workItems: z
      .object({ total: countSchema, accepted: countSchema, cancelled: countSchema, active: countSchema })
      .strict(),
    pipelineRuns: z
      .object({
        total: countSchema,
        succeeded: countSchema,
        failed: countSchema,
        interrupted: countSchema,
        cancelled: countSchema,
      })
      .strict(),
    agentRuns: z
      .object({ total: countSchema, succeeded: countSchema, failed: countSchema, interrupted: countSchema })
      .strict(),
    reviews: z
      .object({ total: countSchema, firstRound: countSchema, firstRoundPassed: countSchema })
      .strict(),
    qa: z
      .object({
        total: countSchema,
        passed: countSchema,
        failed: countSchema,
        errored: countSchema,
        defectsOpen: countSchema,
        defectsResolved: countSchema,
        defectsWaived: countSchema,
      })
      .strict(),
    humanRequests: z.object({ total: countSchema, resolved: countSchema }).strict(),
    usage: z.object({ estimatedTokens: countSchema }).strict(),
    reliability: z.object({ daemonRestartRecoveries: countSchema }).strict(),
  })
  .strict()
  .superRefine((facts, context) => {
    const subset = (value: number, total: number, path: (string | number)[]): void => {
      if (value > total) context.addIssue({ code: "custom", message: "Count exceeds its total", path });
    };
    for (const key of ["accepted", "cancelled", "active"] as const) {
      subset(facts.workItems[key], facts.workItems.total, ["workItems", key]);
    }
    for (const key of ["succeeded", "failed", "interrupted", "cancelled"] as const) {
      subset(facts.pipelineRuns[key], facts.pipelineRuns.total, ["pipelineRuns", key]);
    }
    for (const key of ["succeeded", "failed", "interrupted"] as const) {
      subset(facts.agentRuns[key], facts.agentRuns.total, ["agentRuns", key]);
    }
    subset(facts.reviews.firstRound, facts.reviews.total, ["reviews", "firstRound"]);
    subset(facts.reviews.firstRoundPassed, facts.reviews.firstRound, ["reviews", "firstRoundPassed"]);
    for (const key of ["passed", "failed", "errored"] as const) {
      subset(facts.qa[key], facts.qa.total, ["qa", key]);
    }
    subset(facts.humanRequests.resolved, facts.humanRequests.total, ["humanRequests", "resolved"]);
  });

export const localProductMetricsSchema = reportingFactsSchema.extend({
  rates: z
    .object({
      acceptedCompletionPercent: percentageSchema,
      firstPassReviewPercent: percentageSchema,
      terminalQaPassPercent: percentageSchema,
    })
    .strict(),
});

export const anonymousAggregateReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("AGGREGATE"),
    runtime: reportingRuntimeSchema,
    metrics: localProductMetricsSchema,
  })
  .strict();

export const anonymousCrashReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("CRASH"),
    runtime: reportingRuntimeSchema,
    incident: z
      .object({
        reason: z.literal("DAEMON_RESTART"),
        recoveredStatus: z.literal("INTERRUPTED"),
        affectedWorkflowCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

export const anonymousReportSchema = z.discriminatedUnion("kind", [
  anonymousAggregateReportSchema,
  anonymousCrashReportSchema,
]);

export const insightsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    localMetrics: localProductMetricsSchema,
    aggregateReport: anonymousAggregateReportSchema,
    crashReport: anonymousCrashReportSchema.nullable(),
  })
  .strict();

export type ReportingRuntime = z.infer<typeof reportingRuntimeSchema>;
export type ReportingFacts = z.infer<typeof reportingFactsSchema>;
export type LocalProductMetrics = z.infer<typeof localProductMetricsSchema>;
export type AnonymousAggregateReport = z.infer<typeof anonymousAggregateReportSchema>;
export type AnonymousCrashReport = z.infer<typeof anonymousCrashReportSchema>;
export type AnonymousReport = z.infer<typeof anonymousReportSchema>;
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;
