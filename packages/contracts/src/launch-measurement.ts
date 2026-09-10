import { z } from "zod";

import { qaTargetOriginSchema } from "./qa.js";
import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const MAX_LAUNCH_MEASUREMENT_PRIVATE_ROUTES = 20;
export const MAX_LAUNCH_MEASUREMENT_SAMPLES = 5;
export const MIN_LAUNCH_MEASUREMENT_SAMPLES = 3;
export const MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES = 32 * 1_024 * 1_024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 31 || value.charCodeAt(index) === 127) return true;
  }
  return false;
};

export const launchMeasurementRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^\/(?!\/)[^\\]*$/u, "Launch measurement paths must be same-origin absolute paths")
  .refine(
    (value) => !hasControlCharacter(value),
    "Launch measurement paths cannot contain control characters",
  );

export const launchMeasurementGateKeySchema = z.enum([
  "PERF_WEB_VITALS",
  "PERF_BUNDLE_BUDGET",
  "SEC_RESPONSE_HEADERS",
  "SEC_UNAUTHENTICATED_ROUTES",
  "SEC_CLIENT_BUNDLE_SECRETS",
  "DEPS_AUDIT",
]);

export const launchMeasurementGateStatusSchema = z.enum(["PASSED", "FAILED", "ACTION_REQUIRED", "ERROR"]);

export const launchMeasurementHeaderSchema = z.enum([
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
]);

export const launchMeasurementSecretCategorySchema = z.enum([
  "API_KEY",
  "AUTH_TOKEN",
  "PRIVATE_KEY",
  "PASSWORD_ASSIGNMENT",
]);

export const launchMeasurementThresholdsSchema = z
  .object({
    lcpMs: z.number().int().min(100).max(60_000),
    inpMs: z.number().int().min(10).max(10_000),
    cls: z.number().min(0).max(10),
    scriptBytes: z.number().int().min(1_024).max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
  })
  .strict();

export const launchMeasurementPlanConfigurationSchema = z
  .object({
    verificationPlanId: opaqueIdSchema,
    verificationPlanRevision: z.number().int().positive(),
    verificationPlanContentHash: sha256Schema,
    startupRecipeId: opaqueIdSchema,
    dependencyAuditRecipeId: opaqueIdSchema.nullable(),
    targetOrigin: qaTargetOriginSchema,
    healthPath: launchMeasurementRelativePathSchema,
    probePath: launchMeasurementRelativePathSchema,
    privateRoutes: z.array(launchMeasurementRelativePathSchema).max(MAX_LAUNCH_MEASUREMENT_PRIVATE_ROUTES),
    samples: z.number().int().min(MIN_LAUNCH_MEASUREMENT_SAMPLES).max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
    thresholds: launchMeasurementThresholdsSchema,
    requiredHeaders: z.array(launchMeasurementHeaderSchema).min(1).max(4),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (new Set(configuration.privateRoutes).size !== configuration.privateRoutes.length) {
      context.addIssue({ code: "custom", path: ["privateRoutes"], message: "Private routes must be unique" });
    }
    if (new Set(configuration.requiredHeaders).size !== configuration.requiredHeaders.length) {
      context.addIssue({
        code: "custom",
        path: ["requiredHeaders"],
        message: "Required response headers must be unique",
      });
    }
    if (configuration.dependencyAuditRecipeId === configuration.startupRecipeId) {
      context.addIssue({
        code: "custom",
        path: ["dependencyAuditRecipeId"],
        message: "The service and dependency audit must use different recipes",
      });
    }
  });

export const launchMeasurementPlanStatusSchema = z.enum(["ACTIVE", "DISABLED"]);

export const launchMeasurementPlanSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    revision: z.number().int().positive(),
    status: launchMeasurementPlanStatusSchema,
    configuration: launchMeasurementPlanConfigurationSchema,
    contentHash: sha256Schema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const launchBrowserVitalsSampleSchema = z
  .object({
    lcpMs: z.number().nonnegative().max(60_000).nullable(),
    inpMs: z.number().nonnegative().max(10_000).nullable(),
    cls: z.number().nonnegative().max(10).nullable(),
    scriptBytes: z.number().int().nonnegative().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
  })
  .strict();

export const launchBrowserHeaderObservationSchema = z
  .object({
    name: launchMeasurementHeaderSchema,
    present: z.boolean(),
  })
  .strict();

