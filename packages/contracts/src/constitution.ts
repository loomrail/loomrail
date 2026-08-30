import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const constitutionPresetIdSchema = z.enum([
  "repository-baseline",
  "typescript-node",
  "typescript-pnpm-workspace",
]);

export const constitutionPresetSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: constitutionPresetIdSchema,
    version: z.literal(1),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
  })
  .strict();

export const constitutionPresetsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    presets: z.array(constitutionPresetSchema).length(3),
  })
  .strict();

export const repositoryScanFileKindSchema = z.enum([
  "AGENT_INSTRUCTIONS",
  "README",
  "CONSTITUTION",
  "PACKAGE_MANIFEST",
  "WORKSPACE_MANIFEST",
  "PACKAGE_MANAGER_MARKER",
  "TOOL_CONFIG",
  "CI_WORKFLOW",
  "ARCHITECTURE_DOCUMENT",
]);

export const repositoryScanFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    kind: repositoryScanFileKindSchema,
    bytes: z.number().int().nonnegative().max(1_000_000_000),
    // Presence-only markers such as lockfiles are not read, so there is deliberately no digest.
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

export const repositoryScanWarningCodeSchema = z.enum([
  "CANDIDATE_LIMIT_REACHED",
  "TOTAL_BYTES_LIMIT_REACHED",
  "FILE_TOO_LARGE",
  "SYMLINK_SKIPPED",
  "FILE_UNREADABLE",
  "MANIFEST_INVALID",
  "SCRIPT_NAME_UNSAFE",
]);

export const repositoryScanWarningSchema = z
  .object({
    code: repositoryScanWarningCodeSchema,
    path: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();

export const packageManagerSchema = z.enum(["PNPM", "NPM", "YARN", "BUN", "UNKNOWN"]);
export const repositoryLanguageSchema = z.enum(["TYPESCRIPT", "JAVASCRIPT"]);

export const discoveredVerificationCommandSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/),
    argv: z.array(z.string().min(1).max(120)).min(2).max(4),
    sourcePath: z.literal("package.json"),
  })
  .strict();

export const scannedConstitutionTargetSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ABSENT"), digest: z.null() }).strict(),
  z
    .object({
      state: z.literal("PRESENT"),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ state: z.literal("BLOCKED"), digest: z.null() }).strict(),
]);

export const repositoryScanSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    targetConstitution: scannedConstitutionTargetSchema,
    files: z.array(repositoryScanFileSchema).max(128),
    warnings: z.array(repositoryScanWarningSchema).max(128),
    packageManager: packageManagerSchema,
    languages: z.array(repositoryLanguageSchema).max(2),
    workspace: z.boolean(),
    verificationCommands: z.array(discoveredVerificationCommandSchema).max(64),
    instructionPaths: z.array(z.string().min(1).max(500)).max(16),
    architecturePaths: z.array(z.string().min(1).max(500)).max(64),
    ciPaths: z.array(z.string().min(1).max(500)).max(32),
    configPaths: z.array(z.string().min(1).max(500)).max(64),
  })
  .strict();

export const constitutionSectionKeySchema = z.enum([
  "PRODUCT_CONTEXT",
  "ARCHITECTURE",
  "CODE_STANDARDS",
  "AGENT_POLICIES",
  "DEFINITION_OF_DONE",
  "ROLE_PLAYBOOKS",
  "LEARNED_CONVENTIONS",
]);

export const constitutionSourceKindSchema = z.enum(["PRESET", "REPOSITORY", "SCANNER"]);

export const constitutionSourceSchema = z
  .object({
    kind: constitutionSourceKindSchema,
    reference: z.string().min(1).max(500),
    label: z.string().min(1).max(500),
  })
  .strict();

export const constitutionSectionSchema = z
  .object({
    key: constitutionSectionKeySchema,
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(20_000),
    sources: z.array(constitutionSourceSchema).min(1).max(128),
  })
  .strict();

export const constitutionProposalStatusSchema = z.enum(["PROPOSED", "ADOPTION_REQUESTED", "ADOPTED"]);

