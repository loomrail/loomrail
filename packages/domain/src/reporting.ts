import {
  insightsResponseSchema,
  reportingFactsSchema,
  reportingRuntimeSchema,
  type InsightsResponse,
  type ReportingFacts,
  type ReportingRuntime,
} from "@loomrail/contracts";

const percentage = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 100);

export const buildReportingSnapshot = (input: {
  facts: ReportingFacts;
  runtime: ReportingRuntime;
}): InsightsResponse => {
  const facts = reportingFactsSchema.parse(input.facts);
  const runtime = reportingRuntimeSchema.parse(input.runtime);
  const terminalWorkItems = facts.workItems.accepted + facts.workItems.cancelled;
  const terminalQaRuns = facts.qa.passed + facts.qa.failed + facts.qa.errored;
  const localMetrics = {
    ...facts,
    rates: {
      acceptedCompletionPercent: percentage(facts.workItems.accepted, terminalWorkItems),
      firstPassReviewPercent: percentage(facts.reviews.firstRoundPassed, facts.reviews.firstRound),
      terminalQaPassPercent: percentage(facts.qa.passed, terminalQaRuns),
    },
  };

  return insightsResponseSchema.parse({
    schemaVersion: 1,
    localMetrics,
    aggregateReport: { schemaVersion: 1, kind: "AGGREGATE", runtime, metrics: localMetrics },
    crashReport:
      facts.reliability.daemonRestartRecoveries === 0
        ? null
        : {
            schemaVersion: 1,
            kind: "CRASH",
            runtime,
            incident: {
              reason: "DAEMON_RESTART",
              recoveredStatus: "INTERRUPTED",
              affectedWorkflowCount: facts.reliability.daemonRestartRecoveries,
            },
          },
  });
};
