import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { launchReleaseFreshnessSchema } from "./launch-release.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const containsForbiddenRefControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
};

export const githubRepositorySlugSchema = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u);

export const deploymentBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value === value.normalize("NFC") &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !containsForbiddenRefControl(value) &&
      !/[~^:?*[\\]/u.test(value),
    "The deployment branch must be one portable Git ref name",
  );

export const githubActionsDeploymentTargetSchema = z
  .object({
    presetId: z.literal("GITHUB_ACTIONS_WORKFLOW_V1"),
    presetRevision: z.literal(1),
    repositorySlug: githubRepositorySlugSchema,
    branch: deploymentBranchSchema,
    commitSha: commitShaSchema,
    workflowPath: z.literal(".github/workflows/deploy-production.yml"),
    workflowContentHash: sha256Schema,
    argvDigest: sha256Schema,
    dispatchTimeoutSeconds: z.literal(30),
    observeTimeoutSeconds: z.literal(15),
    outputLimitBytes: z.literal(32_768),
    observeOutputLimitBytes: z.literal(65_536),
  })
  .strict();

export const deploymentIntentSchema = z.literal("STANDARD");
export const deploymentStatusSchema = z.enum([
  "PENDING_APPROVAL",
  "APPROVED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);
export const deploymentFailureCodeSchema = z.enum([
  "DISPATCH_OUTCOME_UNKNOWN",
  "DAEMON_RESTARTED",
  "REMOTE_FAILURE",
  "REMOTE_CANCELLED",
  "REMOTE_TIMED_OUT",
  "REMOTE_ACTION_REQUIRED",
  "OBSERVATION_INVALID",
  "PRECONDITION_CHANGED",
]);
export const deploymentPreflightFailureCodeSchema = z.enum([
  "RELEASE_STALE",
  "RELEASE_GATES_BLOCKED",
  "ENVIRONMENT_UNSUPPORTED",
  "REPOSITORY_UNAVAILABLE",
  "REPOSITORY_PATH_NOT_CANONICAL",
  "REPOSITORY_OPERATION_IN_PROGRESS",
  "SOURCE_DIRTY",
  "DETACHED_HEAD",
  "REMOTE_INVALID",
  "WORKFLOW_MISSING",
  "WORKFLOW_NOT_REGULAR",
  "WORKFLOW_TRIGGER_MISSING",
  "WORKFLOW_TOO_LARGE",
  "CLI_UNAVAILABLE",
  "AUTH_REQUIRED",
  "REMOTE_BRANCH_UNAVAILABLE",
  "REMOTE_COMMIT_MISMATCH",
]);

export const deploymentPlanSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    revision: z.literal(1),
    releaseId: opaqueIdSchema,
    releaseContentHash: sha256Schema,
    environmentId: opaqueIdSchema,
    environmentContentHash: sha256Schema,
    target: githubActionsDeploymentTargetSchema,
    contentHash: sha256Schema,
    createdAt: utcTimestampSchema,
  })
  .strict();

const remoteRunIdentityShape = {
  remoteRunId: z.number().int().positive(),
  remoteRunUrl: z
    .url()
    .max(2_048)
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/u),
};

