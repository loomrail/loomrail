import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};
const portableRelativeDirectorySchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    if (value === ".") {
      return true;
    }
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[/\\]/u.test(value)) {
      return false;
    }
    const parts = value.split("/");
    return (
      parts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part) && part !== "." && part !== "..") &&
      !value.includes("\\")
    );
  }, "Verification cwd must be a portable directory below the Project root");

const boundedArgSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\u0000"), "Verification argv cannot contain NUL")
  .refine((value) => utf8ByteLength(value) <= 256, "Verification argv items cannot exceed 256 UTF-8 bytes");

export const verificationRecipeKindSchema = z.enum(["LINT", "BUILD", "UNIT", "INTEGRATION", "E2E", "CUSTOM"]);
export const verificationExecutableSchema = z.enum(["pnpm", "npm", "yarn", "bun", "node"]);
export const verificationEnvironmentProfileSchema = z.literal("VERIFICATION_BASELINE");
export const verificationNetworkPolicySchema = z.enum(["INHERIT_HOST", "DENIED_UNAVAILABLE"]);
export const verificationScriptNameSchema = z.enum([
  "lint",
  "build",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
]);

export const verificationRecipeProvenanceSchema = z
  .object({
    source: z.literal("PACKAGE_JSON_SCRIPT"),
    manifestPath: z.literal("package.json"),
    manifestContentHash: sha256Schema,
    scriptName: verificationScriptNameSchema,
    scriptBodyPreview: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\u0000")),
  })
  .strict();

export const verificationRecipeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    kind: verificationRecipeKindSchema,
    label: z.string().trim().min(1).max(120),
    required: z.boolean(),
    executable: verificationExecutableSchema,
    argv: z.array(boundedArgSchema).min(1).max(16),
    cwd: portableRelativeDirectorySchema,
    timeoutSeconds: z.number().int().min(1).max(900),
    outputLimitBytes: z.number().int().min(1_024).max(262_144),
    environmentProfile: verificationEnvironmentProfileSchema,
    networkPolicy: verificationNetworkPolicySchema,
    provenance: verificationRecipeProvenanceSchema,
  })
  .strict();

export const verificationProposalWarningCodeSchema = z.enum([
  "MANIFEST_ABSENT",
  "MANIFEST_INVALID",
  "MANIFEST_TOO_LARGE",
  "MANIFEST_SYMLINK",
  "SCRIPT_LIMIT_REACHED",
  "SCRIPT_UNSAFE",
  "NO_SUPPORTED_SCRIPTS",
  "PLAN_TARGET_BLOCKED",
]);

export const verificationProposalWarningSchema = z
  .object({
    code: verificationProposalWarningCodeSchema,
    path: z.enum(["package.json", ".loomrail/verification-plan.json"]).nullable(),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export const verificationPlanTargetSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ABSENT"), digest: z.null() }).strict(),
  z.object({ state: z.literal("PRESENT"), digest: sha256Schema }).strict(),
  z.object({ state: z.literal("BLOCKED"), digest: z.null() }).strict(),
]);

export const verificationPlanProposalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    target: verificationPlanTargetSchema,
    recipes: z.array(verificationRecipeSchema).max(12),
    warnings: z.array(verificationProposalWarningSchema).max(32),
    proposalHash: sha256Schema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.recipes.length > 0 && !proposal.recipes.some((recipe) => recipe.required)) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "A verification proposal must contain at least one required recipe",
      });
    }
    if (new Set(proposal.recipes.map((recipe) => recipe.id)).size !== proposal.recipes.length) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "Verification recipe ids must be unique",
      });
    }
  });

export const verificationPlanStatusSchema = z.enum(["ACTIVE", "DISABLED"]);

export const verificationPlanSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    revision: z.number().int().positive(),
    status: verificationPlanStatusSchema,
    recipes: z.array(verificationRecipeSchema).min(1).max(12),
    sourceProposalHash: sha256Schema,
    contentHash: sha256Schema,
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (!plan.recipes.some((recipe) => recipe.required)) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "A verification plan must contain at least one required recipe",
      });
    }
    if (new Set(plan.recipes.map((recipe) => recipe.id)).size !== plan.recipes.length) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "Verification recipe ids must be unique",
      });
    }
  });

export const verificationPlanPublicationStatusSchema = z.enum(["PENDING", "APPLIED", "FAILED"]);
export const verificationPlanPublicationErrorCodeSchema = z.enum([
  "REPOSITORY_UNAVAILABLE",
  "TARGET_OUTSIDE_REPOSITORY",
  "TARGET_UNREADABLE",
  "TARGET_UNRECOGNIZED",
  "TARGET_CHANGED",
  "PROPOSAL_CHANGED",
  "CONTENT_HASH_MISMATCH",
  "WRITE_FAILED",
]);

