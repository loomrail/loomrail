import type {
  AcceptancePackage,
  Actor,
  EvidenceArtifact,
  LaunchEnvironment,
  LaunchMeasurementPlan,
  LaunchMeasurementRun,
  Project,
  ProjectReadinessSnapshot,
  VerificationPlan,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideCreateLaunchRelease,
  decideSaveLaunchEnvironment,
  launchReleaseFreshness,
  renderLaunchEvidencePackage,
} from "../src/launch-release.js";

const now = "2026-09-10T12:00:00.000Z";
const tree = "b".repeat(40);
const head = "1".repeat(40);
const currentSource = { sourceTree: tree, sourceHead: head, sourceHeadTree: tree } as const;
const owner: Actor = { type: "HUMAN", id: "local-owner" };
const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Recurkit",
  repositoryPath: "C:\\Users\\Имя\\Project with spaces\\recurkit",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 7,
  createdAt: now,
  updatedAt: now,
};
const environment: LaunchEnvironment = {
  schemaVersion: 1,
  id: "environment-preview",
  projectId: project.id,
  kind: "PREVIEW",
  name: "Рекуркит Preview",
  presetId: "WEB_APP_V1",
  presetRevision: 1,
  publicBaseUrl: "https://preview.example.test",
  healthPath: "/api/health",
  requiredEnvironmentVariables: ["DATABASE_URL"],
  contentHash: "a".repeat(64),
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const readiness: ProjectReadinessSnapshot = {
  schemaVersion: 1,
  run: {
    schemaVersion: 1,
    id: "readiness-1",
    projectId: project.id,
    repositoryHead: head,
    sourceDigest: "2".repeat(64),
    workingTreeDirty: false,
    status: "READY",
    version: 1,
    createdAt: now,
    updatedAt: now,
  },
  checks: [
    "SECURITY_ACTIVE_CONSTITUTION",
    "SECURITY_SECRET_PATHS",
    "SECURITY_ENV_IGNORED",
    "SECURITY_CI_HARDENING",
    "LEGAL_LICENSE",
    "LEGAL_OWNER_REVIEW",
    "PAYMENTS_OWNER_REVIEW",
    "ANALYTICS_OWNER_REVIEW",
    "DEPS_LOCKFILE_PRESENT",
    "ENV_PROD_SEPARATION",
    "SECURITY_HEADERS_OWNER_REVIEW",
    "OPS_HEALTH_ENDPOINT_DECLARED",
    "OPS_ROLLBACK_PLAN",
    "OPS_BACKUP",
  ].map((key, index) => ({
    schemaVersion: 1 as const,
    id: `readiness-check-${index.toString()}`,
    runId: "readiness-1",
    projectId: project.id,
    key,
    category: "SECURITY" as const,
    mode: "AUTOMATED" as const,
    status: "PASSED" as const,
    summary: "Passed.",
    version: 1,
  })) as ProjectReadinessSnapshot["checks"],
  findings: [],
  attestations: [],
};

const verificationPlan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: project.id,
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "build",
      kind: "BUILD",
      label: "Build",
      required: true,
      executable: "pnpm",
      argv: ["run", "build"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "3".repeat(64),
        scriptName: "build",
        scriptBodyPreview: "tsc -b",
      },
    },
  ],
  sourceProposalHash: "4".repeat(64),
  contentHash: "5".repeat(64),
  createdAt: now,
};

