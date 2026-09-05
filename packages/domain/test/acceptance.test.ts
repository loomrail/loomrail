import {
  acceptancePackageSchema,
  providerOutcomeSchema,
  type AcceptancePackage,
  type AcceptanceCriterionClaim,
  type Decision,
  type DomainEvent,
  type EvidenceArtifact,
  type QAAttachmentSummary,
  type QAEvidenceBundle,
  type VerificationEvidence,
  type WorkItem,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  bindAcceptanceCriteria,
  renderReleaseSummary,
  type BindAcceptanceCriteriaResult,
  type RenderReleaseSummaryInput,
} from "../src/index.js";

const now = "2026-09-02T16:00:00.000Z";
const testedTree = "a".repeat(40);
const verificationEvidence: VerificationEvidence = {
  schemaVersion: 1,
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "run-1",
  verificationRunId: "verification-run-1",
  planId: "verification-plan-1",
  planRevision: 2,
  planContentHash: "c".repeat(64),
  implementationTree: testedTree,
  platform: "darwin",
  requiredCheckIds: ["verification-check-unit"],
  optionalFailedCheckIds: ["verification-check-lint"],
  completedAt: now,
};

const artifact = (
  kind: EvidenceArtifact["kind"],
  id: string,
  checks: readonly string[],
): EvidenceArtifact => ({
  schemaVersion: 1,
  id,
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "run-1",
  stageAttemptId: kind === "REVIEW_REPORT" ? "review-1" : "qa-1",
  correctionRunId: null,
  stage: kind === "REVIEW_REPORT" ? "REVIEW" : "QA",
  kind,
  status: "PASSED",
  provider: "CODEX",
  title: kind === "REVIEW_REPORT" ? "Independent review" : "Measured QA",
  summary: "The current implementation tree passed.",
  checks: [...checks],
  testedTree,
  ...(kind === "REVIEW_REPORT"
    ? { reviewReportId: "review-report-1" }
    : { qaRunId: "qa-run-1", qaEvidenceBundleId: "qa-evidence-1" }),
  createdAt: now,
});

const reviewArtifact = artifact("REVIEW_REPORT", "review-artifact-1", [
  "Criterion A reviewed",
  "Criterion B reviewed",
]);
const qaArtifact = artifact("QA_REPORT", "qa-artifact-1", ["Criterion A measured", "Criterion B measured"]);
const claimA: AcceptanceCriterionClaim = {
  criterion: "Criterion A",
  implementation: "Implemented A.",
  reviewCheck: "Criterion A reviewed",
  qaCheck: "Criterion A measured",
  ownerVerification: "Inspect A.",
  knownRisk: null,
};
const claimB: AcceptanceCriterionClaim = {
  criterion: "Criterion B",
  implementation: "Implemented B.",
  reviewCheck: "Criterion B reviewed",
  qaCheck: "Criterion B measured",
  ownerVerification: "Inspect B.",
  knownRisk: "B still depends on the fixture browser.",
};
const claims: readonly AcceptanceCriterionClaim[] = [claimA, claimB];

const expectInvalidBinding = (result: BindAcceptanceCriteriaResult, reason: string): void => {
  expect(result.type).toBe("INVALID");
  if (result.type !== "INVALID") throw new Error("Expected invalid criterion binding");
  expect(result.reason).toContain(reason);
};

