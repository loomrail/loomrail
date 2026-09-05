import type {
  AgentRun,
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  EvidenceArtifact,
  PipelineRun,
  QAEvidenceBundle,
  QARun,
  ResolveAcceptanceCommand,
  StageAttempt,
  VerificationCheck,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationRun,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideAnswerHumanRequest,
  decideApplyProviderOutcome,
  decideCancelPipeline,
  decideResolveAcceptance,
} from "../src/index.js";

const now = "2026-08-24T14:00:00.000Z";
const testedTree = "a".repeat(40);
const contextPack: ApplyProviderOutcomeCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};
const template: ApplyProviderOutcomeCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "REVIEW", ordinal: 0, contextPack },
    { stage: "QA", ordinal: 1, contextPack },
    { stage: "ACCEPTANCE", ordinal: 2, contextPack },
  ],
};
const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Ship M6",
  description: "Synthetic acceptance fixture",
  state: "IN_PROGRESS",
  currentStage: "REVIEW",
  priority: "HIGH",
  risk: "LOW",
  acceptanceCriteria: ["The owner can inspect durable Review and QA evidence."],
  version: 7,
  createdAt: now,
  updatedAt: now,
};
const run: PipelineRun = {
  schemaVersion: 1,
  id: "run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  workflowTemplateId: template.id,
  workflowVersion: template.version,
  status: "RUNNING",
  currentStageAttemptId: "attempt-review",
  version: 6,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};
const stageAttempt = (stage: StageAttempt["stage"], id: string): StageAttempt => ({
  schemaVersion: 1,
  id,
  pipelineRunId: run.id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  correctionRunId: null,
  stage,
  attempt: 1,
  status: "RUNNING",
  version: 2,
  startedAt: now,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
});
const dispatch = (attempt: StageAttempt): WorkflowDispatch => ({
  schemaVersion: 1,
  id: `dispatch-${attempt.stage.toLowerCase()}`,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: attempt.id,
  mode: "START",
  status: "PENDING",
  createdAt: now,
  completedAt: null,
});
const agentRun = (
  id: string,
  stageAttemptId: string,
  role: AgentRun["profile"]["role"],
  status: AgentRun["status"],
): AgentRun => ({
  schemaVersion: 1,
  id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId,
  ordinal: 1,
  squadAssignmentId: "assignment-1",
  profile: { id: `profile-${role.toLowerCase()}`, revision: 1, role },
  provider: role === "CODE_REVIEWER" ? "CLAUDE_CODE" : "CODEX",
  status,
  policySnapshot: null,
  policySnapshotHash: `sha256:${"0".repeat(64)}`,
  startedAt: now,
  finishedAt: status === "RUNNING" ? null : now,
  version: status === "RUNNING" ? 1 : 2,
});
const artifact = (
  kind: EvidenceArtifact["kind"],
  stage: EvidenceArtifact["stage"],
  id: string,
): EvidenceArtifact => ({
  schemaVersion: 1,
  id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: `attempt-${stage.toLowerCase()}`,
  correctionRunId: null,
  stage,
  kind,
  status: "PASSED",
  provider: "MOCK",
  title: `${stage} report`,
  summary: `${stage} checks passed.`,
  checks: ["Synthetic check passed."],
  ...(kind === "REVIEW_REPORT" ? { reviewReportId: "review-report-1", testedTree } : {}),
  ...(kind === "QA_REPORT" ? { qaRunId: "qa-run-1", qaEvidenceBundleId: "qa-evidence-1", testedTree } : {}),
  createdAt: now,
});

const measuredQARun: QARun = {
  schemaVersion: 1,
  id: "qa-run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: "attempt-qa",
  agentRunId: "agent-run-qa",
  driverId: "PLAYWRIGHT",
  testedTree,
  targetOrigin: "http://127.0.0.1:4173",
  plan: {
    schemaVersion: 1,
    revision: 1,
    contentHash: `sha256:${"b".repeat(64)}`,
    targets: [
      { id: "desktop-light-en", viewport: { width: 1_280, height: 800 }, locale: "en-US", theme: "LIGHT" },
    ],
    scenarios: [
      {
        id: "baseline",
        title: "Baseline",
        steps: [{ id: "open", title: "Open", action: { type: "NAVIGATE", path: "/" } }],
        assertions: [{ id: "path", title: "Path", rule: { type: "URL_PATH", path: "/" } }],
      },
    ],
  },
  scope: { type: "FULL" },
  status: "PASSED",
  error: null,
  startedAt: now,
  completedAt: now,
  version: 2,
};

