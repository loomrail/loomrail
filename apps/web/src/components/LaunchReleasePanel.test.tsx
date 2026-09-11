import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeploymentPreviewResponse,
  GuidedDeploymentProjectResponse,
  GithubActionsDeploymentTarget,
  LaunchReleaseProjectResponse,
  WorkItem,
} from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { GuidedDeploymentView, LaunchReleaseView } from "./LaunchReleasePanel";

const now = "2026-09-10T13:00:00.000Z";
const environment = {
  schemaVersion: 1 as const,
  id: "environment-web",
  projectId: "project-web",
  kind: "PREVIEW" as const,
  name: "Recurkit Preview",
  presetId: "WEB_APP_V1" as const,
  presetRevision: 1 as const,
  publicBaseUrl: "https://preview.example.test",
  healthPath: "/health/ready",
  requiredEnvironmentVariables: ["DATABASE_URL"],
  contentHash: "a".repeat(64),
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const gateKeys = [
  "READINESS/SECURITY_ACTIVE_CONSTITUTION",
  "READINESS/SECURITY_SECRET_PATHS",
  "READINESS/SECURITY_ENV_IGNORED",
  "READINESS/SECURITY_CI_HARDENING",
  "READINESS/LEGAL_LICENSE",
  "READINESS/LEGAL_OWNER_REVIEW",
  "READINESS/PAYMENTS_OWNER_REVIEW",
  "READINESS/ANALYTICS_OWNER_REVIEW",
  "READINESS/DEPS_LOCKFILE_PRESENT",
  "READINESS/ENV_PROD_SEPARATION",
  "READINESS/SECURITY_HEADERS_OWNER_REVIEW",
  "READINESS/OPS_HEALTH_ENDPOINT_DECLARED",
  "READINESS/OPS_ROLLBACK_PLAN",
  "READINESS/OPS_BACKUP",
  "VERIFICATION/REQUIRED_RECIPES",
  "MEASURED/PERF_WEB_VITALS",
  "MEASURED/PERF_BUNDLE_BUDGET",
  "MEASURED/SEC_RESPONSE_HEADERS",
  "MEASURED/SEC_UNAUTHENTICATED_ROUTES",
  "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
  "MEASURED/DEPS_AUDIT",
  "REVIEW/SELECTED_WORK_ITEMS",
  "QA/SELECTED_WORK_ITEMS",
  "ACCEPTANCE/SELECTED_WORK_ITEMS",
] as const;

const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-web",
  projectId: "project-web",
  parentId: null,
  type: "TASK",
  title: "Ship beta candidate",
  description: "Prepare evidence.",
  acceptanceCriteria: ["Evidence is exported."],
  priority: "HIGH",
  risk: "MEDIUM",
  state: "DONE",
  currentStage: null,
  version: 2,
  createdAt: now,
  updatedAt: now,
};

const empty: LaunchReleaseProjectResponse = {
  schemaVersion: 1,
  projectId: "project-web",
  projectVersion: 3,
  environments: [],
  latestRelease: null,
  freshness: null,
};

const renderView = (snapshot: LaunchReleaseProjectResponse): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <LaunchReleaseView
        creating={false}
        exporting={false}
        onCreate={vi.fn()}
        onExport={vi.fn()}
        onSave={vi.fn()}
        saving={false}
        snapshot={snapshot}
        workItems={[workItem]}
      />
    </I18nProvider>,
  );

const deploymentTarget: GithubActionsDeploymentTarget = {
  presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
  presetRevision: 2,
  environmentKind: "PREVIEW",
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "d".repeat(40),
  workflowPath: ".github/workflows/deploy-preview.yml",
  workflowContentHash: "e".repeat(64),
  argvDigest: "f".repeat(64),
  dispatchTimeoutSeconds: 30,
  observeTimeoutSeconds: 15,
  outputLimitBytes: 32_768,
  observeOutputLimitBytes: 65_536,
};

const emptyDeployment: GuidedDeploymentProjectResponse = {
  schemaVersion: 1,
  projectId: "project-web",
  projectVersion: 5,
  latestPlan: null,
  latestDeployment: null,
  rollbackAvailability: "UNAVAILABLE",
};

const renderDeployment = (
  snapshot: GuidedDeploymentProjectResponse,
  preview: DeploymentPreviewResponse | null,
): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <GuidedDeploymentView
        adopting={false}
        approving={false}
        observing={false}
        onAdopt={vi.fn()}
        onApprove={vi.fn()}
        onObserve={vi.fn()}
        onStart={vi.fn()}
        preview={preview}
        previewLoading={false}
        releaseId="release-web"
        snapshot={snapshot}
        starting={false}
      />
    </I18nProvider>,
  );