const releaseInput = (): RenderReleaseSummaryInput => {
  const workItem: WorkItem = {
    schemaVersion: 1,
    id: "work-item-1",
    projectId: "project-1",
    parentId: null,
    type: "TASK",
    title: "Ship <safe> summary",
    description: "",
    state: "BLOCKED",
    currentStage: "ACCEPTANCE",
    priority: "HIGH",
    risk: "MEDIUM",
    acceptanceCriteria: ["Criterion A", "Criterion B"],
    version: 7,
    createdAt: now,
    updatedAt: now,
  };
  const acceptancePackage: AcceptancePackage = {
    schemaVersion: 1,
    id: "package-1",
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: "run-1",
    stageAttemptId: "acceptance-1",
    humanRequestId: "request-1",
    status: "PENDING",
    criteria: [
      {
        criterion: claimA.criterion,
        implementation: "Implemented A at /opt/private/repo.",
        reviewArtifactId: reviewArtifact.id,
        qaArtifactId: qaArtifact.id,
        reviewCheck: claimA.reviewCheck,
        qaCheck: claimA.qaCheck,
        verificationCheckIds: verificationEvidence.requiredCheckIds,
        verification: "Inspect <script>alert(1)</script> A.",
        knownRisk: null,
      },
      {
        criterion: claimB.criterion,
        implementation: claimB.implementation,
        reviewArtifactId: reviewArtifact.id,
        qaArtifactId: qaArtifact.id,
        reviewCheck: claimB.reviewCheck,
        qaCheck: claimB.qaCheck,
        verificationCheckIds: verificationEvidence.requiredCheckIds,
        verification: claimB.ownerVerification,
        knownRisk: claimB.knownRisk,
      },
    ],
    verificationEvidence,
    artifactIds: [reviewArtifact.id, qaArtifact.id],
    releaseNote: "Ready on C:\\private\\repo. <b>Owner review</b>.",
    verifyInstructions: ["Open the matrix.", "Inspect browser evidence."],
    version: 1,
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
  };
  const qaEvidence: QAEvidenceBundle = {
    schemaVersion: 1,
    id: "qa-evidence-1",
    qaRunId: "qa-run-1",
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: acceptancePackage.pipelineRunId,
    stageAttemptId: qaArtifact.stageAttemptId,
    testedTree,
    verdict: "PASSED",
    environment: {
      osFamily: "MACOS",
      runtimeName: "NODE",
      runtimeVersion: "24.19.0",
      browserName: "CHROMIUM",
      browserVersion: "140.0",
    },
    executions: [
      {
        targetId: "web",
        scenarioId: "acceptance",
        durationMs: 42,
        steps: [{ id: "open", status: "PASSED", durationMs: 20 }],
        assertions: [{ id: "visible", status: "PASSED", details: "Visible <main>." }],
      },
    ],
    observations: [],
    attachmentIds: ["attachment-1"],
    defectIds: [],
    createdAt: now,
  };
  const attachment: QAAttachmentSummary = {
    schemaVersion: 1,
    id: "attachment-1",
    qaRunId: qaEvidence.qaRunId,
    kind: "SCREENSHOT",
    contentHash: `sha256:${"b".repeat(64)}`,
    byteSize: 1_024,
    targetId: "web",
    scenarioId: "acceptance",
    capturedAt: now,
    retentionClass: "STANDARD_30_DAYS",
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: "decision-1",
    projectId: workItem.projectId,
    workItemId: workItem.id,
    humanRequestId: "request-earlier",
    answer: { type: "OTHER", text: "Proceed after <review>." },
    actor: { type: "HUMAN", id: "local-owner" },
    reason: null,
    createdAt: now,
  };
  const event: DomainEvent = {
    schemaVersion: 1,
    sequence: 1,
    id: "event-1",
    aggregateType: "WORK_ITEM",
    aggregateId: workItem.id,
    projectId: workItem.projectId,
    actor: { type: "HUMAN", id: "local-owner" },
    occurredAt: now,
    correlationId: "correlation-1",
    type: "WORK_ITEM_CREATED",
    data: { workItem: { ...workItem, state: "BACKLOG", currentStage: null, version: 1 } },
  };
  return {
    workItem,
    acceptancePackage,
    artifacts: [qaArtifact, reviewArtifact],
    qaEvidence: [qaEvidence],
    qaAttachments: [attachment],
    decisions: [decision],
    events: [event],
    auditComplete: true,
  };
};

const criterionEvidenceAt = (
  input: RenderReleaseSummaryInput,
  index: number,
): AcceptancePackage["criteria"][number] => {
  const criterion = input.acceptancePackage.criteria[index];
  if (criterion === undefined) throw new Error(`Missing test criterion ${index.toString()}`);
  return criterion;
};