export const constitutionProposalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    status: constitutionProposalStatusSchema,
    presetId: constitutionPresetIdSchema,
    presetVersion: z.literal(1),
    recommendedPresetId: constitutionPresetIdSchema,
    scan: repositoryScanSchema,
    sections: z.array(constitutionSectionSchema).length(7),
    renderedMarkdown: z.string().min(1).max(100_000),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    adoptedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const projectConstitutionStatusSchema = z.enum(["PUBLISHING", "ACTIVE", "SUPERSEDED", "FAILED"]);

export const projectConstitutionVersionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    proposalId: opaqueIdSchema,
    ordinal: z.number().int().positive(),
    presetId: constitutionPresetIdSchema,
    presetVersion: z.literal(1),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    renderedMarkdown: z.string().min(1).max(100_000),
    status: projectConstitutionStatusSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    activatedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const constitutionPublicationStatusSchema = z.enum(["PENDING", "APPLIED", "FAILED"]);
export const constitutionPublicationErrorCodeSchema = z.enum([
  "CONSTITUTION_TARGET_CHANGED",
  "CONSTITUTION_TARGET_OUTSIDE_REPOSITORY",
  "CONSTITUTION_TARGET_UNREADABLE",
  "CONSTITUTION_WRITE_FAILED",
  "REPOSITORY_UNAVAILABLE",
]);

export const constitutionPublicationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    constitutionVersionId: opaqueIdSchema,
    targetPath: z.literal(".loomrail/constitution.md"),
    expectedTargetDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    status: constitutionPublicationStatusSchema,
    attempts: z.number().int().nonnegative(),
    lastErrorCode: constitutionPublicationErrorCodeSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    appliedAt: utcTimestampSchema.nullable(),
  })
  .strict();

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

export const projectConstitutionProposedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PROPOSED"),
  data: z.object({ proposal: constitutionProposalSchema }).strict(),
});

export const projectConstitutionPublicationRequestedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PUBLICATION_REQUESTED"),
  data: z
    .object({
      proposal: constitutionProposalSchema,
      constitution: projectConstitutionVersionSchema,
      publication: constitutionPublicationSchema,
    })
    .strict(),
});

export const projectConstitutionActivatedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_ACTIVATED"),
  data: z
    .object({
      proposal: constitutionProposalSchema,
      constitution: projectConstitutionVersionSchema,
      publication: constitutionPublicationSchema,
    })
    .strict(),
});

export const projectConstitutionPublicationFailedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PUBLICATION_FAILED"),
  data: z
    .object({
      constitution: projectConstitutionVersionSchema,
      publication: constitutionPublicationSchema,
    })
    .strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const proposeProjectConstitutionCommandSchema = commandBaseSchema.extend({
  type: z.literal("PROPOSE_PROJECT_CONSTITUTION"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      presetId: constitutionPresetIdSchema,
      recommendedPresetId: constitutionPresetIdSchema,
      scan: repositoryScanSchema,
      sections: z.array(constitutionSectionSchema).length(7),
      renderedMarkdown: z.string().min(1).max(100_000),
      contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
});

export const requestProjectConstitutionAdoptionCommandSchema = commandBaseSchema.extend({
  type: z.literal("REQUEST_PROJECT_CONSTITUTION_ADOPTION"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      proposalId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      expectedProposalVersion: z.number().int().positive(),
    })
    .strict(),
});

export const completeProjectConstitutionPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("COMPLETE_PROJECT_CONSTITUTION_PUBLICATION"),
  payload: z
    .object({
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

export const failProjectConstitutionPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("FAIL_PROJECT_CONSTITUTION_PUBLICATION"),
  payload: z
    .object({
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      errorCode: constitutionPublicationErrorCodeSchema,
    })
    .strict(),
});

