import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchMeasurementPlanConfiguration,
  LaunchMeasurementProjectResponse,
  VerificationPlan,
} from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { LaunchMeasurementView } from "./LaunchMeasurementPanel";

const verificationPlan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-web",
  projectId: "project-web",
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-audit",
      kind: "AUDIT",
      label: "Dependency audit",
      required: true,
      executable: "pnpm",
      argv: ["run", "audit"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "a".repeat(64),
        scriptName: "audit",
        scriptBodyPreview: "pnpm audit",
      },
    },
    {
      schemaVersion: 1,
      id: "package-start",
      kind: "SERVE",
      label: "Start service",
      required: false,
      executable: "pnpm",
      argv: ["run", "start"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "b".repeat(64),
        scriptName: "start",
        scriptBodyPreview: "node server.mjs",
      },
    },
  ],
  sourceProposalHash: "c".repeat(64),
  contentHash: "d".repeat(64),
  createdAt: "2026-09-10T13:00:00.000Z",
};

const empty: LaunchMeasurementProjectResponse = {
  schemaVersion: 1,
  projectId: "project-web",
  projectVersion: 3,
  plan: null,
  latestRun: null,
  freshness: null,
};

const renderView = (snapshot: LaunchMeasurementProjectResponse = empty): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <LaunchMeasurementView
        adopting={false}
        cancelling={false}
        disabling={false}
        onAdopt={vi.fn()}
        onCancel={vi.fn()}
        onDisable={vi.fn()}
        onRun={vi.fn()}
        running={false}
        snapshot={snapshot}
        verificationPlan={verificationPlan}
      />
    </I18nProvider>,
  );