describe("criterion-bound acceptance", () => {
  it("binds a complete ordered claim set to domain-owned artifact IDs", () => {
    expect(
      bindAcceptanceCriteria({
        acceptanceCriteria: ["Criterion A", "Criterion B"],
        claims,
        reviewArtifact,
        qaArtifact,
      }),
    ).toEqual({
      type: "BOUND",
      criteria: [
        {
          criterion: "Criterion A",
          implementation: "Implemented A.",
          reviewArtifactId: reviewArtifact.id,
          qaArtifactId: qaArtifact.id,
          reviewCheck: "Criterion A reviewed",
          qaCheck: "Criterion A measured",
          verification: "Inspect A.",
          knownRisk: null,
        },
        {
          criterion: "Criterion B",
          implementation: "Implemented B.",
          reviewArtifactId: reviewArtifact.id,
          qaArtifactId: qaArtifact.id,
          reviewCheck: "Criterion B reviewed",
          qaCheck: "Criterion B measured",
          verification: "Inspect B.",
          knownRisk: "B still depends on the fixture browser.",
        },
      ],
    });
  });

  it("binds current Project verification evidence without provider-selected durable IDs", () => {
    const result = bindAcceptanceCriteria({
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      claims,
      reviewArtifact,
      qaArtifact,
      verificationEvidence,
    });
    expect(result.type).toBe("BOUND");
    if (result.type !== "BOUND") throw new Error("Expected bound Project verification evidence");
    expect(
      result.criteria.map(({ criterion, verificationCheckIds }) => ({ criterion, verificationCheckIds })),
    ).toEqual([
      { criterion: "Criterion A", verificationCheckIds: ["verification-check-unit"] },
      { criterion: "Criterion B", verificationCheckIds: ["verification-check-unit"] },
    ]);
  });

  it.each([
    {
      label: "has no recorded criteria",
      criteria: [],
      proposed: claims,
      reason: "at least one acceptance criterion",
    },
    {
      label: "omits a claim",
      criteria: ["Criterion A", "Criterion B"],
      proposed: claims.slice(0, 1),
      reason: "cover every criterion exactly once",
    },
    {
      label: "reorders claims",
      criteria: ["Criterion A", "Criterion B"],
      proposed: [claimB, claimA],
      reason: "preserve the recorded criterion order and text",
    },
    {
      label: "repeats a criterion",
      criteria: ["Criterion A", "Criterion B"],
      proposed: [claimA, { ...claimB, criterion: "Criterion A" }],
      reason: "must not repeat a criterion",
    },
  ])("fails closed when the mapping $label", ({ criteria, proposed, reason }) => {
    expectInvalidBinding(
      bindAcceptanceCriteria({
        acceptanceCriteria: criteria,
        claims: proposed,
        reviewArtifact,
        qaArtifact,
      }),
      reason,
    );
  });

  it("rejects checks that are not present in the current evidence", () => {
    const wrongReview = [{ ...claimA, reviewCheck: "Old review check" }, claimB];
    const wrongQA = [claimA, { ...claimB, qaCheck: "Old QA check" }];
    expectInvalidBinding(
      bindAcceptanceCriteria({
        acceptanceCriteria: ["Criterion A", "Criterion B"],
        claims: wrongReview,
        reviewArtifact,
        qaArtifact,
      }),
      "Review",
    );
    expectInvalidBinding(
      bindAcceptanceCriteria({
        acceptanceCriteria: ["Criterion A", "Criterion B"],
        claims: wrongQA,
        reviewArtifact,
        qaArtifact,
      }),
      "QA",
    );
  });

  it("reads a pre-Q3 package but rejects a partially bound criterion row", () => {
    const legacy = {
      schemaVersion: 1,
      id: "package-legacy",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "run-1",
      stageAttemptId: "acceptance-1",
      humanRequestId: "request-1",
      status: "PENDING",
      criteria: [
        {
          criterion: "Criterion A",
          implementation: "Implemented A.",
          reviewArtifactId: reviewArtifact.id,
          qaArtifactId: qaArtifact.id,
          verification: "Inspect A.",
          knownRisk: null,
        },
      ],
      artifactIds: [reviewArtifact.id, qaArtifact.id],
      releaseNote: "Legacy package.",
      verifyInstructions: ["Inspect A."],
      version: 1,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    };
    expect(acceptancePackageSchema.safeParse(legacy).success).toBe(true);
    expect(
      acceptancePackageSchema.safeParse({
        ...legacy,
        criteria: [{ ...legacy.criteria[0], reviewCheck: "Criterion A reviewed" }],
      }).success,
    ).toBe(false);
  });

  it("keeps pre-Q3 READY_FOR_ACCEPTANCE command payloads readable", () => {
    expect(
      providerOutcomeSchema.safeParse({
        type: "READY_FOR_ACCEPTANCE",
        releaseNote: "Historical package.",
        verifyInstructions: ["Inspect it."],
      }).success,
    ).toBe(true);
  });
});

