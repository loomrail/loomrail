import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HumanRequest,
  PipelineRun,
  QACorrectionRun,
  VerificationCorrectionRun,
  VerificationPlan,
  VerificationRunSnapshotResponse,
} from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { ProjectVerificationView } from "./ProjectVerificationPanel";

const plan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: "project-1",
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
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
        manifestContentHash: "a".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  sourceProposalHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  createdAt: "2026-09-05T10:00:00.000Z",
};

const snapshot = (
  overrides: Partial<VerificationRunSnapshotResponse> = {},
): VerificationRunSnapshotResponse => ({
  schemaVersion: 1,
  plan,
  run: {
    schemaVersion: 1,
    id: "verification-run-1",
    projectId: plan.projectId,
    workItemId: "work-item-1",
    pipelineRunId: "pipeline-run-1",
    workspaceId: "workspace-1",
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    implementationTree: "d".repeat(40),
    ordinal: 1,
    retryOfRunId: null,
    platform: "darwin",
    status: "PASSED",
    currentCheckId: null,
    terminalReason: "ALL_REQUIRED_PASSED",
    startedAt: "2026-09-05T10:01:00.000Z",
    completedAt: "2026-09-05T10:01:01.250Z",
    createdAt: "2026-09-05T10:01:00.000Z",
    version: 3,
  },
  checks: [
    {
      schemaVersion: 1,
      id: "verification-check-1",
      projectId: plan.projectId,
      workItemId: "work-item-1",
      runId: "verification-run-1",
      recipeId: "package-test",
      ordinal: 1,
      required: true,
      status: "PASSED",
      startedAt: "2026-09-05T10:01:00.000Z",
      completedAt: "2026-09-05T10:01:01.250Z",
      durationMs: 1_250,
      exitCode: 0,
      signal: null,
      errorCode: null,
      output: {
        schemaVersion: 1,
        artifactId: "verification-output-1",
        sha256: "e".repeat(64),
        capturedBytes: 16,
        stdoutBytes: 16,
        stderrBytes: 0,
        truncated: false,
        available: true,
      },
      version: 3,
    },
  ],
  freshness: "CURRENT",
  staleReasons: [],
  ...overrides,
});

const renderView = (overrides: Partial<Parameters<typeof ProjectVerificationView>[0]> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProjectVerificationView
        actionPending={false}
        availability="READY"
        correctionGate={null}
        correctionPendingAction={null}
        correctionRuns={[]}
        currentPlan={plan}
        loadError={null}
        loading={false}
        onCancel={vi.fn()}
        onRetryLoad={vi.fn()}
        onResolveCorrection={vi.fn()}
        onRun={vi.fn()}
        onToggleOutput={vi.fn()}
        operationError={null}
        output={{ checkId: null, error: null, pending: false, text: undefined }}
        runs={[]}
        {...overrides}
      />
    </I18nProvider>,
  );