export const verificationPlanPublicationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    planId: opaqueIdSchema,
    targetPath: z.literal(".loomrail/verification-plan.json"),
    expectedTargetDigest: sha256Schema.nullable(),
    contentHash: sha256Schema,
    status: verificationPlanPublicationStatusSchema,
    attempts: z.number().int().nonnegative(),
    lastErrorCode: verificationPlanPublicationErrorCodeSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    appliedAt: utcTimestampSchema.nullable(),
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

export const verificationCorrectionGateActionSchema = z.enum(["AUTHORIZE_FINAL", "CANCEL"]);

export const adoptVerificationPlanCommandSchema = commandBaseSchema.extend({
  type: z.literal("ADOPT_VERIFICATION_PLAN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      proposal: verificationPlanProposalSchema,
    })
    .strict(),
});

export const disableVerificationPlanCommandSchema = commandBaseSchema.extend({
  type: z.literal("DISABLE_VERIFICATION_PLAN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      expectedPlanRevision: z.number().int().positive(),
      expectedPlanContentHash: sha256Schema,
      expectedTargetDigest: sha256Schema.nullable(),
    })
    .strict(),
});

export const completeVerificationPlanPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("COMPLETE_VERIFICATION_PLAN_PUBLICATION"),
  payload: z
    .object({
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

export const failVerificationPlanPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("FAIL_VERIFICATION_PLAN_PUBLICATION"),
  payload: z
    .object({
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      errorCode: verificationPlanPublicationErrorCodeSchema,
    })
    .strict(),
});

export const retryVerificationPlanPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("RETRY_VERIFICATION_PLAN_PUBLICATION"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
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

export const verificationPlanAdoptedEventSchema = eventBaseSchema.extend({
  type: z.literal("VERIFICATION_PLAN_ADOPTED"),
  data: z
    .object({
      plan: verificationPlanSchema,
      publication: verificationPlanPublicationSchema,
      previousPlanRevision: z.number().int().positive().nullable(),
    })
    .strict(),
});

export const verificationPlanDisabledEventSchema = eventBaseSchema.extend({
  type: z.literal("VERIFICATION_PLAN_DISABLED"),
  data: z
    .object({
      plan: verificationPlanSchema,
      publication: verificationPlanPublicationSchema,
      previousPlanRevision: z.number().int().positive(),
    })
    .strict(),
});

const verificationPlanPublicationEventDataSchema = z
  .object({
    plan: verificationPlanSchema,
    publication: verificationPlanPublicationSchema,
  })
  .strict();

export const verificationPlanPublicationAppliedEventSchema = eventBaseSchema.extend({
  type: z.literal("VERIFICATION_PLAN_PUBLICATION_APPLIED"),
  data: verificationPlanPublicationEventDataSchema,
});

export const verificationPlanPublicationFailedEventSchema = eventBaseSchema.extend({
  type: z.literal("VERIFICATION_PLAN_PUBLICATION_FAILED"),
  data: verificationPlanPublicationEventDataSchema,
});

export const verificationPlanPublicationRetriedEventSchema = eventBaseSchema.extend({
  type: z.literal("VERIFICATION_PLAN_PUBLICATION_RETRIED"),
  data: verificationPlanPublicationEventDataSchema,
});

export const verificationPlanAdoptedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_PLAN_ADOPTED"),
    plan: verificationPlanSchema,
    publication: verificationPlanPublicationSchema,
    event: verificationPlanAdoptedEventSchema,
  })
  .strict();

export const verificationPlanDisabledResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_PLAN_DISABLED"),
    plan: verificationPlanSchema,
    publication: verificationPlanPublicationSchema,
    event: verificationPlanDisabledEventSchema,
  })
  .strict();

const verificationPlanPublicationResultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    plan: verificationPlanSchema,
    publication: verificationPlanPublicationSchema,
  })
  .strict();

export const verificationPlanPublicationAppliedResultSchema =
  verificationPlanPublicationResultBaseSchema.extend({
    type: z.literal("VERIFICATION_PLAN_PUBLICATION_APPLIED"),
    event: verificationPlanPublicationAppliedEventSchema,
  });

export const verificationPlanPublicationFailedResultSchema =
  verificationPlanPublicationResultBaseSchema.extend({
    type: z.literal("VERIFICATION_PLAN_PUBLICATION_FAILED"),
    event: verificationPlanPublicationFailedEventSchema,
  });

export const verificationPlanPublicationRetriedResultSchema =
  verificationPlanPublicationResultBaseSchema.extend({
    type: z.literal("VERIFICATION_PLAN_PUBLICATION_RETRIED"),
    event: verificationPlanPublicationRetriedEventSchema,
  });

export const adoptVerificationPlanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    proposalHash: sha256Schema,
  })
  .strict();

export const disableVerificationPlanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanContentHash: sha256Schema,
  })
  .strict();

export const retryVerificationPlanPublicationRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    publicationId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const startVerificationRunRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedWorkItemVersion: z.number().int().positive(),
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanContentHash: sha256Schema,
  })
  .strict();

export const retryVerificationRunRequestSchema = startVerificationRunRequestSchema.extend({
  retryOfRunId: opaqueIdSchema,
  expectedRetryOfRunVersion: z.number().int().positive(),
});

export const cancelVerificationRunRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const resolveVerificationCorrectionGateRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedRequestVersion: z.number().int().positive(),
    correctionRunId: opaqueIdSchema.nullable(),
    expectedCorrectionVersion: z.number().int().positive().nullable(),
    qaCorrectionRunId: opaqueIdSchema.nullable().optional(),
    expectedQACorrectionVersion: z.number().int().positive().nullable().optional(),
    expectedPipelineRunVersion: z.number().int().positive(),
    action: verificationCorrectionGateActionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const verificationPairMatches =
      (value.correctionRunId === null) === (value.expectedCorrectionVersion === null);
    const qaCorrectionRunId = value.qaCorrectionRunId ?? null;
    const expectedQACorrectionVersion = value.expectedQACorrectionVersion ?? null;
    const qaPairMatches = (qaCorrectionRunId === null) === (expectedQACorrectionVersion === null);
    if (!verificationPairMatches) {
      context.addIssue({
        code: "custom",
        message: "A verification correction ID and expected version must be supplied together",
      });
    }
    if (!qaPairMatches) {
      context.addIssue({
        code: "custom",
        message: "A QA correction ID and expected version must be supplied together",
      });
    }
    if (value.correctionRunId === null && qaCorrectionRunId === null) {
      context.addIssue({
        code: "custom",
        message: "A verification gate must identify a current evaluator correction",
      });
    }
  });

export const verificationPlanSettingsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    proposal: verificationPlanProposalSchema,
    plan: verificationPlanSchema.nullable(),
    publication: verificationPlanPublicationSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.proposal.projectId !== response.projectId ||
      (response.plan !== null && response.plan.projectId !== response.projectId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Verification settings cannot cross Project identities",
      });
    }
    if (
      response.publication !== null &&
      (response.plan === null ||
        response.publication.projectId !== response.projectId ||
        response.publication.planId !== response.plan.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "Verification publication must belong to the returned Plan",
      });
    }
  });

const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const verificationPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const verificationRunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "PASSED",
  "FAILED",
  "ERROR",
  "INTERRUPTED",
]);
export const verificationCheckStatusSchema = verificationRunStatusSchema;
export const verificationCheckErrorCodeSchema = z.enum([
  "RECIPE_NOT_APPROVED",
  "POLICY_UNAVAILABLE",
  "CWD_INVALID",
  "EXECUTABLE_NOT_FOUND",
  "SPAWN_FAILED",
  "OUTPUT_LIMIT_REACHED",
  "TIMED_OUT",
  "TREE_MUTATED",
  "TREE_UNAVAILABLE",
  "OUTPUT_WRITE_FAILED",
  "PROCESS_TERMINATION_FAILED",
  "EXIT_UNOBSERVED",
  "RUNNER_INTERNAL_ERROR",
]);
export const verificationRunTerminalReasonSchema = z.enum([
  "ALL_REQUIRED_PASSED",
  "REQUIRED_CHECK_FAILED",
  "REQUIRED_CHECK_ERROR",
  "OWNER_CANCELLED",
  "DAEMON_RESTART",
]);
export const verificationRunFreshnessSchema = z.enum(["CURRENT", "STALE"]);
export const verificationRunStaleReasonSchema = z.enum([
  "PLAN_UNAVAILABLE",
  "PLAN_REPLACED",
  "PLAN_UNPUBLISHED",
  "TREE_CHANGED",
]);

export const verificationEvidenceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    verificationRunId: opaqueIdSchema,
    planId: opaqueIdSchema,
    planRevision: z.number().int().positive(),
    planContentHash: sha256Schema,
    implementationTree: treeShaSchema,
    platform: verificationPlatformSchema,
    requiredCheckIds: z.array(opaqueIdSchema).min(1).max(12),
    optionalFailedCheckIds: z.array(opaqueIdSchema).max(12),
    completedAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const allCheckIds = [...evidence.requiredCheckIds, ...evidence.optionalFailedCheckIds];
    if (new Set(allCheckIds).size !== allCheckIds.length) {
      context.addIssue({
        code: "custom",
        path: ["requiredCheckIds"],
        message: "Verification evidence Check identities must be unique",
      });
    }
  });