export const deploymentSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    planId: opaqueIdSchema,
    planRevision: z.literal(1),
    planContentHash: sha256Schema,
    releaseId: opaqueIdSchema,
    releaseContentHash: sha256Schema,
    environmentId: opaqueIdSchema,
    environmentContentHash: sha256Schema,
    intent: deploymentIntentSchema,
    approvalDigest: sha256Schema,
    status: deploymentStatusSchema,
    approvalId: opaqueIdSchema.nullable(),
    remoteRunId: remoteRunIdentityShape.remoteRunId.nullable(),
    remoteRunUrl: remoteRunIdentityShape.remoteRunUrl.nullable(),
    failureCode: deploymentFailureCodeSchema.nullable(),
    createdAt: utcTimestampSchema,
    approvedAt: utcTimestampSchema.nullable(),
    startedAt: utcTimestampSchema.nullable(),
    completedAt: utcTimestampSchema.nullable(),
    observedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((deployment, context) => {
    if ((deployment.remoteRunId === null) !== (deployment.remoteRunUrl === null)) {
      context.addIssue({ code: "custom", message: "Remote run id and URL must be supplied together" });
    }
    if ((deployment.approvalId === null) !== (deployment.approvedAt === null)) {
      context.addIssue({ code: "custom", message: "Approval id and timestamp must be supplied together" });
    }
    if (deployment.status === "PENDING_APPROVAL" && deployment.approvalId !== null) {
      context.addIssue({ code: "custom", message: "A pending Deployment cannot carry an Approval" });
    }
    if (
      deployment.status === "PENDING_APPROVAL" &&
      [
        deployment.startedAt,
        deployment.completedAt,
        deployment.observedAt,
        deployment.failureCode,
        deployment.remoteRunId,
      ].some((value) => value !== null)
    ) {
      context.addIssue({ code: "custom", message: "A pending Deployment cannot carry execution state" });
    }
    if (["APPROVED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(deployment.status)) {
      if (deployment.approvalId === null) {
        context.addIssue({ code: "custom", message: "An approved Deployment must carry its Approval" });
      }
    }
    if (["RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(deployment.status)) {
      if (deployment.startedAt === null) {
        context.addIssue({ code: "custom", message: "A started Deployment must carry startedAt" });
      }
    }
    if (
      deployment.status === "APPROVED" &&
      [
        deployment.startedAt,
        deployment.completedAt,
        deployment.observedAt,
        deployment.failureCode,
        deployment.remoteRunId,
      ].some((value) => value !== null)
    ) {
      context.addIssue({ code: "custom", message: "An approved Deployment cannot carry execution state" });
    }
    if (
      deployment.status === "RUNNING" &&
      (deployment.completedAt !== null || deployment.failureCode !== null)
    ) {
      context.addIssue({ code: "custom", message: "A running Deployment cannot carry a terminal outcome" });
    }
    if (["SUCCEEDED", "FAILED"].includes(deployment.status) && deployment.completedAt === null) {
      context.addIssue({ code: "custom", message: "A terminal Deployment must carry completedAt" });
    }
    if (["SUCCEEDED", "FAILED", "UNKNOWN"].includes(deployment.status) && deployment.observedAt === null) {
      context.addIssue({ code: "custom", message: "A settled Deployment must carry observedAt" });
    }
    if (deployment.status === "UNKNOWN" && deployment.completedAt !== null) {
      context.addIssue({ code: "custom", message: "An unknown Deployment cannot claim completion" });
    }
    if (deployment.status === "SUCCEEDED" && deployment.remoteRunId === null) {
      context.addIssue({ code: "custom", message: "A successful Deployment requires an exact remote run" });
    }
    if (deployment.status === "SUCCEEDED" && deployment.failureCode !== null) {
      context.addIssue({ code: "custom", message: "A successful Deployment cannot carry failureCode" });
    }
    if (["FAILED", "UNKNOWN"].includes(deployment.status) && deployment.failureCode === null) {
      context.addIssue({ code: "custom", message: "Failed or unknown Deployment requires failureCode" });
    }
  });

export const deploymentApprovalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    deploymentId: opaqueIdSchema,
    approvalDigest: sha256Schema,
    actorId: opaqueIdSchema,
    createdAt: utcTimestampSchema,
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

export const adoptDeploymentPlanCommandSchema = commandBaseSchema.extend({
  type: z.literal("ADOPT_DEPLOYMENT_PLAN"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      releaseId: opaqueIdSchema,
      expectedReleaseContentHash: sha256Schema,
      releaseFreshness: launchReleaseFreshnessSchema,
      target: githubActionsDeploymentTargetSchema,
    })
    .strict(),
});

export const approveDeploymentCommandSchema = commandBaseSchema.extend({
  type: z.literal("APPROVE_DEPLOYMENT"),
  payload: z
    .object({
      deploymentId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      approvalDigest: sha256Schema,
    })
    .strict(),
});

export const startDeploymentCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_DEPLOYMENT"),
  payload: z.object({ deploymentId: opaqueIdSchema, expectedVersion: z.number().int().positive() }).strict(),
});

export const deploymentDispatchOutcomeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("DISPATCHED"),
      runId: remoteRunIdentityShape.remoteRunId,
      runUrl: remoteRunIdentityShape.remoteRunUrl,
    })
    .strict(),
  z.object({ type: z.literal("UNKNOWN") }).strict(),
  z.object({ type: z.literal("REFUSED") }).strict(),
]);

export const recordDeploymentDispatchCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_DEPLOYMENT_DISPATCH"),
  payload: z
    .object({
      deploymentId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      outcome: deploymentDispatchOutcomeSchema,
    })
    .strict(),
});

export const deploymentObservationOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RUNNING") }).strict(),
  z.object({ type: z.literal("SUCCEEDED") }).strict(),
  z
    .object({
      type: z.literal("FAILED"),
      failureCode: z.enum([
        "REMOTE_FAILURE",
        "REMOTE_CANCELLED",
        "REMOTE_TIMED_OUT",
        "REMOTE_ACTION_REQUIRED",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("UNKNOWN") }).strict(),
]);

export const recordDeploymentObservationCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_DEPLOYMENT_OBSERVATION"),
  payload: z
    .object({
      deploymentId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      observedRunId: remoteRunIdentityShape.remoteRunId,
      outcome: deploymentObservationOutcomeSchema,
    })
    .strict(),
});

export const reconcileDeploymentCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECONCILE_DEPLOYMENT"),
  payload: z.object({ deploymentId: opaqueIdSchema, expectedVersion: z.number().int().positive() }).strict(),
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