describe("release summary", () => {
  it("renders stable escaped UTF-8 bytes without path or storage authority", () => {
    const input = releaseInput();
    const first = renderReleaseSummary(input);
    const second = renderReleaseSummary({
      ...input,
      artifacts: [...input.artifacts].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.type).toBe("RENDERED");
    if (first.type !== "RENDERED") throw new Error("Expected a rendered release summary");
    expect(first.byteSize).toBe(Buffer.byteLength(first.markdown, "utf8"));
    expect(first.markdown).toContain("Evidence binding: `BOUND`");
    expect(first.markdown).toContain("Project verification Run: `verification-run-1`");
    expect(first.markdown).toContain("Selected Project checks: `verification-check-unit`");
    expect(first.markdown).toContain("Optional checks not passed: 1");
    expect(first.markdown).not.toContain("verification-check-lint");
    expect(first.markdown).toContain("Assertion `visible`: `PASSED`");
    expect(first.markdown).toContain("&lt;script&gt;alert\\(1\\)&lt;/script&gt;");
    expect(first.markdown).not.toContain("<script>");
    expect(first.markdown).not.toContain("/opt/private");
    expect(first.markdown).not.toContain("C:\\private");
    expect(first.markdown).not.toContain("storageKey");
  });

  it("marks a fully legacy package without pretending its checks are bound", () => {
    const input = releaseInput();
    const legacy: AcceptancePackage = {
      ...input.acceptancePackage,
      criteria: input.acceptancePackage.criteria.map(({ reviewCheck: _review, qaCheck: _qa, ...row }) => row),
    };
    const rendered = renderReleaseSummary({ ...input, acceptancePackage: legacy });
    expect(rendered.type).toBe("RENDERED");
    if (rendered.type !== "RENDERED") throw new Error("Expected a rendered legacy release summary");
    expect(rendered.markdown).toContain("Evidence binding: `LEGACY_UNBOUND`");
    expect(rendered.markdown).not.toContain("Selected Review check:");
  });

  it.each([
    {
      label: "has incomplete audit input",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        auditComplete: false,
      }),
      type: "AUDIT_INCOMPLETE",
    },
    {
      label: "does not exactly cover current criteria",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        workItem: { ...input.workItem, acceptanceCriteria: ["Criterion A"] },
      }),
      type: "INVALID",
    },
    {
      label: "selects stale checks",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        acceptancePackage: {
          ...input.acceptancePackage,
          criteria: [
            { ...criterionEvidenceAt(input, 0), qaCheck: "Stale QA check" },
            criterionEvidenceAt(input, 1),
          ],
        },
      }),
      type: "INVALID",
    },
    {
      label: "crosses an artifact authority boundary",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        artifacts: input.artifacts.map((value) =>
          value.id === qaArtifact.id ? { ...value, projectId: "project-other" } : value,
        ),
      }),
      type: "INVALID",
    },
    {
      label: "mixes legacy and bound rows",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        acceptancePackage: {
          ...input.acceptancePackage,
          criteria: input.acceptancePackage.criteria.map((row, index) =>
            index === 0 ? (({ reviewCheck: _review, qaCheck: _qa, ...legacy }) => legacy)(row) : row,
          ),
        },
      }),
      type: "INVALID",
    },
    {
      label: "selects a foreign Project verification Check",
      mutate: (input: RenderReleaseSummaryInput): RenderReleaseSummaryInput => ({
        ...input,
        acceptancePackage: {
          ...input.acceptancePackage,
          criteria: input.acceptancePackage.criteria.map((row) => ({
            ...row,
            verificationCheckIds: ["verification-check-foreign"],
          })),
        },
      }),
      type: "INVALID",
    },
  ])("fails closed when the snapshot $label", ({ mutate, type }) => {
    expect(renderReleaseSummary(mutate(releaseInput()))).toEqual(expect.objectContaining({ type }));
  });

  it("fails closed when the complete Markdown exceeds its byte ceiling", () => {
    const input = releaseInput();
    const criteria = Array.from({ length: 50 }, (_, index) => ({
      ...criterionEvidenceAt(input, 0),
      criterion: `Criterion ${index.toString().padStart(2, "0")}`,
      implementation: "и".repeat(4_000),
      verification: "v".repeat(4_000),
      knownRisk: "r".repeat(4_000),
    }));
    const rendered = renderReleaseSummary({
      ...input,
      workItem: { ...input.workItem, acceptanceCriteria: criteria.map(({ criterion }) => criterion) },
      acceptancePackage: { ...input.acceptancePackage, criteria },
    });
    expect(rendered).toEqual(expect.objectContaining({ type: "TOO_LARGE" }));
  });
});