describe("LaunchMeasurementView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows exact owner authority, bounded defaults and the local-only warning before adoption", () => {
    const html = renderView();

    expect(html).toContain("Local launch gates");
    expect(html).toContain("Start service: pnpm run start");
    expect(html).toContain("Dependency audit: pnpm run audit");
    expect(html).toContain("http://127.0.0.1:3000");
    expect(html).toContain("Fresh browser samples (3–5)");
    expect(html).toContain("content-security-policy");
    expect(html).toContain("Local measurement only");
    expect(html).toContain("does not deploy");
    expect(html).toContain("Approve launch gates");
    expect(html).not.toContain("OPENAI_API_KEY");
  });

  it("renders explicit failure, action-required evidence and freshness without raw payloads", () => {
    const configuration: LaunchMeasurementPlanConfiguration = {
      verificationPlanId: verificationPlan.id,
      verificationPlanRevision: verificationPlan.revision,
      verificationPlanContentHash: verificationPlan.contentHash,
      startupRecipeId: "package-start",
      dependencyAuditRecipeId: "package-audit",
      targetOrigin: "http://127.0.0.1:3000",
      healthPath: "/health/ready",
      probePath: "/",
      privateRoutes: ["/private"],
      samples: 3,
      thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 512_000 },
      requiredHeaders: ["content-security-policy", "x-content-type-options"],
    };
    const html = renderView({
      schemaVersion: 1,
      projectId: "project-web",
      projectVersion: 4,
      plan: {
        schemaVersion: 1,
        id: "launch-plan-web",
        projectId: "project-web",
        revision: 1,
        status: "ACTIVE",
        configuration,
        contentHash: "e".repeat(64),
        createdAt: "2026-09-10T13:01:00.000Z",
      },
      latestRun: {
        schemaVersion: 1,
        id: "launch-run-web",
        projectId: "project-web",
        planId: "launch-plan-web",
        planRevision: 1,
        planContentHash: "e".repeat(64),
        verificationPlanId: verificationPlan.id,
        verificationPlanRevision: verificationPlan.revision,
        verificationPlanContentHash: verificationPlan.contentHash,
        testedTree: "f".repeat(40),
        status: "FAILED",
        results: [
          {
            key: "PERF_WEB_VITALS",
            status: "PASSED",
            summary: "Measured web vitals passed.",
            evidence: {
              lcpSamplesMs: [800, 900, 1_000],
              inpSamplesMs: [40, 50, 60],
              clsSamples: [0.01, 0.02, 0.03],
              medianLcpMs: 900,
              medianInpMs: 50,
              medianCls: 0.02,
              thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1 },
            },
          },
          {
            key: "PERF_BUNDLE_BUDGET",
            status: "PASSED",
            summary: "Bundle passed.",
            evidence: {
              scriptByteSamples: [10_000, 11_000, 12_000],
              medianScriptBytes: 11_000,
              budgetBytes: 512_000,
            },
          },
          {
            key: "SEC_RESPONSE_HEADERS",
            status: "PASSED",
            summary: "Headers passed.",
            evidence: [
              { name: "content-security-policy", present: true },
              { name: "x-content-type-options", present: true },
            ],
          },
          {
            key: "SEC_UNAUTHENTICATED_ROUTES",
            status: "PASSED",
            summary: "Private route passed.",
            evidence: [{ path: "/private", statusCode: 401 }],
          },
          {
            key: "SEC_CLIENT_BUNDLE_SECRETS",
            status: "PASSED",
            summary: "No secret pattern was counted.",
            evidence: { scannedScriptBytes: 33_000, findings: [] },
          },
          {
            key: "DEPS_AUDIT",
            status: "ACTION_REQUIRED",
            summary: "Current audit evidence is missing.",
            evidence: null,
          },
        ],
        errorCode: null,
        startedAt: "2026-09-10T13:02:00.000Z",
        completedAt: "2026-09-10T13:02:03.000Z",
        version: 2,
      },
      freshness: { status: "CURRENT", reasons: [] },
    });

    expect(html).toContain("Launch action required");
    expect(html).toContain("Action required");
    expect(html).toContain("No current-tree audit evidence");
    expect(html).toContain("Median LCP 900 ms");
    expect(html).toContain("Current evidence");
    expect(html).not.toContain("raw provider payload");
  });

  it("keeps a blocked service stop actionable and prevents a second launch", () => {
    const configuration: LaunchMeasurementPlanConfiguration = {
      verificationPlanId: verificationPlan.id,
      verificationPlanRevision: verificationPlan.revision,
      verificationPlanContentHash: verificationPlan.contentHash,
      startupRecipeId: "package-start",
      dependencyAuditRecipeId: "package-audit",
      targetOrigin: "http://127.0.0.1:3000",
      healthPath: "/health/ready",
      probePath: "/",
      privateRoutes: ["/private"],
      samples: 3,
      thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 512_000 },
      requiredHeaders: ["content-security-policy", "x-content-type-options"],
    };
    const html = renderView({
      schemaVersion: 1,
      projectId: "project-web",
      projectVersion: 4,
      plan: {
        schemaVersion: 1,
        id: "launch-plan-web",
        projectId: "project-web",
        revision: 1,
        status: "ACTIVE",
        configuration,
        contentHash: "e".repeat(64),
        createdAt: "2026-09-10T13:01:00.000Z",
      },
      latestRun: {
        schemaVersion: 1,
        id: "launch-run-blocked",
        projectId: "project-web",
        planId: "launch-plan-web",
        planRevision: 1,
        planContentHash: "e".repeat(64),
        verificationPlanId: verificationPlan.id,
        verificationPlanRevision: verificationPlan.revision,
        verificationPlanContentHash: verificationPlan.contentHash,
        testedTree: "f".repeat(40),
        status: "BLOCKED",
        results: [],
        errorCode: "SERVICE_TERMINATION_FAILED",
        startedAt: "2026-09-10T13:02:00.000Z",
        completedAt: null,
        version: 2,
      },
      freshness: { status: "CURRENT", reasons: [] },
    });

    expect(html).toContain("Service stop unproved — action required");
    expect(html).toContain("Retry safe stop");
    expect(html).toContain("SERVICE_TERMINATION_FAILED");
    expect(html).toMatch(
      /<button(?=[^>]*disabled="")[^>]*><span[^>]*>Run local measurement<\/span><\/button>/u,
    );
  });
});