const measurementPlan: LaunchMeasurementPlan = {
  schemaVersion: 1,
  id: "measurement-plan-1",
  projectId: project.id,
  revision: 1,
  status: "ACTIVE",
  configuration: {
    verificationPlanId: verificationPlan.id,
    verificationPlanRevision: verificationPlan.revision,
    verificationPlanContentHash: verificationPlan.contentHash,
    startupRecipeId: "serve",
    dependencyAuditRecipeId: null,
    targetOrigin: "http://127.0.0.1:4001",
    healthPath: "/api/health",
    probePath: "/",
    privateRoutes: [],
    samples: 3,
    thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 3_000_000 },
    requiredHeaders: ["content-security-policy"],
  },
  contentHash: "6".repeat(64),
  createdAt: now,
};
const measurementRun: LaunchMeasurementRun = {
  schemaVersion: 1,
  id: "measurement-run-1",
  projectId: project.id,
  planId: measurementPlan.id,
  planRevision: measurementPlan.revision,
  planContentHash: measurementPlan.contentHash,
  verificationPlanId: verificationPlan.id,
  verificationPlanRevision: verificationPlan.revision,
  verificationPlanContentHash: verificationPlan.contentHash,
  testedTree: tree,
  status: "FAILED",
  results: [
    {
      key: "PERF_WEB_VITALS",
      status: "ACTION_REQUIRED",
      summary: "Incomplete INP.",
      evidence: {
        lcpSamplesMs: [100, 110, 120],
        inpSamplesMs: [16],
        clsSamples: [0, 0, 0],
        medianLcpMs: 110,
        medianInpMs: 16,
        medianCls: 0,
        thresholds: { lcpMs: 2500, inpMs: 200, cls: 0.1 },
      },
    },
    {
      key: "PERF_BUNDLE_BUDGET",
      status: "PASSED",
      summary: "Passed.",
      evidence: { scriptByteSamples: [1000, 1000, 1000], medianScriptBytes: 1000, budgetBytes: 3000000 },
    },
    {
      key: "SEC_RESPONSE_HEADERS",
      status: "FAILED",
      summary: "Missing header.",
      evidence: [{ name: "content-security-policy", present: false }],
    },
    { key: "SEC_UNAUTHENTICATED_ROUTES", status: "ACTION_REQUIRED", summary: "No routes.", evidence: [] },
    {
      key: "SEC_CLIENT_BUNDLE_SECRETS",
      status: "PASSED",
      summary: "Passed.",
      evidence: { scannedScriptBytes: 1000, findings: [] },
    },
    { key: "DEPS_AUDIT", status: "ACTION_REQUIRED", summary: "No audit.", evidence: null },
  ],
  errorCode: null,
  startedAt: now,
  completedAt: now,
  version: 2,
};

const packageValue: AcceptancePackage = {
  schemaVersion: 1,
  id: "acceptance-1",
  projectId: project.id,
  workItemId: "work-1",
  pipelineRunId: "pipeline-1",
  stageAttemptId: "acceptance-stage-1",
  humanRequestId: "request-1",
  status: "ACCEPTED",
  criteria: [],
  verificationEvidence: {
    schemaVersion: 1,
    projectId: project.id,
    workItemId: "work-1",
    pipelineRunId: "pipeline-1",
    verificationRunId: "verification-run-1",
    planId: verificationPlan.id,
    planRevision: verificationPlan.revision,
    planContentHash: verificationPlan.contentHash,
    implementationTree: tree,
    platform: "darwin",
    requiredCheckIds: ["verification-check-1"],
    optionalFailedCheckIds: [],
    completedAt: now,
  },
  artifactIds: ["review-artifact-1", "qa-artifact-1"],
  releaseNote: "Release note.",
  verifyInstructions: ["Open the application."],
  version: 2,
  createdAt: now,
  resolvedAt: now,
  resolvedBy: owner,
  resolutionReason: "Accepted.",
};
const artifacts: EvidenceArtifact[] = [
  {
    schemaVersion: 1,
    id: "review-artifact-1",
    projectId: project.id,
    workItemId: "work-1",
    pipelineRunId: "pipeline-1",
    stageAttemptId: "review-stage-1",
    kind: "REVIEW_REPORT",
    title: "Independent review",
    provider: "CLAUDE_CODE",
    stage: "REVIEW",
    status: "PASSED",
    summary: "Review passed.",
    checks: ["standards"],
    reviewReportId: "review-report-1",
    testedTree: tree,
    correctionRunId: null,
    createdAt: now,
  },
  {
    schemaVersion: 1,
    id: "qa-artifact-1",
    projectId: project.id,
    workItemId: "work-1",
    pipelineRunId: "pipeline-1",
    stageAttemptId: "qa-stage-1",
    kind: "QA_REPORT",
    title: "Browser QA",
    provider: "CODEX",
    stage: "QA",
    status: "PASSED",
    summary: "QA passed.",
    checks: ["browser"],
    qaRunId: "qa-run-1",
    qaEvidenceBundleId: "qa-evidence-1",
    testedTree: tree,
    correctionRunId: null,
    createdAt: now,
  },
];