export const launchBrowserPrivateRouteObservationSchema = z
  .object({
    path: launchMeasurementRelativePathSchema,
    statusCode: z.number().int().min(100).max(599),
  })
  .strict();

export const launchBrowserSecretObservationSchema = z
  .object({
    category: launchMeasurementSecretCategorySchema,
    count: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export const launchBrowserMeasurementSchema = z
  .object({
    samples: z
      .array(launchBrowserVitalsSampleSchema)
      .min(MIN_LAUNCH_MEASUREMENT_SAMPLES)
      .max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
    headers: z.array(launchBrowserHeaderObservationSchema).min(1).max(4),
    privateRoutes: z
      .array(launchBrowserPrivateRouteObservationSchema)
      .max(MAX_LAUNCH_MEASUREMENT_PRIVATE_ROUTES),
    secrets: z.array(launchBrowserSecretObservationSchema).max(4),
    scannedScriptBytes: z.number().int().nonnegative().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
    browserName: z.literal("CHROMIUM"),
    browserVersion: z.string().trim().min(1).max(100),
  })
  .strict()
  .superRefine((measurement, context) => {
    if (new Set(measurement.headers.map(({ name }) => name)).size !== measurement.headers.length) {
      context.addIssue({ code: "custom", path: ["headers"], message: "Header observations must be unique" });
    }
    if (
      new Set(measurement.privateRoutes.map(({ path }) => path)).size !== measurement.privateRoutes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["privateRoutes"],
        message: "Private route observations must be unique",
      });
    }
    if (new Set(measurement.secrets.map(({ category }) => category)).size !== measurement.secrets.length) {
      context.addIssue({ code: "custom", path: ["secrets"], message: "Secret observations must be unique" });
    }
  });

export const launchDependencyAuditEvidenceSchema = z
  .object({
    verificationRunId: opaqueIdSchema,
    verificationCheckId: opaqueIdSchema,
    recipeId: opaqueIdSchema,
    testedTree: treeShaSchema,
    status: z.enum(["PASSED", "FAILED", "ERROR", "INTERRUPTED"]),
  })
  .strict();

const gateBase = {
  status: launchMeasurementGateStatusSchema,
  summary: z.string().trim().min(1).max(1_000),
};