export const verificationOutputSummarySchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    artifactId: opaqueIdSchema,
    sha256: sha256Schema,
    capturedBytes: z.number().int().nonnegative().max(262_144),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    available: z.boolean(),
  })
  .strict()
  .superRefine((output, context) => {
    const observedBytes = output.stdoutBytes + output.stderrBytes;
    if (output.capturedBytes > observedBytes) {
      context.addIssue({
        code: "custom",
        path: ["capturedBytes"],
        message: "Captured verification output cannot exceed observed output",
      });
    }
    if (!output.truncated && output.capturedBytes < observedBytes) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message:
          "Verification output must report truncation when raw bytes were dropped; bounded channel metadata may also require truncation",
      });
    }
  });

export const verificationOutputRetentionOutcomeSchema = z.enum(["DELETED", "ALREADY_ABSENT"]);

export const verificationCheckSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    runId: opaqueIdSchema,
    recipeId: opaqueIdSchema,
    ordinal: z.number().int().min(1).max(12),
    required: z.boolean(),
    status: verificationCheckStatusSchema,
    startedAt: utcTimestampSchema.nullable(),
    completedAt: utcTimestampSchema.nullable(),
    durationMs: z.number().int().nonnegative().max(1_000_000).nullable(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .max(32)
      .nullable(),
    errorCode: verificationCheckErrorCodeSchema.nullable(),
    output: verificationOutputSummarySchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((check, context) => {
    const issue = (path: string, message: string): void => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (check.status === "QUEUED") {
      if (
        check.startedAt !== null ||
        check.completedAt !== null ||
        check.durationMs !== null ||
        check.exitCode !== null ||
        check.signal !== null ||
        check.errorCode !== null ||
        check.output !== null
      ) {
        issue("status", "A queued verification Check cannot carry measured evidence");
      }
      return;
    }
    if (check.status === "RUNNING") {
      if (
        check.startedAt === null ||
        check.completedAt !== null ||
        check.durationMs !== null ||
        check.exitCode !== null ||
        check.signal !== null ||
        check.errorCode !== null ||
        check.output !== null
      ) {
        issue("status", "A running verification Check can only carry its start time");
      }
      return;
    }
    if (check.completedAt === null) issue("completedAt", "A terminal verification Check must complete");
    if (check.startedAt === null) issue("startedAt", "A terminal verification Check must have started");
    if (check.durationMs === null) issue("durationMs", "A terminal verification Check needs duration");
    if (check.status === "PASSED") {
      if (
        check.exitCode !== 0 ||
        check.signal !== null ||
        check.errorCode !== null ||
        check.output === null
      ) {
        issue("status", "A passing verification Check requires observed exit code zero and output evidence");
      }
    } else if (check.status === "FAILED") {
      if (
        check.exitCode === null ||
        check.exitCode === 0 ||
        check.signal !== null ||
        check.errorCode !== null ||
        check.output === null
      ) {
        issue("status", "A failed verification Check requires an observed non-zero exit and output evidence");
      }
    } else if (check.status === "ERROR") {
      if (check.errorCode === null) issue("errorCode", "An errored verification Check needs a typed error");
    } else if (check.errorCode !== null) {
      issue("errorCode", "An interrupted verification Check cannot claim an infrastructure error");
    }
  });

export const verificationRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    planId: opaqueIdSchema,
    planRevision: z.number().int().positive(),
    planContentHash: sha256Schema,
    implementationTree: treeShaSchema,
    ordinal: z.number().int().positive(),
    retryOfRunId: opaqueIdSchema.nullable(),
    verificationCorrectionRunId: opaqueIdSchema.nullable().optional(),
    platform: verificationPlatformSchema,
    status: verificationRunStatusSchema,
    currentCheckId: opaqueIdSchema.nullable(),
    terminalReason: verificationRunTerminalReasonSchema.nullable(),
    startedAt: utcTimestampSchema.nullable(),
    completedAt: utcTimestampSchema.nullable(),
    createdAt: utcTimestampSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    const issue = (message: string): void => {
      context.addIssue({ code: "custom", path: ["status"], message });
    };
    if (run.status === "QUEUED") {
      if (
        run.currentCheckId !== null ||
        run.terminalReason !== null ||
        run.startedAt !== null ||
        run.completedAt !== null
      ) {
        issue("A queued verification Run cannot carry execution state");
      }
      return;
    }
    if (run.status === "RUNNING") {
      if (run.startedAt === null || run.completedAt !== null || run.terminalReason !== null) {
        issue("A running verification Run requires a start and no terminal state");
      }
      return;
    }
    if (
      (run.status !== "INTERRUPTED" && run.startedAt === null) ||
      run.completedAt === null ||
      run.currentCheckId !== null
    ) {
      issue("A terminal verification Run requires valid timestamps and no current Check");
    }
    const validReason =
      (run.status === "PASSED" && run.terminalReason === "ALL_REQUIRED_PASSED") ||
      (run.status === "FAILED" && run.terminalReason === "REQUIRED_CHECK_FAILED") ||
      (run.status === "ERROR" && run.terminalReason === "REQUIRED_CHECK_ERROR") ||
      (run.status === "INTERRUPTED" &&
        (run.terminalReason === "OWNER_CANCELLED" || run.terminalReason === "DAEMON_RESTART"));
    if (!validReason) issue("A terminal verification Run has a contradictory reason");
  });

