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

export const retryVerificationPlanPublicationRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    publicationId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

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
export type CompleteVerificationPlanPublicationCommand = z.infer<
  typeof completeVerificationPlanPublicationCommandSchema
>;
export type FailVerificationPlanPublicationCommand = z.infer<
  typeof failVerificationPlanPublicationCommandSchema
>;
export type RetryVerificationPlanPublicationCommand = z.infer<
  typeof retryVerificationPlanPublicationCommandSchema
>;
export type VerificationPlanAdoptedEvent = z.infer<typeof verificationPlanAdoptedEventSchema>;
export type VerificationPlanAdoptedResult = z.infer<typeof verificationPlanAdoptedResultSchema>;
export type VerificationPlanSettingsResponse = z.infer<typeof verificationPlanSettingsResponseSchema>;