const saveCommand = {
  schemaVersion: 1 as const,
  commandId: "command-env",
  correlationId: "correlation-env",
  actor: owner,
  type: "SAVE_LAUNCH_ENVIRONMENT" as const,
  payload: {
    projectId: project.id,
    expectedProjectVersion: project.version,
    environmentId: null,
    expectedEnvironmentVersion: null,
    configuration: {
      kind: environment.kind,
      name: environment.name,
      presetId: environment.presetId,
      presetRevision: environment.presetRevision,
      publicBaseUrl: environment.publicBaseUrl,
      healthPath: environment.healthPath,
      requiredEnvironmentVariables: environment.requiredEnvironmentVariables,
    },
  },
};

describe("launch release domain", () => {
  it("creates or updates an Environment only for the owner and exact versions", () => {
    const decision = decideSaveLaunchEnvironment(saveCommand, {
      now,
      newEnvironmentId: environment.id,
      contentHash: environment.contentHash,
      project,
      currentEnvironment: undefined,
      environmentCount: 0,
      sameKindEnvironment: undefined,
    });
    expect(decision.environment).toMatchObject({ id: environment.id, version: 1, kind: "PREVIEW" });
    expect(decision.project.version).toBe(project.version + 1);
    expect(() =>
      decideSaveLaunchEnvironment(
        { ...saveCommand, actor: { type: "SYSTEM", id: "provider" } },
        {
          now,
          newEnvironmentId: environment.id,
          contentHash: environment.contentHash,
          project,
          currentEnvironment: undefined,
          environmentCount: 0,
          sameKindEnvironment: undefined,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
  });

  it("captures failed and missing evidence honestly instead of blocking Release creation", () => {
    const decision = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release",
        correlationId: "correlation-release",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: ["work-1"],
        },
      },
      {
        now,
        newReleaseId: "release-1",
        contentHash: "f".repeat(64),
        project,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [
          { workItemId: "work-1", acceptancePackage: packageValue, availableArtifacts: artifacts },
        ],
      },
    );
    expect(decision.release.gates).toHaveLength(24);
    expect(
      decision.release.gates.find(({ key }) => key === "READINESS/SECURITY_ACTIVE_CONSTITUTION"),
    ).toMatchObject({
      status: "PASSED",
      evidenceRefs: [{ kind: "READINESS_CHECK", testedTree: tree }],
    });
    expect(decision.release.gates.find(({ key }) => key === "MEASURED/SEC_RESPONSE_HEADERS")?.status).toBe(
      "FAILED",
    );
    expect(decision.release.gates.find(({ key }) => key === "MEASURED/DEPS_AUDIT")?.status).toBe(
      "ACTION_REQUIRED",
    );
    expect(decision.release.gates.find(({ key }) => key === "ACCEPTANCE/SELECTED_WORK_ITEMS")?.status).toBe(
      "PASSED",
    );
    expect(decision.release.passedRequiredGateCount).toBeLessThan(decision.release.requiredGateCount);
  });

  it("marks readiness stale for another HEAD or uncommitted current-tree content", () => {
    for (const source of [
      { ...currentSource, sourceHead: "9".repeat(40) },
      { ...currentSource, sourceHeadTree: "8".repeat(40) },
    ]) {
      const decision = decideCreateLaunchRelease(
        {
          schemaVersion: 1,
          commandId: `command-release-stale-readiness-${source.sourceHead}`,
          correlationId: "correlation-release-stale-readiness",
          actor: owner,
          type: "CREATE_LAUNCH_RELEASE",
          payload: {
            projectId: project.id,
            expectedProjectVersion: project.version,
            environmentId: environment.id,
            expectedEnvironmentVersion: environment.version,
            expectedEnvironmentContentHash: environment.contentHash,
            ...source,
            workItemIds: [],
          },
        },
        {
          now,
          newReleaseId: "release-stale-readiness",
          contentHash: "f".repeat(64),
          project,
          environment,
          readiness,
          verificationPlan,
          measurementPlan,
          measurementRun,
          workflowEvidence: [],
        },
      );
      expect(
        decision.release.gates.find(({ key }) => key === "READINESS/SECURITY_ACTIVE_CONSTITUTION"),
      ).toMatchObject({ status: "STALE", evidenceRefs: [{ testedTree: null }] });
    }
  });

  it("refuses cross-Project or tree-mixed workflow evidence", () => {
    const create = () =>
      decideCreateLaunchRelease(
        {
          schemaVersion: 1,
          commandId: "command-release-invalid",
          correlationId: "correlation-release-invalid",
          actor: owner,
          type: "CREATE_LAUNCH_RELEASE",
          payload: {
            projectId: project.id,
            expectedProjectVersion: project.version,
            environmentId: environment.id,
            expectedEnvironmentVersion: environment.version,
            expectedEnvironmentContentHash: environment.contentHash,
            ...currentSource,
            workItemIds: ["work-1"],
          },
        },
        {
          now,
          newReleaseId: "release-invalid",
          contentHash: "f".repeat(64),
          project,
          environment,
          readiness,
          verificationPlan,
          measurementPlan,
          measurementRun,
          workflowEvidence: [
            {
              workItemId: "work-1",
              acceptancePackage: packageValue,
              availableArtifacts: artifacts.map((artifact) => ({
                ...artifact,
                testedTree: "9".repeat(40),
              })),
            },
          ],
        },
      );
    expect(create).toThrow(expect.objectContaining({ code: "EVIDENCE_BOUNDARY_INVALID" }));

    const withoutVerification = { ...packageValue, verificationEvidence: null };
    expect(() =>
      decideCreateLaunchRelease(
        {
          schemaVersion: 1,
          commandId: "command-release-tree-mixed-without-verification",
          correlationId: "correlation-release-tree-mixed-without-verification",
          actor: owner,
          type: "CREATE_LAUNCH_RELEASE",
          payload: {
            projectId: project.id,
            expectedProjectVersion: project.version,
            environmentId: environment.id,
            expectedEnvironmentVersion: environment.version,
            expectedEnvironmentContentHash: environment.contentHash,
            ...currentSource,
            workItemIds: ["work-1"],
          },
        },
        {
          now,
          newReleaseId: "release-tree-mixed-without-verification",
          contentHash: "f".repeat(64),
          project,
          environment,
          readiness,
          verificationPlan,
          measurementPlan,
          measurementRun,
          workflowEvidence: [
            {
              workItemId: "work-1",
              acceptancePackage: withoutVerification,
              availableArtifacts: artifacts.map((artifact) =>
                artifact.kind === "QA_REPORT" ? { ...artifact, testedTree: "9".repeat(40) } : artifact,
              ),
            },
          ],
        },
      ),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_BOUNDARY_INVALID" }));
  });

  it("selects only artifacts named by AcceptancePackage and refuses a missing named artifact", () => {
    const create = (acceptancePackage: AcceptancePackage, availableArtifacts: EvidenceArtifact[]) =>
      decideCreateLaunchRelease(
        {
          schemaVersion: 1,
          commandId: "command-release-correction-history",
          correlationId: "correlation-release-correction-history",
          actor: owner,
          type: "CREATE_LAUNCH_RELEASE",
          payload: {
            projectId: project.id,
            expectedProjectVersion: project.version,
            environmentId: environment.id,
            expectedEnvironmentVersion: environment.version,
            expectedEnvironmentContentHash: environment.contentHash,
            ...currentSource,
            workItemIds: ["work-1"],
          },
        },
        {
          now,
          newReleaseId: "release-correction-history",
          contentHash: "f".repeat(64),
          project,
          environment,
          readiness,
          verificationPlan,
          measurementPlan,
          measurementRun,
          workflowEvidence: [
            {
              workItemId: "work-1",
              acceptancePackage,
              availableArtifacts,
            },
          ],
        },
      );
    const firstArtifact = artifacts[0];
    if (firstArtifact === undefined) throw new Error("The fixture requires a Review artifact");
    const supersededReview: EvidenceArtifact = {
      ...firstArtifact,
      id: "review-artifact-superseded",
      stageAttemptId: "review-stage-superseded",
      reviewReportId: "review-report-superseded",
      testedTree: "9".repeat(40),
    };

    expect(create(packageValue, [supersededReview, ...artifacts]).release.selectedWorkItems).toEqual([
      expect.objectContaining({
        reviewArtifactId: "review-artifact-1",
        qaArtifactId: "qa-artifact-1",
        testedTree: tree,
      }),
    ]);
    expect(() =>
      create({ ...packageValue, artifactIds: [...packageValue.artifactIds, "artifact-missing"] }, [
        supersededReview,
        ...artifacts,
      ]),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_BOUNDARY_INVALID" }));
  });

  it("does not pass Acceptance or Verification when their exact authority is missing", () => {
    const verificationEvidence = packageValue.verificationEvidence;
    if (verificationEvidence === undefined || verificationEvidence === null) {
      throw new Error("The fixture requires Verification evidence");
    }
    const decision = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release-unaccepted",
        correlationId: "correlation-release-unaccepted",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: ["work-1"],
        },
      },
      {
        now,
        newReleaseId: "release-unaccepted",
        contentHash: "f".repeat(64),
        project,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [
          {
            workItemId: "work-1",
            acceptancePackage: {
              ...packageValue,
              status: "RETURNED",
              verificationEvidence: {
                ...verificationEvidence,
                planContentHash: "9".repeat(64),
              },
            },
            availableArtifacts: artifacts,
          },
        ],
      },
    );

    expect(decision.release.gates.find(({ key }) => key === "ACCEPTANCE/SELECTED_WORK_ITEMS")?.status).toBe(
      "ACTION_REQUIRED",
    );
    expect(decision.release.gates.find(({ key }) => key === "VERIFICATION/REQUIRED_RECIPES")?.status).toBe(
      "STALE",
    );
  });

  it("does not let legacy Review or QA prose borrow the Verification tree", () => {
    const unboundArtifacts: EvidenceArtifact[] = artifacts.map((artifact) => {
      if (artifact.kind === "REVIEW_REPORT") {
        return { ...artifact, reviewReportId: undefined, testedTree: undefined };
      }
      return {
        ...artifact,
        qaRunId: undefined,
        qaEvidenceBundleId: undefined,
        testedTree: undefined,
      };
    });
    const decision = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release-legacy-prose",
        correlationId: "correlation-release-legacy-prose",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: ["work-1"],
        },
      },
      {
        now,
        newReleaseId: "release-legacy-prose",
        contentHash: "f".repeat(64),
        project,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [
          { workItemId: "work-1", acceptancePackage: packageValue, availableArtifacts: unboundArtifacts },
        ],
      },
    );

    expect(decision.release.gates.find(({ key }) => key === "REVIEW/SELECTED_WORK_ITEMS")?.status).toBe(
      "ACTION_REQUIRED",
    );
    expect(decision.release.gates.find(({ key }) => key === "QA/SELECTED_WORK_ITEMS")?.status).toBe(
      "ACTION_REQUIRED",
    );
  });

  it("marks a snapshot stale when a previously missing WorkItem package appears", () => {
    const release = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release-missing-package",
        correlationId: "correlation-release-missing-package",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: ["work-1"],
        },
      },
      {
        now,
        newReleaseId: "release-missing-package",
        contentHash: "f".repeat(64),
        project,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [{ workItemId: "work-1", acceptancePackage: null, availableArtifacts: [] }],
      },
    ).release;

    expect(
      launchReleaseFreshness(release, {
        currentTree: tree,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        acceptancePackages: [packageValue],
      }),
    ).toEqual({ status: "STALE", reasons: ["ACCEPTANCE_CHANGED"] });
  });

  it("reports closed freshness reasons without mutating the historical Release", () => {
    const release = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release-freshness",
        correlationId: "correlation-release-freshness",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: 1,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: [],
        },
      },
      {
        now,
        newReleaseId: "release-freshness",
        contentHash: "f".repeat(64),
        project,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [],
      },
    ).release;
    expect(
      launchReleaseFreshness(release, {
        currentTree: tree,
        environment,
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        acceptancePackages: [],
      }),
    ).toEqual({ status: "CURRENT", reasons: [] });
    expect(
      launchReleaseFreshness(release, {
        currentTree: "8".repeat(40),
        environment: { ...environment, version: 2 },
        readiness: {
          ...readiness,
          run: readiness.run === null ? null : { ...readiness.run, id: "readiness-2" },
        },
        verificationPlan,
        measurementPlan,
        measurementRun,
        acceptancePackages: [],
      }),
    ).toEqual({ status: "STALE", reasons: ["TREE_CHANGED", "ENVIRONMENT_CHANGED", "READINESS_CHANGED"] });
  });

  it("renders bounded escaped evidence without paths, env values or provider payloads", () => {
    const release = decideCreateLaunchRelease(
      {
        schemaVersion: 1,
        commandId: "command-release-render",
        correlationId: "correlation-release-render",
        actor: owner,
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          environmentId: environment.id,
          expectedEnvironmentVersion: 1,
          expectedEnvironmentContentHash: environment.contentHash,
          ...currentSource,
          workItemIds: [],
        },
      },
      {
        now,
        newReleaseId: "release-render",
        contentHash: "f".repeat(64),
        project,
        environment: {
          ...environment,
          name: "<script>alert(1)</script> C:\\Users\\Имя\\Project with spaces\\secret.env",
        },
        readiness,
        verificationPlan,
        measurementPlan,
        measurementRun,
        workflowEvidence: [],
      },
    ).release;
    const rendered = renderLaunchEvidencePackage({
      ...release,
      gates: release.gates.map((gate, index) =>
        index === 0
          ? {
              ...gate,
              summary:
                "OPENAI_API_KEY=sk-test-canary https://owner:password@example.test /Users/local owner/.env",
            }
          : gate,
      ),
    });
    expect(rendered.type).toBe("RENDERED");
    if (rendered.type !== "RENDERED") return;
    expect(rendered.markdown).toContain("&lt;script&gt;");
    expect(rendered.markdown).toContain("\\[redacted path\\]");
    expect(rendered.markdown).not.toContain("C:\\Users\\Имя");
    expect(rendered.markdown).not.toContain("Project with spaces");
    expect(rendered.markdown).not.toContain("sk-test-canary");
    expect(rendered.markdown).not.toContain("owner:password");
    expect(rendered.markdown).not.toContain("/Users/local owner");
    expect(rendered.markdown).not.toContain("provider payload");
    expect(rendered.byteSize).toBeLessThanOrEqual(512 * 1_024);
  });
});