export const verificationFailureReasonSchema = z.enum([
  "REQUIRED_CHECK_FAILED",
  "REQUIRED_CHECK_ERROR",
  "RUN_INTERRUPTED",
  "STALE",
]);

export const verificationCorrectionRunStatusSchema = z.enum([
  "ACTIVE",
  "PASSED",
  "SUPERSEDED",
  "EXHAUSTED",
  "CANCELLED",
]);

/** Immutable evaluator identity; correction and resolution history reference it instead of mutating it. */
export const verificationFailureSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    verificationRunId: opaqueIdSchema,
    verificationCheckId: opaqueIdSchema.nullable(),
    planId: opaqueIdSchema,
    planRevision: z.number().int().positive(),
    planContentHash: sha256Schema,
    implementationTree: treeShaSchema,
    reason: verificationFailureReasonSchema,
    staleReasons: z.array(verificationRunStaleReasonSchema).max(4),
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((failure, context) => {
    const stale = failure.reason === "STALE";
    if (stale !== failure.staleReasons.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["staleReasons"],
        message: "Only a stale verification failure carries stale reasons",
      });
    }
    if (
      (failure.reason === "REQUIRED_CHECK_FAILED" || failure.reason === "REQUIRED_CHECK_ERROR") &&
      failure.verificationCheckId === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["verificationCheckId"],
        message: "A failed verification Check must identify its measured source",
      });
    }
    if (stale && failure.verificationCheckId !== null) {
      context.addIssue({
        code: "custom",
        path: ["verificationCheckId"],
        message: "A stale Run failure is not attributed to one Check",
      });
    }
  });

export const verificationCorrectionRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    budgetPosition: z.number().int().min(1).max(3),
    automatic: z.boolean(),
    sourceFailureId: opaqueIdSchema,
    sourceVerificationRunId: opaqueIdSchema,
    sourceImplementationTree: treeShaSchema,
    // Added after the initial Q17 contract. Missing remains accepted for replay of old receipts;
    // newly persisted rows always materialize an explicit null or exact suspended QA authority.
    resumesQACorrectionRunId: opaqueIdSchema.nullable().optional(),
    status: verificationCorrectionRunStatusSchema,
    createdAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.automatic !== run.budgetPosition <= 2) {
      context.addIssue({
        code: "custom",
        path: ["automatic"],
        message: "Only the first two correction positions are automatic",
      });
    }
    const terminal = run.status === "PASSED" || run.status === "SUPERSEDED" || run.status === "CANCELLED";
    if (terminal !== (run.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only a terminal verification correction carries completion time",
      });
    }
  });

export const verificationCheckObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("PASSED"),
      completedAt: utcTimestampSchema,
      durationMs: z.number().int().nonnegative().max(1_000_000),
      exitCode: z.literal(0),
      signal: z.null(),
      output: verificationOutputSummarySchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("FAILED"),
      completedAt: utcTimestampSchema,
      durationMs: z.number().int().nonnegative().max(1_000_000),
      exitCode: z
        .number()
        .int()
        .refine((value) => value !== 0),
      signal: z.null(),
      output: verificationOutputSummarySchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("ERROR"),
      completedAt: utcTimestampSchema,
      durationMs: z.number().int().nonnegative().max(1_000_000),
      exitCode: z.number().int().nullable(),
      signal: z
        .string()
        .regex(/^SIG[A-Z0-9]+$/)
        .max(32)
        .nullable(),
      errorCode: verificationCheckErrorCodeSchema,
      output: verificationOutputSummarySchema.nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("INTERRUPTED"),
      completedAt: utcTimestampSchema,
      durationMs: z.number().int().nonnegative().max(1_000_000),
      exitCode: z.number().int().nullable(),
      signal: z
        .string()
        .regex(/^SIG[A-Z0-9]+$/)
        .max(32)
        .nullable(),
      reason: z.literal("OWNER_CANCELLED"),
      output: verificationOutputSummarySchema.nullable(),
    })
    .strict(),
]);

const verificationRunReservationPayloadSchema = z
  .object({
    workItemId: opaqueIdSchema,
    expectedWorkItemVersion: z.number().int().positive(),
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanContentHash: sha256Schema,
    implementationTree: treeShaSchema,
    platform: verificationPlatformSchema,
  })
  .strict();

export const startVerificationRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_VERIFICATION_RUN"),
  payload: verificationRunReservationPayloadSchema,
});

