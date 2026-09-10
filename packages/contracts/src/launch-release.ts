import { z } from "zod";

import { launchMeasurementRelativePathSchema } from "./launch-measurement.js";
import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const MAX_LAUNCH_ENVIRONMENTS = 8;
export const MAX_LAUNCH_ENVIRONMENT_VARIABLES = 32;
export const MAX_LAUNCH_RELEASE_WORK_ITEMS = 50;
export const MAX_LAUNCH_RELEASE_GATES = 24;
export const MAX_LAUNCH_EVIDENCE_PACKAGE_BYTES = 512 * 1_024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};
const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

export const launchEnvironmentKindSchema = z.enum(["PREVIEW", "PRODUCTION"]);
export const launchPresetIdSchema = z.literal("WEB_APP_V1");
export const launchEnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/u, "Environment variable names must be portable uppercase names");

export const launchEnvironmentPublicBaseUrlSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const match = /^https:\/\/(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([1-9]\d{0,4}))?$/u.exec(value);
    if (match === null || (match[1] !== undefined && Number(match[1]) > 65_535)) {
      context.addIssue({
        code: "custom",
        message: "The public base URL must be an exact credential-free HTTPS origin",
      });
    }
  });

export const launchEnvironmentConfigurationSchema = z
  .object({
    kind: launchEnvironmentKindSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((value) => value === value.normalize("NFC") && !hasControlCharacter(value)),
    presetId: launchPresetIdSchema,
    presetRevision: z.literal(1),
    publicBaseUrl: launchEnvironmentPublicBaseUrlSchema,
    healthPath: launchMeasurementRelativePathSchema,
    requiredEnvironmentVariables: z
      .array(launchEnvironmentVariableNameSchema)
      .max(MAX_LAUNCH_ENVIRONMENT_VARIABLES),
  })
  .strict()
  .refine(({ requiredEnvironmentVariables }) => unique(requiredEnvironmentVariables), {
    path: ["requiredEnvironmentVariables"],
    message: "Environment variable names must be unique",
  });