const measuredQAEvidence: QAEvidenceBundle = {
  schemaVersion: 1,
  id: "qa-evidence-1",
  qaRunId: measuredQARun.id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: measuredQARun.stageAttemptId,
  testedTree,
  verdict: "PASSED",
  environment: {
    osFamily: "MACOS",
    runtimeName: "NODE",
    runtimeVersion: "24.19.0",
    browserName: "CHROMIUM",
    browserVersion: "151.0",
  },
  executions: [
    {
      targetId: "desktop-light-en",
      scenarioId: "baseline",
      durationMs: 100,
      steps: [{ id: "open", status: "PASSED", durationMs: 50 }],
      assertions: [{ id: "path", status: "PASSED", details: null }],
    },
  ],
  observations: [],
  attachmentIds: [],
  defectIds: [],
  createdAt: now,
};

const verificationPlan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: workItem.projectId,
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "verification-recipe-unit",
      kind: "UNIT",
      label: "Unit tests",
      required: true,
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "d".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  sourceProposalHash: "e".repeat(64),
  contentHash: "f".repeat(64),
  createdAt: now,
};
const verificationPublication: VerificationPlanPublication = {
  schemaVersion: 1,
  id: "verification-publication-1",
  projectId: workItem.projectId,
  planId: verificationPlan.id,
  targetPath: ".loomrail/verification-plan.json",
  expectedTargetDigest: null,
  contentHash: verificationPlan.contentHash,
  status: "APPLIED",
  attempts: 1,
  lastErrorCode: null,
  version: 2,
  createdAt: now,
  updatedAt: now,
  appliedAt: now,
};
const verificationRun: VerificationRun = {
  schemaVersion: 1,
  id: "verification-run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  workspaceId: "workspace-1",
  planId: verificationPlan.id,
  planRevision: verificationPlan.revision,
  planContentHash: verificationPlan.contentHash,
  implementationTree: testedTree,
  ordinal: 1,
  retryOfRunId: null,
  platform: "darwin",
  status: "PASSED",
  currentCheckId: null,
  terminalReason: "ALL_REQUIRED_PASSED",
  startedAt: now,
  completedAt: now,
  createdAt: now,
  version: 4,
};
const verificationCheck: VerificationCheck = {
  schemaVersion: 1,
  id: "verification-check-unit",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  runId: verificationRun.id,
  recipeId: verificationPlan.recipes[0]?.id ?? "missing-recipe",
  ordinal: 1,
  required: true,
  status: "PASSED",
  startedAt: now,
  completedAt: now,
  durationMs: 100,
  exitCode: 0,
  signal: null,
  errorCode: null,
  output: {
    schemaVersion: 1,
    artifactId: "verification-output-unit",
    sha256: "a".repeat(64),
    capturedBytes: 2,
    stdoutBytes: 2,
    stderrBytes: 0,
    truncated: false,
    available: true,
  },
  version: 3,
};
const currentProjectVerification = {
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  currentPlan: verificationPlan,
  publication: verificationPublication,
  latestRun: verificationRun,
  checks: [verificationCheck],
  currentTree: testedTree,
};