export const retryVerificationRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("RETRY_VERIFICATION_RUN"),
  payload: verificationRunReservationPayloadSchema.extend({
    retryOfRunId: opaqueIdSchema,
    expectedRetryOfRunVersion: z.number().int().positive(),
  }),
});

export const materializeStaleVerificationFailureCommandSchema = commandBaseSchema.extend({
  type: z.literal("MATERIALIZE_STALE_VERIFICATION_FAILURE"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      verificationRunId: opaqueIdSchema,
      expectedWorkItemVersion: z.number().int().positive(),
      expectedPipelineRunVersion: z.number().int().positive(),
      expectedStageAttemptVersion: z.number().int().positive(),
      expectedVerificationRunVersion: z.number().int().positive(),
      expectedPlanRevision: z.number().int().positive(),
      expectedPlanContentHash: sha256Schema,
      currentTree: treeShaSchema,
    })
    .strict(),
});

export const startVerificationCheckCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_VERIFICATION_CHECK"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      checkId: opaqueIdSchema,
      expectedRunVersion: z.number().int().positive(),
      expectedCheckVersion: z.number().int().positive(),
    })
    .strict(),
});

export const completeVerificationCheckCommandSchema = commandBaseSchema.extend({
  type: z.literal("COMPLETE_VERIFICATION_CHECK"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      checkId: opaqueIdSchema,
      expectedRunVersion: z.number().int().positive(),
      expectedCheckVersion: z.number().int().positive(),
      observation: verificationCheckObservationSchema,
      outputStorageKey: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*\.txt$/)
        .max(255)
        .nullable(),
    })
    .strict()
    .superRefine((payload, context) => {
      if ((payload.observation.output === null) !== (payload.outputStorageKey === null)) {
        context.addIssue({
          code: "custom",
          path: ["outputStorageKey"],
          message: "Output evidence and its storage key must be recorded together",
        });
      }
    }),
});

export const cancelVerificationRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("CANCEL_VERIFICATION_RUN"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      expectedRunVersion: z.number().int().positive(),
    })
    .strict(),
});

export const interruptVerificationRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("INTERRUPT_VERIFICATION_RUN"),
  payload: z
    .object({
      runId: opaqueIdSchema,
      expectedRunVersion: z.number().int().positive(),
      reason: z.literal("DAEMON_RESTART"),
    })
    .strict(),
});

export const recordVerificationOutputRetentionCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_VERIFICATION_OUTPUT_RETENTION"),
  payload: z
    .object({
      artifactId: opaqueIdSchema,
      outcome: verificationOutputRetentionOutcomeSchema,
    })
    .strict(),
});

export const resolveVerificationCorrectionGateCommandSchema = commandBaseSchema.extend({
  type: z.literal("RESOLVE_VERIFICATION_CORRECTION_GATE"),
  payload: z
    .object({
      humanRequestId: opaqueIdSchema,
      expectedRequestVersion: z.number().int().positive(),
      correctionRunId: opaqueIdSchema.nullable(),
      expectedCorrectionVersion: z.number().int().positive().nullable(),
      qaCorrectionRunId: opaqueIdSchema.nullable().optional(),
      expectedQACorrectionVersion: z.number().int().positive().nullable().optional(),
      expectedPipelineRunVersion: z.number().int().positive(),
      action: verificationCorrectionGateActionSchema,
    })
    .strict()
    .superRefine((value, context) => {
      const verificationPairMatches =
        (value.correctionRunId === null) === (value.expectedCorrectionVersion === null);
      const qaCorrectionRunId = value.qaCorrectionRunId ?? null;
      const expectedQACorrectionVersion = value.expectedQACorrectionVersion ?? null;
      const qaPairMatches = (qaCorrectionRunId === null) === (expectedQACorrectionVersion === null);
      if (!verificationPairMatches) {
        context.addIssue({
          code: "custom",
          message: "A verification correction ID and expected version must be supplied together",
        });
      }
      if (!qaPairMatches) {
        context.addIssue({
          code: "custom",
          message: "A QA correction ID and expected version must be supplied together",
        });
      }
      if (value.correctionRunId === null && qaCorrectionRunId === null) {
        context.addIssue({
          code: "custom",
          message: "A verification gate must identify a current evaluator correction",
        });
      }
    }),
});

const verificationRunEventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateType: z.literal("WORK_ITEM"),
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const verificationRunReservedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_RUN_RESERVED"),
  data: z
    .object({ run: verificationRunSchema, checks: z.array(verificationCheckSchema).min(1).max(12) })
    .strict(),
});

export const verificationCheckStartedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CHECK_STARTED"),
  data: z.object({ run: verificationRunSchema, check: verificationCheckSchema }).strict(),
});

export const verificationCheckCompletedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CHECK_COMPLETED"),
  data: z.object({ run: verificationRunSchema, check: verificationCheckSchema }).strict(),
});