export const launchMeasurementGateResultSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("PERF_WEB_VITALS"),
      ...gateBase,
      evidence: z
        .object({
          lcpSamplesMs: z.array(z.number().nonnegative().max(60_000)).max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
          inpSamplesMs: z.array(z.number().nonnegative().max(10_000)).max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
          clsSamples: z.array(z.number().nonnegative().max(10)).max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
          medianLcpMs: z.number().nonnegative().max(60_000).nullable(),
          medianInpMs: z.number().nonnegative().max(10_000).nullable(),
          medianCls: z.number().nonnegative().max(10).nullable(),
          thresholds: launchMeasurementThresholdsSchema.pick({ lcpMs: true, inpMs: true, cls: true }),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      key: z.literal("PERF_BUNDLE_BUDGET"),
      ...gateBase,
      evidence: z
        .object({
          scriptByteSamples: z
            .array(z.number().int().nonnegative().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES))
            .min(MIN_LAUNCH_MEASUREMENT_SAMPLES)
            .max(MAX_LAUNCH_MEASUREMENT_SAMPLES),
          medianScriptBytes: z.number().int().nonnegative().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
          budgetBytes: z.number().int().positive().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      key: z.literal("SEC_RESPONSE_HEADERS"),
      ...gateBase,
      evidence: z.array(launchBrowserHeaderObservationSchema).min(1).max(4),
    })
    .strict(),
  z
    .object({
      key: z.literal("SEC_UNAUTHENTICATED_ROUTES"),
      ...gateBase,
      evidence: z
        .array(launchBrowserPrivateRouteObservationSchema)
        .max(MAX_LAUNCH_MEASUREMENT_PRIVATE_ROUTES),
    })
    .strict(),
  z
    .object({
      key: z.literal("SEC_CLIENT_BUNDLE_SECRETS"),
      ...gateBase,
      evidence: z
        .object({
          scannedScriptBytes: z.number().int().nonnegative().max(MAX_LAUNCH_MEASUREMENT_SCRIPT_BYTES),
          findings: z.array(launchBrowserSecretObservationSchema).max(4),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      key: z.literal("DEPS_AUDIT"),
      ...gateBase,
      evidence: launchDependencyAuditEvidenceSchema.nullable(),
    })
    .strict(),
]);

export const launchMeasurementRunErrorCodeSchema = z.enum([
  "PLAN_NOT_ACTIVE",
  "VERIFICATION_PLAN_STALE",
  "RECIPE_NOT_APPROVED",
  "TREE_UNAVAILABLE",
  "TREE_MUTATED",
  "SERVICE_SPAWN_FAILED",
  "SERVICE_EXITED",
  "SERVICE_TIMEOUT",
  "SERVICE_OUTPUT_LIMIT",
  "SERVICE_TERMINATION_FAILED",
  "TARGET_UNHEALTHY",
  "ORIGIN_FORBIDDEN",
  "MEASUREMENT_TIMEOUT",
  "EVIDENCE_INVALID",
  "OWNER_CANCELLED",
  "DAEMON_RESTART",
]);

export const launchMeasurementRunStatusSchema = z.enum([
  "RUNNING",
  "CANCELLING",
  "BLOCKED",
  "PASSED",
  "FAILED",
  "ERROR",
  "INTERRUPTED",
]);

export const launchMeasurementRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    planId: opaqueIdSchema,
    planRevision: z.number().int().positive(),
    planContentHash: sha256Schema,
    verificationPlanId: opaqueIdSchema,
    verificationPlanRevision: z.number().int().positive(),
    verificationPlanContentHash: sha256Schema,
    testedTree: treeShaSchema,
    status: launchMeasurementRunStatusSchema,
    results: z.array(launchMeasurementGateResultSchema).max(6),
    errorCode: launchMeasurementRunErrorCodeSchema.nullable(),
    startedAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    const active = run.status === "RUNNING" || run.status === "CANCELLING" || run.status === "BLOCKED";
    if (active !== (run.completedAt === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an active launch measurement can omit completion time",
      });
    }
    const carriesError = run.status === "ERROR" || run.status === "INTERRUPTED" || run.status === "BLOCKED";
    if (carriesError !== (run.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only blocked or terminal error runs carry an error code",
      });
    }
    if (run.status === "BLOCKED" && run.errorCode !== "SERVICE_TERMINATION_FAILED") {
      context.addIssue({
        code: "custom",
        message: "A blocked launch measurement must identify an unproved service stop",
      });
    }
    if ((run.status === "PASSED" || run.status === "FAILED") !== (run.results.length === 6)) {
      context.addIssue({
        code: "custom",
        message: "A measured terminal run must carry all six gate results",
      });
    }
    if (new Set(run.results.map(({ key }) => key)).size !== run.results.length) {
      context.addIssue({ code: "custom", message: "A launch measurement run cannot repeat a gate result" });
    }
  });

export const launchMeasurementFreshnessSchema = z
  .object({
    status: z.enum(["CURRENT", "STALE"]),
    reasons: z.array(z.enum(["TREE_CHANGED", "PLAN_CHANGED", "VERIFICATION_PLAN_CHANGED"])).max(3),
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

export const adoptLaunchMeasurementPlanCommandSchema = commandBaseSchema.extend({
  type: z.literal("ADOPT_LAUNCH_MEASUREMENT_PLAN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      configuration: launchMeasurementPlanConfigurationSchema,
    })
    .strict(),
});

export const disableLaunchMeasurementPlanCommandSchema = commandBaseSchema.extend({
  type: z.literal("DISABLE_LAUNCH_MEASUREMENT_PLAN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      expectedPlanRevision: z.number().int().positive(),
      expectedPlanContentHash: sha256Schema,
    })
    .strict(),
});

export const startLaunchMeasurementRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_LAUNCH_MEASUREMENT_RUN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedPlanRevision: z.number().int().positive(),
      expectedPlanContentHash: sha256Schema,
      testedTree: treeShaSchema,
    })
    .strict(),
});

export const cancelLaunchMeasurementRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("CANCEL_LAUNCH_MEASUREMENT_RUN"),
  payload: z.object({ runId: opaqueIdSchema, expectedVersion: z.number().int().positive() }).strict(),
});

export const completeLaunchMeasurementRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("COMPLETE_LAUNCH_MEASUREMENT_RUN"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      currentTree: treeShaSchema,
      browserMeasurement: launchBrowserMeasurementSchema,
      dependencyAudit: launchDependencyAuditEvidenceSchema.nullable(),
      processStopped: z.literal(true),
    })
    .strict(),
});

export const interruptLaunchMeasurementRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("INTERRUPT_LAUNCH_MEASUREMENT_RUN"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      errorCode: launchMeasurementRunErrorCodeSchema,
      processStopped: z.boolean(),
    })
    .strict(),
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

export const launchMeasurementPlanChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("LAUNCH_MEASUREMENT_PLAN_CHANGED"),
  data: z.object({ plan: launchMeasurementPlanSchema }).strict(),
});

export const launchMeasurementRunChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("LAUNCH_MEASUREMENT_RUN_CHANGED"),
  data: z.object({ run: launchMeasurementRunSchema }).strict(),
});

const resultBaseSchema = z.object({ schemaVersion: schemaVersionSchema, replayed: z.boolean() }).strict();

export const launchMeasurementPlanChangedResultSchema = resultBaseSchema.extend({
  type: z.literal("LAUNCH_MEASUREMENT_PLAN_CHANGED"),
  plan: launchMeasurementPlanSchema,
  projectVersion: z.number().int().positive(),
  event: launchMeasurementPlanChangedEventSchema,
});

export const launchMeasurementRunChangedResultSchema = resultBaseSchema.extend({
  type: z.literal("LAUNCH_MEASUREMENT_RUN_CHANGED"),
  run: launchMeasurementRunSchema,
  event: launchMeasurementRunChangedEventSchema,
});

export const adoptLaunchMeasurementPlanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    configuration: launchMeasurementPlanConfigurationSchema,
  })
  .strict();

export const disableLaunchMeasurementPlanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanContentHash: sha256Schema,
  })
  .strict();

export const startLaunchMeasurementRunRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanContentHash: sha256Schema,
  })
  .strict();

export const cancelLaunchMeasurementRunRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const launchMeasurementProjectResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    plan: launchMeasurementPlanSchema.nullable(),
    latestRun: launchMeasurementRunSchema.nullable(),
    freshness: launchMeasurementFreshnessSchema.nullable(),
  })
  .strict();

export type LaunchMeasurementGateKey = z.infer<typeof launchMeasurementGateKeySchema>;
export type LaunchMeasurementGateStatus = z.infer<typeof launchMeasurementGateStatusSchema>;
export type LaunchMeasurementHeader = z.infer<typeof launchMeasurementHeaderSchema>;
export type LaunchMeasurementSecretCategory = z.infer<typeof launchMeasurementSecretCategorySchema>;
export type LaunchMeasurementThresholds = z.infer<typeof launchMeasurementThresholdsSchema>;
export type LaunchMeasurementPlanConfiguration = z.infer<typeof launchMeasurementPlanConfigurationSchema>;
export type LaunchMeasurementPlan = z.infer<typeof launchMeasurementPlanSchema>;
export type LaunchBrowserMeasurement = z.infer<typeof launchBrowserMeasurementSchema>;
export type LaunchDependencyAuditEvidence = z.infer<typeof launchDependencyAuditEvidenceSchema>;
export type LaunchMeasurementGateResult = z.infer<typeof launchMeasurementGateResultSchema>;
export type LaunchMeasurementRunErrorCode = z.infer<typeof launchMeasurementRunErrorCodeSchema>;
export type LaunchMeasurementRunStatus = z.infer<typeof launchMeasurementRunStatusSchema>;
export type LaunchMeasurementRun = z.infer<typeof launchMeasurementRunSchema>;
export type LaunchMeasurementFreshness = z.infer<typeof launchMeasurementFreshnessSchema>;
export type LaunchMeasurementProjectResponse = z.infer<typeof launchMeasurementProjectResponseSchema>;
export type AdoptLaunchMeasurementPlanCommand = z.infer<typeof adoptLaunchMeasurementPlanCommandSchema>;
export type DisableLaunchMeasurementPlanCommand = z.infer<typeof disableLaunchMeasurementPlanCommandSchema>;
export type StartLaunchMeasurementRunCommand = z.infer<typeof startLaunchMeasurementRunCommandSchema>;
export type CancelLaunchMeasurementRunCommand = z.infer<typeof cancelLaunchMeasurementRunCommandSchema>;
export type CompleteLaunchMeasurementRunCommand = z.infer<typeof completeLaunchMeasurementRunCommandSchema>;
export type InterruptLaunchMeasurementRunCommand = z.infer<typeof interruptLaunchMeasurementRunCommandSchema>;