describe("M6 acceptance decisions", () => {
  it("rejects a legacy Review artifact without the structured independent-review report", () => {
    const attempt = stageAttempt("REVIEW", "attempt-review");
    const command: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "complete-review",
      correlationId: "correlation-complete-review",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId: "dispatch-review",
        provider: "CODEX",
        template,
        outcome: { type: "COMPLETED", summary: "Review complete." },
      },
    };
    const context = {
      now,
      workItem,
      run,
      stageAttempt: attempt,
      dispatch: dispatch(attempt),
      budgetPolicy: null,
      existingUsageRecords: [],
      usageRecordIds: [],
      nextStageAttemptId: "attempt-qa",
      nextDispatchId: "dispatch-qa",
      reviewRequired: true,
    };
    expect(() => decideApplyProviderOutcome(command, context)).toThrow(
      expect.objectContaining({ code: "REVIEW_REPORT_REQUIRED" }),
    );

    command.payload.outcome = {
      type: "COMPLETED",
      summary: "Review complete.",
      artifacts: [
        {
          kind: "REVIEW_REPORT",
          title: "Review report",
          summary: "The bounded review passed.",
          checks: ["Contracts and state transitions passed."],
        },
      ],
    };
    expect(() =>
      decideApplyProviderOutcome(command, {
        ...context,
        artifactIds: ["artifact-review"],
      }),
    ).toThrow(expect.objectContaining({ code: "REVIEW_REPORT_REQUIRED" }));
  });

  it("counts review rounds independently from operational StageAttempt retries", () => {
    const attempt = { ...stageAttempt("REVIEW", "attempt-review-4"), attempt: 4 };
    const decision = decideApplyProviderOutcome(
      {
        schemaVersion: 1,
        commandId: "complete-first-review-after-retries",
        correlationId: "correlation-first-review-after-retries",
        actor: { type: "SYSTEM", id: "claude-code-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          resultTree: testedTree,
          dispatchId: "dispatch-review",
          provider: "CLAUDE_CODE",
          template,
          outcome: {
            type: "COMPLETED",
            summary: "The first independent review found one required change.",
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Independent review",
              summary: "One acceptance gap remains.",
              checks: ["Checked the implementation against the acceptance criteria."],
              verdict: "CHANGES_REQUESTED",
              findings: [
                {
                  severity: "CRITICAL",
                  title: "Acceptance behavior is not covered",
                  description: "The integration suite does not prove the required filtered result sets.",
                  path: "server/src/index.test.ts",
                  startLine: 1,
                  endLine: 1,
                  reproduction: "Run the server integration suite.",
                  criterion: "Pending and completed filters return the correct todo sets.",
                  suggestedFix: "Add integration assertions for both filters.",
                },
              ],
            },
          },
        },
      },
      {
        now,
        workItem,
        run: { ...run, currentStageAttemptId: attempt.id },
        stageAttempt: attempt,
        dispatch: { ...dispatch(attempt), id: "dispatch-review" },
        budgetPolicy: null,
        existingUsageRecords: [],
        usageRecordIds: [],
        reviewRequired: true,
        review: {
          authorAgentRun: agentRun("author-1", "attempt-implement-3", "DEVELOPER", "SUCCEEDED"),
          reviewerAgentRun: agentRun("reviewer-1", attempt.id, "CODE_REVIEWER", "RUNNING"),
          currentTree: testedTree,
          round: 1,
          openFindings: [],
          reportId: "review-report-1",
          findingIds: ["review-finding-1"],
          loopOptionIds: ["retry-option", "cancel-option"],
        },
        nextStageAttemptId: "attempt-implement-5",
        nextDispatchId: "dispatch-implement-5",
      },
    );

    expect(decision).toMatchObject({
      reviewReport: { round: 1, verdict: "CHANGES_REQUESTED" },
      nextStageAttempt: { stage: "IMPLEMENT", attempt: 5, status: "QUEUED" },
    });
  });

  it("forbids ordinary provider completion from bypassing owner acceptance", () => {
    const attempt = stageAttempt("ACCEPTANCE", "attempt-acceptance");
    expect(() =>
      decideApplyProviderOutcome(
        {
          schemaVersion: 1,
          commandId: "complete-acceptance-without-owner",
          correlationId: "correlation-complete-acceptance-without-owner",
          actor: { type: "SYSTEM", id: "codex-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            resultTree: null,
            dispatchId: "dispatch-acceptance",
            provider: "CODEX",
            template,
            outcome: { type: "COMPLETED", summary: "The provider says it is done." },
          },
        },
        {
          now,
          workItem: { ...workItem, currentStage: "ACCEPTANCE" },
          run: { ...run, currentStageAttemptId: attempt.id },
          stageAttempt: attempt,
          dispatch: dispatch(attempt),
          budgetPolicy: null,
          existingUsageRecords: [],
          usageRecordIds: [],
        },
      ),
    ).toThrow(expect.objectContaining({ code: "ACCEPTANCE_NOT_READY" }));
  });

  it("rejects structured review data outside the Review stage", () => {
    const attempt = stageAttempt("QA", "attempt-qa-review-payload");
    expect(() =>
      decideApplyProviderOutcome(
        {
          schemaVersion: 1,
          commandId: "review-payload-on-acceptance",
          correlationId: "correlation-review-payload-on-acceptance",
          actor: { type: "SYSTEM", id: "codex-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            resultTree: null,
            dispatchId: "dispatch-qa",
            provider: "CODEX",
            template,
            outcome: {
              type: "COMPLETED",
              summary: "Review-shaped payload on the wrong stage.",
              reviewReport: {
                kind: "REVIEW_REPORT",
                title: "Wrong-stage report",
                summary: "This report must be rejected.",
                checks: ["Checked the stage boundary."],
                verdict: "PASSED",
                findings: [],
              },
            },
          },
        },
        {
          now,
          workItem: { ...workItem, currentStage: "QA" },
          run: { ...run, currentStageAttemptId: attempt.id },
          stageAttempt: attempt,
          dispatch: dispatch(attempt),
          budgetPolicy: null,
          existingUsageRecords: [],
          usageRecordIds: [],
        },
      ),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_STAGE_MISMATCH" }));
  });

  it("creates a blocking package and only human acceptance can finish the WorkItem", () => {
    const attempt = stageAttempt("ACCEPTANCE", "attempt-acceptance");
    const acceptanceRun: PipelineRun = {
      ...run,
      currentStageAttemptId: attempt.id,
      version: 9,
    };
    const acceptanceWorkItem: WorkItem = {
      ...workItem,
      currentStage: "ACCEPTANCE",
      version: 10,
    };
    const ready = decideApplyProviderOutcome(
      {
        schemaVersion: 1,
        commandId: "request-acceptance",
        correlationId: "correlation-request-acceptance",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          resultTree: null,
          dispatchId: "dispatch-acceptance",
          template,
          outcome: {
            type: "READY_FOR_ACCEPTANCE",
            releaseNote: "Review and QA evidence are ready.",
            verifyInstructions: ["Run pnpm verify."],
            criteria: [
              {
                criterion: workItem.acceptanceCriteria[0] ?? "missing criterion",
                implementation: "The owner-facing evidence flow was implemented.",
                reviewCheck: "Synthetic check passed.",
                qaCheck: "Synthetic check passed.",
                ownerVerification: "Run pnpm verify.",
                knownRisk: null,
              },
            ],
          },
        },
      },
      {
        now,
        workItem: acceptanceWorkItem,
        run: acceptanceRun,
        stageAttempt: attempt,
        dispatch: dispatch(attempt),
        budgetPolicy: null,
        existingUsageRecords: [],
        usageRecordIds: [],
        existingArtifacts: [
          artifact("REVIEW_REPORT", "REVIEW", "artifact-review"),
          artifact("QA_REPORT", "QA", "artifact-qa"),
        ],
        measuredQA: { qaRun: measuredQARun, evidence: measuredQAEvidence, currentTree: testedTree },
        projectVerification: currentProjectVerification,
        humanRequestId: "request-acceptance",
        acceptancePackageId: "package-1",
      },
    );
    expect(ready).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      workItem: { state: "BLOCKED" },
      request: { blocking: true, status: "OPEN" },
      acceptancePackage: { status: "PENDING", artifactIds: ["artifact-review", "artifact-qa"] },
    });
    expect(ready.acceptancePackage).toMatchObject({
      verificationEvidence: {
        verificationRunId: verificationRun.id,
        requiredCheckIds: [verificationCheck.id],
      },
      criteria: [{ verificationCheckIds: [verificationCheck.id] }],
    });
    const acceptancePackage = ready.acceptancePackage;
    const request = ready.request;
    if (!acceptancePackage || !request) throw new Error("Expected a pending acceptance decision");
    const resolveCommand = (
      actorType: "HUMAN" | "SYSTEM",
      action: ResolveAcceptanceCommand["payload"]["action"] = "ACCEPT",
    ): ResolveAcceptanceCommand => ({
      schemaVersion: 1,
      commandId: `${action.toLowerCase()}-${actorType.toLowerCase()}`,
      correlationId: `correlation-${action.toLowerCase()}-${actorType.toLowerCase()}`,
      actor: { type: actorType, id: actorType === "HUMAN" ? "local-owner" : "automation" },
      type: "RESOLVE_ACCEPTANCE",
      payload: {
        acceptancePackageId: acceptancePackage.id,
        expectedVersion: acceptancePackage.version,
        expectedRunVersion: ready.run.version,
        action,
        reason: "Evidence accepted.",
      },
    });
    const context = {
      now,
      workItem: ready.workItem,
      run: ready.run,
      stageAttempt: ready.stageAttempt,
      acceptancePackage,
      request,
      decisionId: "decision-acceptance",
    };
    const genericAnswer: AnswerHumanRequestCommand = {
      schemaVersion: 1,
      commandId: "answer-acceptance-as-generic-request",
      correlationId: "correlation-answer-acceptance-as-generic-request",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: request.version,
        answer: { type: "OPTION", optionIds: ["accept"] },
      },
    };
    expect(() =>
      decideAnswerHumanRequest(genericAnswer, {
        now,
        workItem: ready.workItem,
        run: ready.run,
        stageAttempt: ready.stageAttempt,
        request,
        decisionId: "decision-generic-acceptance",
        dispatchId: "dispatch-generic-acceptance",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
    expect(() =>
      decideCancelPipeline(
        {
          schemaVersion: 1,
          commandId: "cancel-pending-acceptance",
          correlationId: "correlation-cancel-pending-acceptance",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CANCEL_PIPELINE",
          payload: { pipelineRunId: ready.run.id, expectedVersion: ready.run.version },
        },
        {
          now,
          workItem: ready.workItem,
          run: ready.run,
          stageAttempt: ready.stageAttempt,
          pendingDispatch: null,
          acceptancePending: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
    expect(() => decideResolveAcceptance(resolveCommand("SYSTEM"), context)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }),
    );
    for (const [action, status] of [
      ["RETURN_TO_WORK", "RETURNED"],
      ["REJECT", "REJECTED"],
    ] as const) {
      const closed = decideResolveAcceptance(resolveCommand("HUMAN", action), {
        ...context,
        decisionId: `decision-${action.toLowerCase()}`,
      });
      expect(closed).toMatchObject({
        workItem: { state: "BLOCKED" },
        run: { status: "FAILED" },
        stageAttempt: { status: "FAILED" },
        acceptancePackage: { status },
      });
      expect(closed.events.map(({ type }) => type).includes("PIPELINE_COMPLETED")).toBe(false);
    }
    const accepted = decideResolveAcceptance(resolveCommand("HUMAN"), context);
    expect(accepted).toMatchObject({
      workItem: { state: "DONE" },
      run: { status: "SUCCEEDED" },
      stageAttempt: { status: "SUCCEEDED" },
      acceptancePackage: { status: "ACCEPTED", version: 2 },
      request: { status: "RESOLVED" },
    });
    expect(accepted.events.map(({ type }) => type)).toEqual([
      "HUMAN_REQUEST_RESOLVED",
      "ACCEPTANCE_RESOLVED",
      "PIPELINE_COMPLETED",
    ]);
  });

  it("blocks a configured Project when the current verification Run failed", () => {
    const attempt = stageAttempt("ACCEPTANCE", "attempt-acceptance-failed-verification");
    expect(() =>
      decideApplyProviderOutcome(
        {
          schemaVersion: 1,
          commandId: "request-acceptance-failed-verification",
          correlationId: "correlation-request-acceptance-failed-verification",
          actor: { type: "SYSTEM", id: "mock-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            resultTree: null,
            dispatchId: "dispatch-acceptance",
            template,
            outcome: {
              type: "READY_FOR_ACCEPTANCE",
              releaseNote: "Should remain blocked.",
              verifyInstructions: ["Fix the required Project check."],
              criteria: [
                {
                  criterion: workItem.acceptanceCriteria[0] ?? "missing criterion",
                  implementation: "The implementation is not yet verified.",
                  reviewCheck: "Synthetic check passed.",
                  qaCheck: "Synthetic check passed.",
                  ownerVerification: "Wait for a fresh passing Project check.",
                  knownRisk: null,
                },
              ],
            },
          },
        },
        {
          now,
          workItem: { ...workItem, currentStage: "ACCEPTANCE" },
          run: { ...run, currentStageAttemptId: attempt.id },
          stageAttempt: attempt,
          dispatch: dispatch(attempt),
          budgetPolicy: null,
          existingUsageRecords: [],
          usageRecordIds: [],
          existingArtifacts: [
            artifact("REVIEW_REPORT", "REVIEW", "artifact-review"),
            artifact("QA_REPORT", "QA", "artifact-qa"),
          ],
          measuredQA: { qaRun: measuredQARun, evidence: measuredQAEvidence, currentTree: testedTree },
          projectVerification: {
            ...currentProjectVerification,
            latestRun: {
              ...verificationRun,
              status: "FAILED",
              terminalReason: "REQUIRED_CHECK_FAILED",
            },
            checks: [{ ...verificationCheck, status: "FAILED", exitCode: 1 }],
          },
          humanRequestId: "request-acceptance-failed-verification",
          acceptancePackageId: "package-failed-verification",
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PROJECT_VERIFICATION_REQUIRED" }));
  });
});