describe("ProjectVerificationView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows the exact approved command and one clear first-run action", () => {
    const html = renderView();

    expect(html).toContain("Project verification");
    expect(html).toContain("Unit tests");
    expect(html).toContain("Required · UNIT");
    expect(html).toContain("pnpm");
    expect(html).toContain("run");
    expect(html).toContain("test");
    expect(html).toContain("Not run");
    expect(html).toContain("UNIT checks");
    expect(html).toContain("Acceptance is blocked unless every required check passes");
    expect(html).toContain("Run checks");
    expect(html).not.toContain("Cancel run");
  });

  it("shows measured current evidence and escapes output as text", () => {
    const html = renderView({
      output: {
        checkId: "verification-check-1",
        error: null,
        pending: false,
        text: "<script>window.mustNotRun = true</script>",
      },
      runs: [snapshot()],
    });

    expect(html).toContain("Passed");
    expect(html).toContain("Run 1 · Plan r2 · macOS");
    expect(html).toContain(
      "Passed 1 · failed 0 · errors 0 · interrupted 0 · remaining 0 · tree dddddddddddd",
    );
    expect(html).toContain("UNIT checks");
    expect(html).toContain("1.3 s · exit 0");
    expect(html).toContain("All required checks passed for the current code and Plan.");
    expect(html).toContain("Run again");
    expect(html).toContain("&lt;script&gt;window.mustNotRun = true&lt;/script&gt;");
    expect(html).not.toContain("<script>window.mustNotRun = true</script>");
  });

  it("uses the stable Unit, Integration, E2E, Build, Lint, Custom group order", () => {
    const unit = plan.recipes[0];
    if (unit === undefined) throw new Error("Expected the fixture plan to carry a recipe");
    const groupedPlan: VerificationPlan = {
      ...plan,
      recipes: [
        {
          ...unit,
          id: "package-lint",
          kind: "LINT",
          label: "Lint",
          argv: ["run", "lint"],
          provenance: { ...unit.provenance, scriptName: "lint", scriptBodyPreview: "eslint ." },
        },
        {
          ...unit,
          id: "package-build",
          kind: "BUILD",
          label: "Build",
          argv: ["run", "build"],
          provenance: { ...unit.provenance, scriptName: "build", scriptBodyPreview: "vite build" },
        },
        unit,
      ],
    };
    const html = renderView({ currentPlan: groupedPlan });

    expect(html.indexOf("UNIT checks")).toBeLessThan(html.indexOf("BUILD checks"));
    expect(html.indexOf("BUILD checks")).toBeLessThan(html.indexOf("LINT checks"));
  });

  it("makes stale evidence and the reason explicit instead of presenting it as passed", () => {
    const stale = snapshot({ freshness: "STALE", staleReasons: ["TREE_CHANGED"] });
    const html = renderView({ runs: [stale, snapshot()] });

    expect(html).toContain("Stale");
    expect(html).toContain("the worktree changed");
    expect(html).toContain("Earlier runs (1)");
  });

  it("explains a missing owner Plan without rendering a dead action", () => {
    const html = renderView({ availability: "PLAN_REQUIRED", currentPlan: null });

    expect(html).toContain("Approve and publish Project checks in Settings");
    expect(html).not.toContain("Run checks");
  });

  it("shows one clear owner decision after automatic Project verification corrections are exhausted", () => {
    const correctionRun: VerificationCorrectionRun = {
      schemaVersion: 1,
      id: "verification-correction-2",
      projectId: plan.projectId,
      workItemId: "work-item-1",
      pipelineRunId: "pipeline-run-1",
      budgetPosition: 2,
      automatic: true,
      sourceFailureId: "verification-failure-2",
      sourceVerificationRunId: "verification-run-2",
      sourceImplementationTree: "f".repeat(40),
      status: "EXHAUSTED",
      createdAt: "2026-09-05T10:02:00.000Z",
      completedAt: null,
      version: 2,
    };
    const run: PipelineRun = {
      schemaVersion: 1,
      id: correctionRun.pipelineRunId,
      projectId: plan.projectId,
      workItemId: correctionRun.workItemId,
      workflowTemplateId: "delivery-v1",
      workflowVersion: 1,
      status: "WAITING_HUMAN",
      currentStageAttemptId: "qa-stage-3",
      version: 9,
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:03:00.000Z",
      finishedAt: null,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: "verification-owner-request",
      projectId: plan.projectId,
      workItemId: correctionRun.workItemId,
      stageAttemptId: run.currentStageAttemptId,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Project verification correction needs a decision",
      context: "Two automatic corrections failed.",
      recommendation: "Inspect the exact output before continuing.",
      options: [
        {
          id: "authorize-final",
          label: "Authorize final",
          consequence: "Starts correction 3.",
          recommended: true,
        },
        {
          id: "cancel-delivery",
          label: "Cancel delivery",
          consequence: "Stops this delivery.",
          recommended: false,
        },
      ],
      allowOther: false,
      status: "OPEN",
      version: 1,
      createdAt: "2026-09-05T10:03:00.000Z",
      resolvedAt: null,
    };
    const current = snapshot();
    const html = renderView({
      correctionGate: { correctionRun, qaCorrectionRun: null, request, run },
      correctionRuns: [correctionRun],
      runs: [
        {
          ...current,
          run: {
            ...current.run,
            status: "FAILED",
            terminalReason: "REQUIRED_CHECK_FAILED",
          },
        },
      ],
    });

    expect(html).toContain("Correction history");
    expect(html).toContain("Correction 2");
    expect(html).toContain("Needs your decision");
    expect(html).toContain("Project verification needs your decision");
    expect(html).toContain("Inspect the exact output before continuing.");
    expect(html).toContain("Authorize one final correction");
    expect(html).toContain("Cancel delivery");
    expect(html).not.toContain("Run again");
  });

  it("shows the shared owner gate when Project verification interrupts a Browser QA correction", () => {
    const qaCorrectionRun: QACorrectionRun = {
      schemaVersion: 1,
      id: "qa-correction-2",
      projectId: plan.projectId,
      workItemId: "work-item-1",
      pipelineRunId: "pipeline-run-1",
      ordinal: 1,
      sourceQARunId: "qa-run-1",
      baselineQARunId: "qa-run-1",
      sourceEvidenceBundleId: "qa-evidence-1",
      sourceTestedTree: "f".repeat(40),
      defectIds: ["qa-defect-1"],
      status: "ACTIVE",
      createdAt: "2026-09-05T10:02:00.000Z",
      completedAt: null,
      version: 1,
    };
    const run: PipelineRun = {
      schemaVersion: 1,
      id: qaCorrectionRun.pipelineRunId,
      projectId: plan.projectId,
      workItemId: qaCorrectionRun.workItemId,
      workflowTemplateId: "delivery-v1",
      workflowVersion: 1,
      status: "WAITING_HUMAN",
      currentStageAttemptId: "qa-stage-2",
      version: 9,
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:03:00.000Z",
      finishedAt: null,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: "mixed-verification-owner-request",
      projectId: plan.projectId,
      workItemId: qaCorrectionRun.workItemId,
      stageAttemptId: run.currentStageAttemptId,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Project verification correction needs a decision",
      context: "Project verification failed while Browser QA correction 1 was waiting for its exact retest.",
      recommendation: "Inspect the failed command output before authorizing the final shared correction.",
      options: [
        {
          id: "authorize-final",
          label: "Authorize final",
          consequence: "Starts shared correction 3, then returns to the same Browser QA retest.",
          recommended: true,
        },
        {
          id: "cancel-delivery",
          label: "Cancel delivery",
          consequence: "Stops the delivery and closes the suspended Browser QA correction.",
          recommended: false,
        },
      ],
      allowOther: false,
      status: "OPEN",
      version: 1,
      createdAt: "2026-09-05T10:03:00.000Z",
      resolvedAt: null,
    };

    const html = renderView({
      correctionGate: { correctionRun: null, qaCorrectionRun, request, run },
      runs: [snapshot()],
    });

    expect(html).toContain("Project verification needs your decision");
    expect(html).toContain(
      "Project verification failed while Browser QA correction 1 was waiting for its exact retest.",
    );
    expect(html).toContain("Authorize one final correction");
    expect(html).toContain("Cancel delivery");
    expect(html).not.toContain("Run again");
  });
});
