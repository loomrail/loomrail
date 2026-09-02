import { buildReportingSnapshot } from "@loomrail/domain";
import { describe, expect, it } from "vitest";

const runtime = {
  productVersion: "0.1.0-alpha.5",
  operatingSystem: "WINDOWS",
  architecture: "X64",
  nodeMajor: 24,
} as const;

const facts = {
  workItems: { total: 9, accepted: 3, cancelled: 1, active: 4 },
  pipelineRuns: { total: 8, succeeded: 3, failed: 1, interrupted: 1, cancelled: 1 },
  agentRuns: { total: 20, succeeded: 15, failed: 2, interrupted: 1 },
  reviews: { total: 7, firstRound: 5, firstRoundPassed: 3 },
  qa: {
    total: 7,
    passed: 4,
    failed: 2,
    errored: 1,
    defectsOpen: 2,
    defectsResolved: 5,
    defectsWaived: 1,
  },
  humanRequests: { total: 6, resolved: 4 },
  usage: { estimatedTokens: 123_456 },
  reliability: { daemonRestartRecoveries: 2 },
} as const;

describe("reporting snapshot", () => {
  it("derives local rates and closed public reports from numeric facts", () => {
    const snapshot = buildReportingSnapshot({ facts, runtime });
    expect(snapshot.localMetrics.rates).toEqual({
      acceptedCompletionPercent: 75,
      firstPassReviewPercent: 60,
      terminalQaPassPercent: 57,
    });
    expect(snapshot.aggregateReport).toEqual({
      schemaVersion: 1,
      kind: "AGGREGATE",
      runtime,
      metrics: snapshot.localMetrics,
    });
    expect(snapshot.crashReport).toEqual({
      schemaVersion: 1,
      kind: "CRASH",
      runtime,
      incident: {
        reason: "DAEMON_RESTART",
        recoveredStatus: "INTERRUPTED",
        affectedWorkflowCount: 2,
      },
    });
  });

  it("uses null for rates without evidence and omits an invented crash", () => {
    const zero = buildReportingSnapshot({
      runtime,
      facts: {
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
      },
    });
    expect(zero.localMetrics.rates).toEqual({
      acceptedCompletionPercent: null,
      firstPassReviewPercent: null,
      terminalQaPassPercent: null,
    });
    expect(zero.crashReport).toBeNull();
  });
});