export const verificationRunInterruptedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_RUN_INTERRUPTED"),
  data: z
    .object({ run: verificationRunSchema, interruptedCheck: verificationCheckSchema.nullable() })
    .strict(),
});

export const verificationFailureRecordedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_FAILURE_RECORDED"),
  data: z.object({ failure: verificationFailureSchema }).strict(),
});

export const verificationCorrectionStartedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CORRECTION_STARTED"),
  data: z.object({ correctionRun: verificationCorrectionRunSchema }).strict(),
});

export const verificationCorrectionPassedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CORRECTION_PASSED"),
  data: z.object({ correctionRun: verificationCorrectionRunSchema }).strict(),
});

export const verificationCorrectionSupersededEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CORRECTION_SUPERSEDED"),
  data: z.object({ correctionRun: verificationCorrectionRunSchema }).strict(),
});

export const verificationCorrectionExhaustedEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CORRECTION_EXHAUSTED"),
  data: z.object({ correctionRun: verificationCorrectionRunSchema, canAuthorizeFinal: z.boolean() }).strict(),
});

export const verificationCorrectionCancelledEventSchema = verificationRunEventBaseSchema.extend({
  type: z.literal("VERIFICATION_CORRECTION_CANCELLED"),
  data: z.object({ correctionRun: verificationCorrectionRunSchema }).strict(),
});

export const verificationRunReservedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_RUN_RESERVED"),
    run: verificationRunSchema,
    checks: z.array(verificationCheckSchema).min(1).max(12),
    event: verificationRunReservedEventSchema,
  })
  .strict();

export const verificationCheckStartedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_CHECK_STARTED"),
    run: verificationRunSchema,
    check: verificationCheckSchema,
    event: verificationCheckStartedEventSchema,
  })
  .strict();

export const verificationCheckCompletedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_CHECK_COMPLETED"),
    run: verificationRunSchema,
    check: verificationCheckSchema,
    next: z.enum(["START_NEXT_CHECK", "TERMINAL"]),
    event: verificationCheckCompletedEventSchema,
  })
  .strict();

export const verificationRunInterruptedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_RUN_INTERRUPTED"),
    run: verificationRunSchema,
    interruptedCheck: verificationCheckSchema.nullable(),
    event: verificationRunInterruptedEventSchema,
  })
  .strict();

export const verificationOutputRetentionRecordedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("VERIFICATION_OUTPUT_RETENTION_RECORDED"),
    artifactId: opaqueIdSchema,
    outcome: verificationOutputRetentionOutcomeSchema,
    recordedAt: utcTimestampSchema,
  })
  .strict();

export const verificationRunSnapshotResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    run: verificationRunSchema,
    plan: verificationPlanSchema,
    checks: z.array(verificationCheckSchema).min(1).max(12),
    freshness: verificationRunFreshnessSchema,
    staleReasons: z.array(verificationRunStaleReasonSchema).max(4),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.plan.id !== snapshot.run.planId ||
      snapshot.plan.projectId !== snapshot.run.projectId ||
      snapshot.plan.revision !== snapshot.run.planRevision ||
      snapshot.plan.contentHash !== snapshot.run.planContentHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "A verification snapshot must carry the exact Plan reserved by its Run",
      });
    }
    if (
      snapshot.checks.some(
        (check) =>
          check.runId !== snapshot.run.id ||
          check.projectId !== snapshot.run.projectId ||
          check.workItemId !== snapshot.run.workItemId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Verification Checks cannot cross Run identities",
      });
    }
    const ordinals = snapshot.checks.map((check) => check.ordinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({ code: "custom", path: ["checks"], message: "Check ordinals must be unique" });
    }
    if (
      (snapshot.freshness === "CURRENT" && snapshot.staleReasons.length !== 0) ||
      (snapshot.freshness === "STALE" && snapshot.staleReasons.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "Verification freshness must match its reasons",
      });
    }
  });

export const verificationRunsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    runs: z.array(verificationRunSnapshotResponseSchema).max(100),
    failures: z.array(verificationFailureSchema).max(100),
    correctionRuns: z.array(verificationCorrectionRunSchema).max(100),
  })
  .strict();

export type VerificationRecipeKind = z.infer<typeof verificationRecipeKindSchema>;
export type VerificationExecutable = z.infer<typeof verificationExecutableSchema>;
export type VerificationNetworkPolicy = z.infer<typeof verificationNetworkPolicySchema>;
export type VerificationScriptName = z.infer<typeof verificationScriptNameSchema>;
export type VerificationRecipe = z.infer<typeof verificationRecipeSchema>;
export type VerificationProposalWarning = z.infer<typeof verificationProposalWarningSchema>;
export type VerificationPlanTarget = z.infer<typeof verificationPlanTargetSchema>;
export type VerificationPlanProposal = z.infer<typeof verificationPlanProposalSchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type VerificationPlanPublication = z.infer<typeof verificationPlanPublicationSchema>;
export type AdoptVerificationPlanCommand = z.infer<typeof adoptVerificationPlanCommandSchema>;
export type DisableVerificationPlanCommand = z.infer<typeof disableVerificationPlanCommandSchema>;
export type CompleteVerificationPlanPublicationCommand = z.infer<
  typeof completeVerificationPlanPublicationCommandSchema
