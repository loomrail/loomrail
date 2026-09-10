import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchReleaseProjectResponse, WorkItem } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { LaunchReleaseView } from "./LaunchReleasePanel";

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
});