export const retryProjectConstitutionPublicationCommandSchema = commandBaseSchema.extend({
  type: z.literal("RETRY_PROJECT_CONSTITUTION_PUBLICATION"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      publicationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

const resultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
  })
  .strict();

export const projectConstitutionProposedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PROPOSED"),
  proposal: constitutionProposalSchema,
  event: projectConstitutionProposedEventSchema,
});

export const projectConstitutionPublicationRequestedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PUBLICATION_REQUESTED"),
  proposal: constitutionProposalSchema,
  constitution: projectConstitutionVersionSchema,
  publication: constitutionPublicationSchema,
  event: projectConstitutionPublicationRequestedEventSchema,
});

export const projectConstitutionActivatedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_ACTIVATED"),
  proposal: constitutionProposalSchema,
  constitution: projectConstitutionVersionSchema,
  publication: constitutionPublicationSchema,
  event: projectConstitutionActivatedEventSchema,
});

export const projectConstitutionPublicationFailedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PUBLICATION_FAILED"),
  constitution: projectConstitutionVersionSchema,
  publication: constitutionPublicationSchema,
  event: projectConstitutionPublicationFailedEventSchema,
});

export const projectConstitutionPublicationRetriedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_CONSTITUTION_PUBLICATION_RETRIED"),
  constitution: projectConstitutionVersionSchema,
  publication: constitutionPublicationSchema,
  event: projectConstitutionPublicationRequestedEventSchema,
});

export const scanProjectConstitutionRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    presetId: constitutionPresetIdSchema.optional(),
  })
  .strict();

export const adoptProjectConstitutionRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    proposalId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    expectedProposalVersion: z.number().int().positive(),
  })
  .strict();

export const retryProjectConstitutionPublicationRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    publicationId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const projectConstitutionSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    latestProposal: constitutionProposalSchema.nullable(),
    activeConstitution: projectConstitutionVersionSchema.nullable(),
    pendingConstitution: projectConstitutionVersionSchema.nullable(),
    publication: constitutionPublicationSchema.nullable(),
  })
  .strict();

export type ConstitutionPresetId = z.infer<typeof constitutionPresetIdSchema>;
export type ConstitutionPreset = z.infer<typeof constitutionPresetSchema>;
export type RepositoryScan = z.infer<typeof repositoryScanSchema>;
export type RepositoryScanWarning = z.infer<typeof repositoryScanWarningSchema>;
export type ConstitutionSection = z.infer<typeof constitutionSectionSchema>;
export type ConstitutionProposal = z.infer<typeof constitutionProposalSchema>;
export type ProjectConstitutionVersion = z.infer<typeof projectConstitutionVersionSchema>;
export type ConstitutionPublication = z.infer<typeof constitutionPublicationSchema>;
export type ConstitutionPublicationErrorCode = z.infer<typeof constitutionPublicationErrorCodeSchema>;
export type ProjectConstitutionSnapshot = z.infer<typeof projectConstitutionSnapshotSchema>;
export type ProposeProjectConstitutionCommand = z.infer<typeof proposeProjectConstitutionCommandSchema>;
export type RequestProjectConstitutionAdoptionCommand = z.infer<
  typeof requestProjectConstitutionAdoptionCommandSchema
>;
export type CompleteProjectConstitutionPublicationCommand = z.infer<
  typeof completeProjectConstitutionPublicationCommandSchema
>;
export type FailProjectConstitutionPublicationCommand = z.infer<
  typeof failProjectConstitutionPublicationCommandSchema
>;
export type RetryProjectConstitutionPublicationCommand = z.infer<
  typeof retryProjectConstitutionPublicationCommandSchema
>;
export type ProjectConstitutionProposedEvent = z.infer<typeof projectConstitutionProposedEventSchema>;
export type ProjectConstitutionPublicationRequestedEvent = z.infer<
  typeof projectConstitutionPublicationRequestedEventSchema
>;
export type ProjectConstitutionActivatedEvent = z.infer<typeof projectConstitutionActivatedEventSchema>;
export type ProjectConstitutionPublicationFailedEvent = z.infer<
  typeof projectConstitutionPublicationFailedEventSchema
>;