export const deploymentPlanAdoptedEventSchema = eventBaseSchema.extend({
  type: z.literal("DEPLOYMENT_PLAN_ADOPTED"),
  data: z.object({ plan: deploymentPlanSchema, deployment: deploymentSchema }).strict(),
});

export const deploymentChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("DEPLOYMENT_CHANGED"),
  data: z.object({ deployment: deploymentSchema }).strict(),
});

const resultBaseSchema = z.object({ schemaVersion: schemaVersionSchema, replayed: z.boolean() }).strict();
export const deploymentPlanAdoptedResultSchema = resultBaseSchema.extend({
  type: z.literal("DEPLOYMENT_PLAN_ADOPTED"),
  plan: deploymentPlanSchema,
  deployment: deploymentSchema,
  projectVersion: z.number().int().positive(),
  event: deploymentPlanAdoptedEventSchema,
});
export const deploymentChangedResultSchema = resultBaseSchema.extend({
  type: z.literal("DEPLOYMENT_CHANGED"),
  deployment: deploymentSchema,
  approval: deploymentApprovalSchema.nullable(),
  event: deploymentChangedEventSchema,
});

export const adoptDeploymentPlanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    releaseId: opaqueIdSchema,
    expectedReleaseContentHash: sha256Schema,
  })
  .strict();
export const approveDeploymentRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    approvalDigest: sha256Schema,
  })
  .strict();
export const observeDeploymentRequestSchema = z
  .object({ schemaVersion: schemaVersionSchema, commandId: opaqueIdSchema })
  .strict();
export const startDeploymentRequestSchema = z.object({ schemaVersion: schemaVersionSchema }).strict();
export const cancelDeploymentRequestSchema = z.object({ schemaVersion: schemaVersionSchema }).strict();

const deploymentPreviewBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  projectId: opaqueIdSchema,
  projectVersion: z.number().int().positive(),
  releaseId: opaqueIdSchema,
  releaseContentHash: sha256Schema,
});
export const deploymentPreviewResponseSchema = z.discriminatedUnion("status", [
  deploymentPreviewBaseSchema
    .extend({ status: z.literal("READY"), target: githubActionsDeploymentTargetSchema })
    .strict(),
  deploymentPreviewBaseSchema
    .extend({ status: z.literal("BLOCKED"), code: deploymentPreflightFailureCodeSchema })
    .strict(),
]);

export const guidedDeploymentProjectResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    latestPlan: deploymentPlanSchema.nullable(),
    latestDeployment: deploymentSchema.nullable(),
    rollbackAvailability: z.literal("UNAVAILABLE"),
  })
  .strict();

export type GithubActionsDeploymentTarget = z.infer<typeof githubActionsDeploymentTargetSchema>;
export type DeploymentIntent = z.infer<typeof deploymentIntentSchema>;
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type DeploymentFailureCode = z.infer<typeof deploymentFailureCodeSchema>;
export type DeploymentPreflightFailureCode = z.infer<typeof deploymentPreflightFailureCodeSchema>;
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentApproval = z.infer<typeof deploymentApprovalSchema>;
export type AdoptDeploymentPlanCommand = z.infer<typeof adoptDeploymentPlanCommandSchema>;
export type ApproveDeploymentCommand = z.infer<typeof approveDeploymentCommandSchema>;
export type StartDeploymentCommand = z.infer<typeof startDeploymentCommandSchema>;
export type DeploymentDispatchOutcome = z.infer<typeof deploymentDispatchOutcomeSchema>;
export type RecordDeploymentDispatchCommand = z.infer<typeof recordDeploymentDispatchCommandSchema>;
export type DeploymentObservationOutcome = z.infer<typeof deploymentObservationOutcomeSchema>;
export type RecordDeploymentObservationCommand = z.infer<typeof recordDeploymentObservationCommandSchema>;
export type ReconcileDeploymentCommand = z.infer<typeof reconcileDeploymentCommandSchema>;
export type DeploymentPlanAdoptedEvent = z.infer<typeof deploymentPlanAdoptedEventSchema>;
export type DeploymentChangedEvent = z.infer<typeof deploymentChangedEventSchema>;
export type DeploymentPlanAdoptedResult = z.infer<typeof deploymentPlanAdoptedResultSchema>;
export type DeploymentChangedResult = z.infer<typeof deploymentChangedResultSchema>;
export type AdoptDeploymentPlanRequest = z.infer<typeof adoptDeploymentPlanRequestSchema>;
export type ApproveDeploymentRequest = z.infer<typeof approveDeploymentRequestSchema>;
export type ObserveDeploymentRequest = z.infer<typeof observeDeploymentRequestSchema>;
export type StartDeploymentRequest = z.infer<typeof startDeploymentRequestSchema>;
export type CancelDeploymentRequest = z.infer<typeof cancelDeploymentRequestSchema>;
export type DeploymentPreviewResponse = z.infer<typeof deploymentPreviewResponseSchema>;
export type GuidedDeploymentProjectResponse = z.infer<typeof guidedDeploymentProjectResponseSchema>;
