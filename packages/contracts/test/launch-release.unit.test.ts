import {
  createLaunchReleaseCommandSchema,
  createLaunchReleaseRequestSchema,
  launchEnvironmentConfigurationSchema,
  launchEvidencePackageResponseSchema,
  launchReleaseSchema,
  saveLaunchEnvironmentRequestSchema,
} from "../src/launch-release.js";
import { describe, expect, it } from "vitest";

const now = "2026-09-10T12:00:00.000Z";
const environment = {
  schemaVersion: 1 as const,
  id: "environment-preview",
  projectId: "project-1",
  kind: "PREVIEW" as const,
  name: "Рекуркит Preview",
  presetId: "WEB_APP_V1" as const,
  presetRevision: 1 as const,
  publicBaseUrl: "https://preview.example.test",
  healthPath: "/api/health",
  requiredEnvironmentVariables: ["DATABASE_URL", "AUTH_SECRET"],
  contentHash: "a".repeat(64),
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const configuration = {
  kind: environment.kind,
  name: environment.name,
  presetId: environment.presetId,
  presetRevision: environment.presetRevision,
  publicBaseUrl: environment.publicBaseUrl,
  healthPath: environment.healthPath,
  requiredEnvironmentVariables: environment.requiredEnvironmentVariables,
};

const evidenceRef = {
  kind: "LAUNCH_MEASUREMENT_RUN" as const,
  id: "measurement-1",
  version: 2,
  testedTree: "b".repeat(40),
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

describe("launch release contracts", () => {
  it("accepts a portable Environment declaration and rejects authority-shaped URL or names", () => {
    expect(launchEnvironmentConfigurationSchema.parse(configuration)).toMatchObject({
      publicBaseUrl: "https://preview.example.test",
      requiredEnvironmentVariables: ["DATABASE_URL", "AUTH_SECRET"],
    });
    for (const publicBaseUrl of [
      "http://preview.example.test",
      "https://owner:secret@preview.example.test",
      "https://preview.example.test/path",
      "https://preview.example.test?token=secret",
      "https://preview.example.test/#fragment",
    ]) {
      expect(() => launchEnvironmentConfigurationSchema.parse({ ...configuration, publicBaseUrl })).toThrow();
    }
    expect(() =>
      launchEnvironmentConfigurationSchema.parse({
        ...configuration,
        requiredEnvironmentVariables: ["DATABASE_URL", "DATABASE_URL"],
      }),
    ).toThrow();
    expect(() =>
      launchEnvironmentConfigurationSchema.parse({
        ...configuration,
        requiredEnvironmentVariables: ["DATABASE_URL=secret"],
      }),
    ).toThrow();
  });

  it("requires an exact create/update tuple and bounded unique WorkItem selection", () => {
    expect(
      saveLaunchEnvironmentRequestSchema.parse({
        schemaVersion: 1,
        commandId: "command-env",
        expectedProjectVersion: 2,
        environmentId: null,
        expectedEnvironmentVersion: null,
        configuration,
      }),
    ).toBeDefined();
    expect(() =>
      saveLaunchEnvironmentRequestSchema.parse({
        schemaVersion: 1,
        commandId: "command-env",
        expectedProjectVersion: 2,
        environmentId: "environment-preview",
        expectedEnvironmentVersion: null,
        configuration,
      }),
    ).toThrow();
    expect(() =>
      createLaunchReleaseRequestSchema.parse({
        schemaVersion: 1,
        commandId: "command-release",
        expectedProjectVersion: 3,
        environmentId: environment.id,
        expectedEnvironmentVersion: 1,
        expectedEnvironmentContentHash: environment.contentHash,
        workItemIds: ["work-1", "work-1"],
      }),
    ).toThrow();
  });

  it("requires daemon-captured HEAD identity as a complete tuple", () => {
    const command = {
      schemaVersion: 1,
      commandId: "command-release-source",
      correlationId: "correlation-release-source",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_LAUNCH_RELEASE",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 3,
        environmentId: environment.id,
        expectedEnvironmentVersion: 1,
        expectedEnvironmentContentHash: environment.contentHash,
        sourceTree: "b".repeat(40),
        sourceHead: "c".repeat(40),
        sourceHeadTree: "d".repeat(40),
        workItemIds: [],
      },
    };

    expect(createLaunchReleaseCommandSchema.parse(command)).toBeDefined();
    expect(() =>
      createLaunchReleaseCommandSchema.parse({
        ...command,
        payload: { ...command.payload, sourceHeadTree: null },
      }),
    ).toThrow();
  });

  it("requires every closed gate exactly once and refuses contradictory counts", () => {
    const gates = gateKeys.map((key) => ({
      key,
      status: "PASSED" as const,
      required: true,
      waivable: ![
        "READINESS/SECURITY_SECRET_PATHS",
        "READINESS/ENV_PROD_SEPARATION",
        "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
      ].includes(key),
      summary: "Evidence is current and passed.",
      evidenceRefs: [evidenceRef],
    }));
    const release = {
      schemaVersion: 1 as const,
      id: "release-1",
      projectId: "project-1",
      sourceTree: "b".repeat(40),
      source: {
        readinessRunId: "readiness-1",
        readinessSourceDigest: "c".repeat(64),
        workingTreeDirty: false,
        verificationPlanId: "verification-plan-1",
        verificationPlanRevision: 2,
        verificationPlanContentHash: "d".repeat(64),
        launchMeasurementPlanId: "measurement-plan-1",
        launchMeasurementPlanRevision: 1,
        launchMeasurementPlanContentHash: "e".repeat(64),
        launchMeasurementRunId: "measurement-1",
        launchMeasurementRunVersion: 2,
      },
      environment,
      selectedWorkItems: [],
      gates,
      requiredGateCount: 24,
      passedRequiredGateCount: 24,
      contentHash: "f".repeat(64),
      createdAt: now,
    };
    expect(launchReleaseSchema.parse(release).gates).toHaveLength(24);
    expect(() => launchReleaseSchema.parse({ ...release, gates: gates.slice(1) })).toThrow();
    expect(() => launchReleaseSchema.parse({ ...release, passedRequiredGateCount: 23 })).toThrow();
  });

  it("keeps the export response text-only and bounded", () => {
    expect(
      launchEvidencePackageResponseSchema.parse({
        schemaVersion: 1,
        releaseId: "release-1",
        contentType: "text/markdown; charset=utf-8",
        byteSize: 12,
        markdown: "# Evidence\n",
      }),
    ).toBeDefined();
  });

  it("requires complete Acceptance and Verification lineage tuples", () => {
    const evidence = {
      workItemId: "work-1",
      pipelineRunId: "pipeline-1",
      acceptancePackageId: "acceptance-1",
      acceptancePackageVersion: 1,
      acceptanceStatus: "ACCEPTED" as const,
      reviewArtifactId: "review-1",
      qaArtifactId: "qa-1",
      verificationRunId: "verification-run-1",
      verificationPlanId: "verification-plan-1",
      verificationPlanRevision: 1,
      verificationPlanContentHash: "a".repeat(64),
      testedTree: "b".repeat(40),
    };
    const gates = gateKeys.map((key) => ({
      key,
      status: "PASSED" as const,
      required: true,
      waivable: ![
        "READINESS/SECURITY_SECRET_PATHS",
        "READINESS/ENV_PROD_SEPARATION",
        "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
      ].includes(key),
      summary: "Evidence is current and passed.",
      evidenceRefs: [],
    }));
    const release = {
      schemaVersion: 1 as const,
      id: "release-lineage",
      projectId: "project-1",
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
      selectedWorkItems: [evidence],
      gates,
      requiredGateCount: 24,
      passedRequiredGateCount: 24,
      contentHash: "f".repeat(64),
      createdAt: now,
    };

    expect(launchReleaseSchema.parse(release).selectedWorkItems).toHaveLength(1);
    expect(
      launchReleaseSchema.parse({
        ...release,
        selectedWorkItems: [
          {
            ...evidence,
            verificationRunId: null,
            verificationPlanId: null,
            verificationPlanRevision: null,
            verificationPlanContentHash: null,
          },
        ],
      }).selectedWorkItems,
    ).toHaveLength(1);
    expect(() =>
      launchReleaseSchema.parse({
        ...release,
        selectedWorkItems: [{ ...evidence, acceptanceStatus: null }],
      }),
    ).toThrow();
    expect(() =>
      launchReleaseSchema.parse({
        ...release,
        selectedWorkItems: [{ ...evidence, verificationPlanContentHash: null }],
      }),
    ).toThrow();
  });
});