export const launchEnvironmentSchema = launchEnvironmentConfigurationSchema
  .extend({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    contentHash: sha256Schema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .strict();

export const launchReleaseGateKeySchema = z.enum([
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
]);

export const launchReleaseGateStatusSchema = z.enum(["PASSED", "ACTION_REQUIRED", "FAILED", "STALE"]);
export const launchReleaseEvidenceKindSchema = z.enum([
  "PROJECT_READINESS_RUN",
  "READINESS_CHECK",
  "VERIFICATION_PLAN",
  "VERIFICATION_RUN",
  "LAUNCH_MEASUREMENT_PLAN",
  "LAUNCH_MEASUREMENT_RUN",
  "ACCEPTANCE_PACKAGE",
  "EVIDENCE_ARTIFACT",
]);

export const launchReleaseEvidenceRefSchema = z
  .object({
    kind: launchReleaseEvidenceKindSchema,
    id: opaqueIdSchema,
    version: z.number().int().positive().nullable(),
    testedTree: treeShaSchema.nullable(),
  })
  .strict();

export const launchReleaseGateSchema = z
  .object({
    key: launchReleaseGateKeySchema,
    status: launchReleaseGateStatusSchema,
    required: z.boolean(),
    waivable: z.boolean(),
    summary: z.string().trim().min(1).max(1_000),
    evidenceRefs: z.array(launchReleaseEvidenceRefSchema).max(MAX_LAUNCH_RELEASE_WORK_ITEMS),
  })
  .strict();

export const launchReleaseSourceSchema = z
  .object({
    readinessRunId: opaqueIdSchema.nullable(),
    readinessSourceDigest: sha256Schema.nullable(),
    workingTreeDirty: z.boolean().nullable(),
    verificationPlanId: opaqueIdSchema.nullable(),
    verificationPlanRevision: z.number().int().positive().nullable(),
    verificationPlanContentHash: sha256Schema.nullable(),
    launchMeasurementPlanId: opaqueIdSchema.nullable(),
    launchMeasurementPlanRevision: z.number().int().positive().nullable(),
    launchMeasurementPlanContentHash: sha256Schema.nullable(),
    launchMeasurementRunId: opaqueIdSchema.nullable(),
    launchMeasurementRunVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((source, context) => {
    const tuples = [
      [source.readinessRunId, source.readinessSourceDigest, source.workingTreeDirty],
      [source.verificationPlanId, source.verificationPlanRevision, source.verificationPlanContentHash],
      [
        source.launchMeasurementPlanId,
        source.launchMeasurementPlanRevision,
        source.launchMeasurementPlanContentHash,
      ],
      [source.launchMeasurementRunId, source.launchMeasurementRunVersion],
    ];
    if (
      tuples.some((tuple) => tuple.some((value) => value === null) && tuple.some((value) => value !== null))
    ) {
      context.addIssue({ code: "custom", message: "Release source identities must be complete tuples" });
    }
  });

export const launchReleaseWorkItemEvidenceSchema = z
  .object({
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema.nullable(),
    acceptancePackageId: opaqueIdSchema.nullable(),
    acceptancePackageVersion: z.number().int().positive().nullable(),
    acceptanceStatus: z.enum(["PENDING", "ACCEPTED", "RETURNED", "REJECTED"]).nullable(),
    reviewArtifactId: opaqueIdSchema.nullable(),
    qaArtifactId: opaqueIdSchema.nullable(),
    verificationRunId: opaqueIdSchema.nullable(),
    verificationPlanId: opaqueIdSchema.nullable(),
    verificationPlanRevision: z.number().int().positive().nullable(),
    verificationPlanContentHash: sha256Schema.nullable(),
    testedTree: treeShaSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const acceptanceTuple = [
      evidence.acceptancePackageId,
      evidence.acceptancePackageVersion,
      evidence.acceptanceStatus,
    ];
    if (acceptanceTuple.some((value) => value === null) && acceptanceTuple.some((value) => value !== null)) {
      context.addIssue({
        code: "custom",
        message: "AcceptancePackage id, version and status must be supplied together",
      });
    }
    const verificationTuple = [
      evidence.verificationRunId,
      evidence.verificationPlanId,
      evidence.verificationPlanRevision,
      evidence.verificationPlanContentHash,
    ];
    if (
      verificationTuple.some((value) => value === null) &&
      verificationTuple.some((value) => value !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Verification Run and Plan identity must be supplied together",
      });
    }
    if (
      (evidence.verificationRunId !== null ||
        evidence.reviewArtifactId !== null ||
        evidence.qaArtifactId !== null) &&
      evidence.testedTree === null
    ) {
      context.addIssue({ code: "custom", message: "Authority-bound workflow evidence requires its tree" });
    }
    if (
      evidence.pipelineRunId === null &&
      [
        evidence.acceptancePackageId,
        evidence.acceptanceStatus,
        evidence.reviewArtifactId,
        evidence.qaArtifactId,
        evidence.verificationRunId,
        evidence.verificationPlanId,
        evidence.verificationPlanRevision,
        evidence.verificationPlanContentHash,
        evidence.testedTree,
      ].some((value) => value !== null)
    ) {
      context.addIssue({ code: "custom", message: "Workflow evidence requires its PipelineRun" });
    }
  });

const unwaivableGateKeys = new Set([
  "READINESS/SECURITY_SECRET_PATHS",
  "READINESS/ENV_PROD_SEPARATION",
  "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
]);

export const launchReleaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    sourceTree: treeShaSchema,
    source: launchReleaseSourceSchema,
    environment: launchEnvironmentSchema,
    selectedWorkItems: z.array(launchReleaseWorkItemEvidenceSchema).max(MAX_LAUNCH_RELEASE_WORK_ITEMS),
    gates: z.array(launchReleaseGateSchema).length(MAX_LAUNCH_RELEASE_GATES),
    requiredGateCount: z.number().int().min(1).max(MAX_LAUNCH_RELEASE_GATES),
    passedRequiredGateCount: z.number().int().nonnegative().max(MAX_LAUNCH_RELEASE_GATES),
    contentHash: sha256Schema,
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((release, context) => {
    const gateKeys = release.gates.map(({ key }) => key);
    const allGateKeys = launchReleaseGateKeySchema.options;
    if (!unique(gateKeys) || allGateKeys.some((key) => !gateKeys.includes(key))) {
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "A Release must contain every gate once",
      });
    }
    if (!unique(release.selectedWorkItems.map(({ workItemId }) => workItemId))) {
      context.addIssue({ code: "custom", path: ["selectedWorkItems"], message: "WorkItems must be unique" });
    }
    if (release.environment.projectId !== release.projectId) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: "Environment crosses Project boundary",
      });
    }
    const required = release.gates.filter(({ required }) => required);
    if (
      release.requiredGateCount !== required.length ||
      release.passedRequiredGateCount !== required.filter(({ status }) => status === "PASSED").length
    ) {
      context.addIssue({ code: "custom", message: "Release gate counts must match gate snapshots" });
    }
    for (const gate of release.gates) {
      if (unwaivableGateKeys.has(gate.key) && gate.waivable) {
        context.addIssue({
          code: "custom",
          path: ["gates"],
          message: "A non-waivable gate cannot be waived",
        });
      }
    }
  });