describe("LaunchReleaseView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("requires an explicit public Environment declaration and describes the no-deploy boundary", () => {
    const html = renderView(empty);

    expect(html).toContain("Release evidence");
    expect(html).toContain("Evidence, not deployment");
    expect(html).toContain("does not contact this origin");
    expect(html).toContain("https://preview.example.com");
    expect(html).toContain("never values");
    expect(html).toContain("Ship beta candidate");
    expect(html).not.toContain("OPENAI_API_KEY");
  });

  it("shows current, failed and action-required gate states and offers a bounded export", () => {
    const gates = gateKeys.map((key, index) => ({
      key,
      status:
        index === 0 ? ("PASSED" as const) : index === 1 ? ("FAILED" as const) : ("ACTION_REQUIRED" as const),
      required: true,
      waivable: ![
        "READINESS/SECURITY_SECRET_PATHS",
        "READINESS/ENV_PROD_SEPARATION",
        "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
      ].includes(key),
      summary: index === 1 ? "Secret path evidence is incomplete." : "Evidence snapshot.",
      evidenceRefs: [],
    }));
    const html = renderView({
      ...empty,
      projectVersion: 4,
      environments: [environment],
      latestRelease: {
        schemaVersion: 1,
        id: "release-web",
        projectId: "project-web",
        sourceTree: "b".repeat(40),
        source: {
          readinessRunId: null,
          readinessSourceDigest: null,
          workingTreeDirty: null,
          verificationPlanId: null,
          verificationPlanRevision: null,
          verificationPlanContentHash: null,
          launchMeasurementPlanId: null,
          launchMeasurementPlanRevision: null,
          launchMeasurementPlanContentHash: null,
          launchMeasurementRunId: null,
          launchMeasurementRunVersion: null,
        },
        environment,
        selectedWorkItems: [],
        gates,
        requiredGateCount: 24,
        passedRequiredGateCount: 1,
        contentHash: "c".repeat(64),
        createdAt: now,
      },
      freshness: { status: "CURRENT", reasons: [] },
    });

    expect(html).toContain("Current snapshot");
    expect(html).toContain("Required gates passed: 1 of 24");
    expect(html).toContain("Failed");
    expect(html).toContain("Action required");
    expect(html).toContain("Secret path evidence is incomplete.");
    expect(html).toContain("Download evidence package");
  });

  it("explains blocked deploy without offering authority", () => {
    const html = renderDeployment(emptyDeployment, {
      schemaVersion: 1,
      projectId: "project-web",
      projectVersion: 5,
      releaseId: "release-web",
      releaseContentHash: "c".repeat(64),
      releaseEvidenceDigest: "3".repeat(64),
      status: "BLOCKED",
      code: "RELEASE_GATES_BLOCKED",
    });

    expect(html).toContain("Required release checks are not all passing");
    expect(html).toContain("Existing workflow only");
    expect(html).not.toContain("Approve and deploy once");
    expect(html).not.toContain("Confirm exact plan");
  });

  it("explains the Preview promotion gate before Production authority", () => {
    const html = renderDeployment(emptyDeployment, {
      schemaVersion: 1,
      projectId: "project-web",
      projectVersion: 5,
      releaseId: "release-web",
      releaseContentHash: "c".repeat(64),
      releaseEvidenceDigest: "3".repeat(64),
      status: "BLOCKED",
      code: "PREVIEW_PROMOTION_REQUIRED",
    });

    expect(html).toContain("Production is blocked");
    expect(html).toContain("Deploy and verify Preview first");
    expect(html).not.toContain("Confirm exact plan");
  });

  it("shows the exact target, distinct final approval and fail-closed unknown state", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "deployment-plan-web",
      projectId: "project-web",
      revision: 2 as const,
      releaseId: "release-web",
      releaseContentHash: "c".repeat(64),
      environmentId: "environment-web",
      environmentContentHash: environment.contentHash,
      environmentKind: "PREVIEW" as const,
      releaseEvidenceDigest: "3".repeat(64),
      target: deploymentTarget,
      contentHash: "1".repeat(64),
      createdAt: now,
    };
    const deployment = {
      schemaVersion: 1 as const,
      id: "deployment-web",
      projectId: "project-web",
      planId: plan.id,
      planRevision: 2 as const,
      planContentHash: plan.contentHash,
      releaseId: "release-web",
      releaseContentHash: "c".repeat(64),
      environmentId: "environment-web",
      environmentContentHash: environment.contentHash,
      environmentKind: "PREVIEW" as const,
      releaseEvidenceDigest: "3".repeat(64),
      intent: "STANDARD" as const,
      approvalDigest: "2".repeat(64),
      status: "PENDING_APPROVAL" as const,
      approvalId: null,
      remoteRunId: null,
      remoteRunUrl: null,
      failureCode: null,
      createdAt: now,
      approvedAt: null,
      startedAt: null,
      completedAt: null,
      observedAt: null,
      version: 1,
    };
    const ready: DeploymentPreviewResponse = {
      schemaVersion: 1,
      projectId: "project-web",
      projectVersion: 5,
      releaseId: "release-web",
      releaseContentHash: "c".repeat(64),
      releaseEvidenceDigest: "3".repeat(64),
      status: "READY",
      target: deploymentTarget,
    };
    const pendingHtml = renderDeployment(
      { ...emptyDeployment, latestPlan: plan, latestDeployment: deployment },
      ready,
    );
    expect(pendingHtml).toContain("recurkit/recurkit");
    expect(pendingHtml).toContain(".github/workflows/deploy-preview.yml");
    expect(pendingHtml).toContain("Preview");
    expect(pendingHtml).toContain("Second confirmation");
    expect(pendingHtml).toContain("Approve and deploy once");
    expect(pendingHtml).toContain("Rollback is unavailable");

    const unknownHtml = renderDeployment(
      {
        ...emptyDeployment,
        latestPlan: plan,
        latestDeployment: {
          ...deployment,
          status: "UNKNOWN",
          approvalId: "deployment-approval-web",
          approvedAt: now,
          startedAt: now,
          observedAt: now,
          failureCode: "DISPATCH_OUTCOME_UNKNOWN",
          version: 4,
        },
      },
      ready,
    );
    expect(unknownHtml).toContain("Do not deploy again");
    expect(unknownHtml).not.toContain("Prepare another exact attempt");
    expect(unknownHtml).not.toContain("Approve and deploy once");
  });
});