>;
export type FailVerificationPlanPublicationCommand = z.infer<
  typeof failVerificationPlanPublicationCommandSchema
>;
export type RetryVerificationPlanPublicationCommand = z.infer<
  typeof retryVerificationPlanPublicationCommandSchema
>;
export type StartVerificationRunCommand = z.infer<typeof startVerificationRunCommandSchema>;
export type RetryVerificationRunCommand = z.infer<typeof retryVerificationRunCommandSchema>;
export type MaterializeStaleVerificationFailureCommand = z.infer<
  typeof materializeStaleVerificationFailureCommandSchema
>;
export type StartVerificationCheckCommand = z.infer<typeof startVerificationCheckCommandSchema>;
export type CompleteVerificationCheckCommand = z.infer<typeof completeVerificationCheckCommandSchema>;
export type CancelVerificationRunCommand = z.infer<typeof cancelVerificationRunCommandSchema>;
export type InterruptVerificationRunCommand = z.infer<typeof interruptVerificationRunCommandSchema>;
export type RecordVerificationOutputRetentionCommand = z.infer<
  typeof recordVerificationOutputRetentionCommandSchema
>;
export type ResolveVerificationCorrectionGateCommand = z.infer<
  typeof resolveVerificationCorrectionGateCommandSchema
>;
export type ResolveVerificationCorrectionGateRequest = z.infer<
  typeof resolveVerificationCorrectionGateRequestSchema
>;
export type VerificationCorrectionGateAction = z.infer<typeof verificationCorrectionGateActionSchema>;
export type VerificationPlanAdoptedEvent = z.infer<typeof verificationPlanAdoptedEventSchema>;
export type VerificationPlanAdoptedResult = z.infer<typeof verificationPlanAdoptedResultSchema>;
export type VerificationPlanDisabledEvent = z.infer<typeof verificationPlanDisabledEventSchema>;
export type VerificationPlanDisabledResult = z.infer<typeof verificationPlanDisabledResultSchema>;
export type VerificationPlanSettingsResponse = z.infer<typeof verificationPlanSettingsResponseSchema>;
export type VerificationPlatform = z.infer<typeof verificationPlatformSchema>;
export type VerificationRunStatus = z.infer<typeof verificationRunStatusSchema>;
export type VerificationCheckStatus = z.infer<typeof verificationCheckStatusSchema>;
export type VerificationCheckErrorCode = z.infer<typeof verificationCheckErrorCodeSchema>;
export type VerificationRunTerminalReason = z.infer<typeof verificationRunTerminalReasonSchema>;
export type VerificationRunFreshness = z.infer<typeof verificationRunFreshnessSchema>;
export type VerificationRunStaleReason = z.infer<typeof verificationRunStaleReasonSchema>;
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;
export type VerificationOutputSummary = z.infer<typeof verificationOutputSummarySchema>;
export type VerificationOutputRetentionOutcome = z.infer<typeof verificationOutputRetentionOutcomeSchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationRun = z.infer<typeof verificationRunSchema>;
export type VerificationFailureReason = z.infer<typeof verificationFailureReasonSchema>;
export type VerificationFailure = z.infer<typeof verificationFailureSchema>;
export type VerificationCorrectionRunStatus = z.infer<typeof verificationCorrectionRunStatusSchema>;
export type VerificationCorrectionRun = z.infer<typeof verificationCorrectionRunSchema>;
export type VerificationFailureRecordedEvent = z.infer<typeof verificationFailureRecordedEventSchema>;
export type VerificationCorrectionStartedEvent = z.infer<typeof verificationCorrectionStartedEventSchema>;
export type VerificationCorrectionPassedEvent = z.infer<typeof verificationCorrectionPassedEventSchema>;
export type VerificationCorrectionSupersededEvent = z.infer<
  typeof verificationCorrectionSupersededEventSchema
>;
export type VerificationCorrectionExhaustedEvent = z.infer<typeof verificationCorrectionExhaustedEventSchema>;
export type VerificationCorrectionCancelledEvent = z.infer<typeof verificationCorrectionCancelledEventSchema>;
export type VerificationCheckObservation = z.infer<typeof verificationCheckObservationSchema>;
export type VerificationRunSnapshotResponse = z.infer<typeof verificationRunSnapshotResponseSchema>;
export type VerificationRunsResponse = z.infer<typeof verificationRunsResponseSchema>;