export const launchReleaseFreshnessSchema = z
  .object({
    status: z.enum(["CURRENT", "STALE"]),
    reasons: z
      .array(
        z.enum([
          "TREE_CHANGED",
          "ENVIRONMENT_CHANGED",
          "READINESS_CHANGED",
          "VERIFICATION_PLAN_CHANGED",
          "MEASUREMENT_CHANGED",
          "ACCEPTANCE_CHANGED",
        ]),
      )
      .max(6),
  })
  .strict();

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const saveLaunchEnvironmentCommandSchema = commandBaseSchema
  .extend({
    type: z.literal("SAVE_LAUNCH_ENVIRONMENT"),
    payload: z
      .object({
        projectId: opaqueIdSchema,
        expectedProjectVersion: z.number().int().positive(),
        environmentId: opaqueIdSchema.nullable(),
        expectedEnvironmentVersion: z.number().int().positive().nullable(),
        configuration: launchEnvironmentConfigurationSchema,
      })
      .strict(),
  })
  .superRefine((command, context) => {
    if ((command.payload.environmentId === null) !== (command.payload.expectedEnvironmentVersion === null)) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Environment id and version must be supplied together",
      });
    }
  });

export const createLaunchReleaseCommandSchema = commandBaseSchema.extend({
  type: z.literal("CREATE_LAUNCH_RELEASE"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      environmentId: opaqueIdSchema,
      expectedEnvironmentVersion: z.number().int().positive(),
      expectedEnvironmentContentHash: sha256Schema,
      sourceTree: treeShaSchema,
      sourceHead: treeShaSchema.nullable(),
      sourceHeadTree: treeShaSchema.nullable(),
      workItemIds: z.array(opaqueIdSchema).max(MAX_LAUNCH_RELEASE_WORK_ITEMS),
    })
    .strict()
    .refine(({ sourceHead, sourceHeadTree }) => (sourceHead === null) === (sourceHeadTree === null), {
      message: "Source HEAD and its tree must be supplied together",
    })
    .refine(({ workItemIds }) => unique(workItemIds), {
      path: ["workItemIds"],
      message: "Release WorkItems must be unique",
    }),
});

const eventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateType: z.literal("PROJECT"),
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const launchEnvironmentChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("LAUNCH_ENVIRONMENT_CHANGED"),
  data: z.object({ environment: launchEnvironmentSchema }).strict(),
});

export const launchReleaseCreatedEventSchema = eventBaseSchema.extend({
  type: z.literal("LAUNCH_RELEASE_CREATED"),
  data: z.object({ release: launchReleaseSchema }).strict(),
});

const resultBaseSchema = z.object({ schemaVersion: schemaVersionSchema, replayed: z.boolean() }).strict();
export const launchEnvironmentChangedResultSchema = resultBaseSchema.extend({
  type: z.literal("LAUNCH_ENVIRONMENT_CHANGED"),
  environment: launchEnvironmentSchema,
  projectVersion: z.number().int().positive(),
  event: launchEnvironmentChangedEventSchema,
});
export const launchReleaseCreatedResultSchema = resultBaseSchema.extend({
  type: z.literal("LAUNCH_RELEASE_CREATED"),
  release: launchReleaseSchema,
  projectVersion: z.number().int().positive(),
  event: launchReleaseCreatedEventSchema,
});

export const saveLaunchEnvironmentRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    environmentId: opaqueIdSchema.nullable(),
    expectedEnvironmentVersion: z.number().int().positive().nullable(),
    configuration: launchEnvironmentConfigurationSchema,
  })
  .strict()
  .refine(
    ({ environmentId, expectedEnvironmentVersion }) =>
      (environmentId === null) === (expectedEnvironmentVersion === null),
    { message: "Environment id and version must be supplied together" },
  );

export const createLaunchReleaseRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    environmentId: opaqueIdSchema,
    expectedEnvironmentVersion: z.number().int().positive(),
    expectedEnvironmentContentHash: sha256Schema,
    workItemIds: z.array(opaqueIdSchema).max(MAX_LAUNCH_RELEASE_WORK_ITEMS),
  })
  .strict()
  .refine(({ workItemIds }) => unique(workItemIds), {
    path: ["workItemIds"],
    message: "Release WorkItems must be unique",
  });

export const launchReleaseProjectResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    environments: z.array(launchEnvironmentSchema).max(MAX_LAUNCH_ENVIRONMENTS),
    latestRelease: launchReleaseSchema.nullable(),
    freshness: launchReleaseFreshnessSchema.nullable(),
  })
  .strict();

export const launchEvidencePackageResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    releaseId: opaqueIdSchema,
    contentType: z.literal("text/markdown; charset=utf-8"),
    byteSize: z.number().int().nonnegative().max(MAX_LAUNCH_EVIDENCE_PACKAGE_BYTES),
    markdown: z.string().max(MAX_LAUNCH_EVIDENCE_PACKAGE_BYTES),
  })
  .strict();

export type LaunchEnvironmentKind = z.infer<typeof launchEnvironmentKindSchema>;
export type LaunchEnvironmentConfiguration = z.infer<typeof launchEnvironmentConfigurationSchema>;
export type LaunchEnvironment = z.infer<typeof launchEnvironmentSchema>;
export type LaunchReleaseGateKey = z.infer<typeof launchReleaseGateKeySchema>;
export type LaunchReleaseGateStatus = z.infer<typeof launchReleaseGateStatusSchema>;
export type LaunchReleaseEvidenceRef = z.infer<typeof launchReleaseEvidenceRefSchema>;
export type LaunchReleaseGate = z.infer<typeof launchReleaseGateSchema>;
export type LaunchReleaseSource = z.infer<typeof launchReleaseSourceSchema>;
export type LaunchReleaseWorkItemEvidence = z.infer<typeof launchReleaseWorkItemEvidenceSchema>;
export type LaunchRelease = z.infer<typeof launchReleaseSchema>;
export type LaunchReleaseFreshness = z.infer<typeof launchReleaseFreshnessSchema>;
export type SaveLaunchEnvironmentCommand = z.infer<typeof saveLaunchEnvironmentCommandSchema>;
export type CreateLaunchReleaseCommand = z.infer<typeof createLaunchReleaseCommandSchema>;
export type LaunchEnvironmentChangedEvent = z.infer<typeof launchEnvironmentChangedEventSchema>;
export type LaunchReleaseCreatedEvent = z.infer<typeof launchReleaseCreatedEventSchema>;
export type LaunchEnvironmentChangedResult = z.infer<typeof launchEnvironmentChangedResultSchema>;
export type LaunchReleaseCreatedResult = z.infer<typeof launchReleaseCreatedResultSchema>;
export type SaveLaunchEnvironmentRequest = z.infer<typeof saveLaunchEnvironmentRequestSchema>;
export type CreateLaunchReleaseRequest = z.infer<typeof createLaunchReleaseRequestSchema>;
export type LaunchReleaseProjectResponse = z.infer<typeof launchReleaseProjectResponseSchema>;
export type LaunchEvidencePackageResponse = z.infer<typeof launchEvidencePackageResponseSchema>;
