import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const readinessCategorySchema = z.enum(["SECURITY", "LEGAL", "PAYMENTS", "ANALYTICS"]);
export const readinessCheckModeSchema = z.enum(["AUTOMATED", "OWNER"]);
export const readinessCheckStatusSchema = z.enum([
  "PASSED",
  "ACTION_REQUIRED",
  "CONFIRMED",
  "NOT_APPLICABLE",
]);
export const projectReadinessStatusSchema = z.enum(["ACTION_REQUIRED", "READY"]);
export const readinessAttestationOutcomeSchema = z.enum(["CONFIRMED", "NOT_APPLICABLE"]);

export const readinessCheckKeySchema = z.enum([
  "SECURITY_ACTIVE_CONSTITUTION",
  "SECURITY_SECRET_PATHS",
  "SECURITY_ENV_IGNORED",
  "SECURITY_CI_HARDENING",
  "LEGAL_LICENSE",
  "LEGAL_OWNER_REVIEW",
  "PAYMENTS_OWNER_REVIEW",
  "ANALYTICS_OWNER_REVIEW",
]);

export const securityFindingSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export const securityFindingCodeSchema = z.enum([
  "ACTIVE_CONSTITUTION_MISSING",
  "TRACKED_SECRET_PATH",
  "ENV_NOT_IGNORED",
  "CI_PULL_REQUEST_TARGET",
  "CI_WRITE_ALL_PERMISSIONS",
  "CI_ACTION_NOT_PINNED",
  "CI_INPUT_UNVERIFIABLE",
  "LICENSE_MISSING",
]);

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const gitHeadSchema = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/)
  .nullable();

export const securityFindingDraftSchema = z
  .object({
    code: securityFindingCodeSchema,
    severity: securityFindingSeveritySchema,
    path: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();

export const readinessCheckDraftSchema = z
  .object({
    key: readinessCheckKeySchema,
    category: readinessCategorySchema,
    mode: readinessCheckModeSchema,
    status: z.enum(["PASSED", "ACTION_REQUIRED"]),
    summary: z.string().min(1).max(500),
    findings: z.array(securityFindingDraftSchema).max(128),
  })
  .strict();

export const projectReadinessRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    repositoryHead: gitHeadSchema,
    sourceDigest: digestSchema,
    workingTreeDirty: z.boolean(),
    status: projectReadinessStatusSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .strict();

export const readinessCheckSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    runId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    key: readinessCheckKeySchema,
    category: readinessCategorySchema,
    mode: readinessCheckModeSchema,
    status: readinessCheckStatusSchema,
    summary: z.string().min(1).max(500),
    version: z.number().int().positive(),
  })
  .strict();

export const securityFindingSchema = securityFindingDraftSchema.extend({
  schemaVersion: schemaVersionSchema,
  id: opaqueIdSchema,
  runId: opaqueIdSchema,
  checkId: opaqueIdSchema,
  projectId: opaqueIdSchema,
});

export const readinessAttestationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    runId: opaqueIdSchema,
    checkId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    outcome: readinessAttestationOutcomeSchema,
    rationale: z.string().trim().min(1).max(2_000),
    actor: actorSchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const projectReadinessSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    run: projectReadinessRunSchema.nullable(),
    checks: z.array(readinessCheckSchema).max(8),
    findings: z.array(securityFindingSchema).max(1_024),
    attestations: z.array(readinessAttestationSchema).max(1_024),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.run === null &&
      (snapshot.checks.length > 0 || snapshot.findings.length > 0 || snapshot.attestations.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "An empty readiness snapshot cannot contain child records",
      });
    }
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

export const projectReadinessAssessedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_READINESS_ASSESSED"),
  data: z
    .object({
      run: projectReadinessRunSchema,
      checks: z.array(readinessCheckSchema).length(8),
      findings: z.array(securityFindingSchema).max(1_024),
    })
    .strict(),
});

export const projectReadinessAttestedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_READINESS_ATTESTED"),
  data: z
    .object({
      run: projectReadinessRunSchema,
      check: readinessCheckSchema,
      attestation: readinessAttestationSchema,
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

export const recordProjectReadinessAssessmentCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_PROJECT_READINESS_ASSESSMENT"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      repositoryHead: gitHeadSchema,
      sourceDigest: digestSchema,
      workingTreeDirty: z.boolean(),
      checks: z.array(readinessCheckDraftSchema).length(8),
    })
    .strict(),
});

export const attestProjectReadinessCheckCommandSchema = commandBaseSchema.extend({
  type: z.literal("ATTEST_PROJECT_READINESS_CHECK"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      runId: opaqueIdSchema,
      checkId: opaqueIdSchema,
      expectedRunVersion: z.number().int().positive(),
      outcome: readinessAttestationOutcomeSchema,
      rationale: z.string().trim().min(1).max(2_000),
    })
    .strict(),
});

const commandResultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
  })
  .strict();

export const projectReadinessAssessedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("PROJECT_READINESS_ASSESSED"),
  run: projectReadinessRunSchema,
  checks: z.array(readinessCheckSchema).length(8),
  findings: z.array(securityFindingSchema).max(1_024),
});

export const projectReadinessAttestedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("PROJECT_READINESS_ATTESTED"),
  run: projectReadinessRunSchema,
  check: readinessCheckSchema,
  attestation: readinessAttestationSchema,
});

export const runProjectReadinessRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
  })
  .strict();

export const attestProjectReadinessRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    runId: opaqueIdSchema,
    checkId: opaqueIdSchema,
    expectedRunVersion: z.number().int().positive(),
    outcome: readinessAttestationOutcomeSchema,
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ReadinessCategory = z.infer<typeof readinessCategorySchema>;
export type ReadinessCheckMode = z.infer<typeof readinessCheckModeSchema>;
export type ReadinessCheckStatus = z.infer<typeof readinessCheckStatusSchema>;
export type ReadinessAttestationOutcome = z.infer<typeof readinessAttestationOutcomeSchema>;
export type ReadinessCheckKey = z.infer<typeof readinessCheckKeySchema>;
export type ReadinessCheckDraft = z.infer<typeof readinessCheckDraftSchema>;
export type SecurityFindingDraft = z.infer<typeof securityFindingDraftSchema>;
export type ProjectReadinessRun = z.infer<typeof projectReadinessRunSchema>;
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;
export type ReadinessAttestation = z.infer<typeof readinessAttestationSchema>;
export type ProjectReadinessSnapshot = z.infer<typeof projectReadinessSnapshotSchema>;
export type ProjectReadinessAssessedEvent = z.infer<typeof projectReadinessAssessedEventSchema>;
export type ProjectReadinessAttestedEvent = z.infer<typeof projectReadinessAttestedEventSchema>;
export type RecordProjectReadinessAssessmentCommand = z.infer<
  typeof recordProjectReadinessAssessmentCommandSchema
>;
export type AttestProjectReadinessCheckCommand = z.infer<typeof attestProjectReadinessCheckCommandSchema>;
export type ProjectReadinessAssessedResult = z.infer<typeof projectReadinessAssessedResultSchema>;
export type ProjectReadinessAttestedResult = z.infer<typeof projectReadinessAttestedResultSchema>;
export type RunProjectReadinessRequest = z.infer<typeof runProjectReadinessRequestSchema>;
export type AttestProjectReadinessRequest = z.infer<typeof attestProjectReadinessRequestSchema>;
