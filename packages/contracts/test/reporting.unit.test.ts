import {
  anonymousAggregateReportSchema,
  anonymousCrashReportSchema,
  reportingFactsSchema,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

const zeroFacts = {
  workItems: { total: 0, accepted: 0, cancelled: 0, active: 0 },
  pipelineRuns: { total: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0 },
  agentRuns: { total: 0, succeeded: 0, failed: 0, interrupted: 0 },
  reviews: { total: 0, firstRound: 0, firstRoundPassed: 0 },
  qa: {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    defectsOpen: 0,
    defectsResolved: 0,
    defectsWaived: 0,
  },
  humanRequests: { total: 0, resolved: 0 },
  usage: { estimatedTokens: 0 },
  reliability: { daemonRestartRecoveries: 0 },
} as const;

const runtime = {
  productVersion: "0.1.0-alpha.5",
  operatingSystem: "MACOS",
  architecture: "ARM64",
  nodeMajor: 24,
} as const;

describe("privacy reporting contracts", () => {
  it("accepts bounded aggregate facts and rejects impossible subsets", () => {
    expect(reportingFactsSchema.parse(zeroFacts)).toEqual(zeroFacts);
    expect(() =>
      reportingFactsSchema.parse({
        ...zeroFacts,
        workItems: { ...zeroFacts.workItems, accepted: 1 },
      }),
    ).toThrow();
  });

  it("rejects identifiers, timestamps and free text at the public aggregate seam", () => {
    const report = {
      schemaVersion: 1,
      kind: "AGGREGATE",
      runtime,
      metrics: {
        ...zeroFacts,
        rates: { acceptedCompletionPercent: null, firstPassReviewPercent: null, terminalQaPassPercent: null },
      },
    } as const;

    expect(anonymousAggregateReportSchema.parse(report)).toEqual(report);
    expect(
      anonymousAggregateReportSchema.safeParse({
        ...report,
        metrics: {
          ...report.metrics,
          workItems: { ...report.metrics.workItems, accepted: 1 },
        },
      }).success,
    ).toBe(false);
    for (const extra of [
      { projectId: "project-private" },
      { repositoryPath: "/private/repository" },
      { generatedAt: "2026-09-03T12:00:00.000Z" },
      { message: "provider output" },
    ]) {
      expect(anonymousAggregateReportSchema.safeParse({ ...report, ...extra }).success).toBe(false);
    }
    expect(
      anonymousAggregateReportSchema.safeParse({
        ...report,
        metrics: { ...report.metrics, repositoryPath: "/private/repository" },
      }).success,
    ).toBe(false);
  });

  it("keeps crash payloads on a closed recovery vocabulary", () => {
    const report = {
      schemaVersion: 1,
      kind: "CRASH",
      runtime,
      incident: {
        reason: "DAEMON_RESTART",
        recoveredStatus: "INTERRUPTED",
        affectedWorkflowCount: 2,
      },
    } as const;
    expect(anonymousCrashReportSchema.parse(report)).toEqual(report);
    expect(
      anonymousCrashReportSchema.safeParse({
        ...report,
        incident: { ...report.incident, stack: "/private/repository/index.ts:1" },
      }).success,
    ).toBe(false);
  });
});
