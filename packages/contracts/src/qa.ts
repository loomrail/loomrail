import { z } from "zod";

import { opaqueIdSchema, schemaVersionSchema, utcTimestampSchema } from "./shared.js";

export const MAX_QA_TARGETS = 24;
export const MAX_QA_SCENARIOS = 20;
export const MAX_QA_STEPS_PER_SCENARIO = 50;
export const MAX_QA_ASSERTIONS_PER_SCENARIO = 50;
export const MAX_QA_EXECUTIONS = MAX_QA_TARGETS * MAX_QA_SCENARIOS;
export const MAX_QA_OBSERVATIONS = 100;
export const MAX_QA_ATTACHMENTS = 50;
export const MAX_QA_DEFECTS = 50;

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().min(1).max(4_000);
const shortDescriptionSchema = z.string().trim().min(1).max(1_000);
const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const isLoopbackHostname = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
};

export const qaTargetOriginSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const match = /^(?:https?):\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::([1-9]\d{0,4}))?$/.exec(value);
    if (!match || !isLoopbackHostname(match[1] ?? "")) {
      context.addIssue({ code: "custom", message: "QA target must be a bare origin without credentials" });
      return;
    }
    const port = match[2];
    if (port !== undefined && Number(port) > 65_535) {
      context.addIssue({ code: "custom", message: "QA target origin port is outside the valid range" });
    }
  });

export const browserDriverIdSchema = z.literal("PLAYWRIGHT");
export const qaRunStatusSchema = z.enum(["RUNNING", "PASSED", "FAILED", "ERROR"]);
export const qaCheckStatusSchema = z.enum(["PASSED", "FAILED"]);
export const qaThemeSchema = z.enum(["LIGHT", "DARK"]);
export const qaObservationKindSchema = z.enum(["CONSOLE", "NETWORK"]);
export const qaObservationSeveritySchema = z.enum(["INFO", "WARNING", "ERROR"]);
export const qaAttachmentKindSchema = z.enum(["SCREENSHOT", "TRACE"]);
export const qaRetentionClassSchema = z.literal("STANDARD_30_DAYS");
export const qaDefectSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const qaDefectStatusSchema = z.enum(["OPEN", "RESOLVED", "WAIVED"]);
export const qaDriverErrorCodeSchema = z.enum([
  "TARGET_UNHEALTHY",
  "DRIVER_CRASHED",
  "ORIGIN_FORBIDDEN",
  "TIMEOUT",
  "EVIDENCE_INVALID",
]);

export const qaViewportSchema = z
  .object({
    width: z.number().int().min(240).max(7_680),
    height: z.number().int().min(240).max(4_320),
  })
  .strict();

export const qaTargetSchema = z
  .object({
    id: opaqueIdSchema,
    viewport: qaViewportSchema,
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
    theme: qaThemeSchema,
  })
  .strict();

const qaPlannedCheckSchema = z.object({ id: opaqueIdSchema, title: titleSchema }).strict();

export const qaScenarioPlanSchema = z
  .object({
    id: opaqueIdSchema,
    title: titleSchema,
    steps: z.array(qaPlannedCheckSchema).min(1).max(MAX_QA_STEPS_PER_SCENARIO),
    assertions: z.array(qaPlannedCheckSchema).min(1).max(MAX_QA_ASSERTIONS_PER_SCENARIO),
  })
  .strict()
  .superRefine((scenario, context) => {
    if (new Set(scenario.steps.map(({ id }) => id)).size !== scenario.steps.length) {
      context.addIssue({ code: "custom", message: "QA scenario step IDs must be unique" });
    }
    if (new Set(scenario.assertions.map(({ id }) => id)).size !== scenario.assertions.length) {
      context.addIssue({ code: "custom", message: "QA scenario assertion IDs must be unique" });
    }
  });

export const qaPlanSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    revision: z.number().int().positive(),
    contentHash: contentHashSchema,
    targets: z.array(qaTargetSchema).min(1).max(MAX_QA_TARGETS),
    scenarios: z.array(qaScenarioPlanSchema).min(1).max(MAX_QA_SCENARIOS),
  })
  .strict()
  .superRefine((plan, context) => {
    if (new Set(plan.targets.map(({ id }) => id)).size !== plan.targets.length) {
      context.addIssue({ code: "custom", message: "QA target IDs must be unique" });
    }
    if (new Set(plan.scenarios.map(({ id }) => id)).size !== plan.scenarios.length) {
      context.addIssue({ code: "custom", message: "QA scenario IDs must be unique" });
    }
  });

export const qaEnvironmentSchema = z
  .object({
    osFamily: z.enum(["MACOS", "WINDOWS", "LINUX"]),
    runtimeName: z.literal("NODE"),
    runtimeVersion: z.string().trim().min(1).max(100),
    browserName: z.enum(["CHROMIUM", "FIREFOX", "WEBKIT"]),
    browserVersion: z.string().trim().min(1).max(100),
  })
  .strict();

export const qaRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    agentRunId: opaqueIdSchema,
    driverId: browserDriverIdSchema,
    testedTree: treeShaSchema,
    targetOrigin: qaTargetOriginSchema,
    plan: qaPlanSnapshotSchema,
    status: qaRunStatusSchema,
    error: z.object({ code: qaDriverErrorCodeSchema, summary: shortDescriptionSchema }).strict().nullable(),
    startedAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    const running = run.status === "RUNNING";
    if (running !== (run.completedAt === null)) {
      context.addIssue({ code: "custom", message: "Only a running QA run can omit completion time" });
    }
    if ((run.status === "ERROR") !== (run.error !== null)) {
      context.addIssue({ code: "custom", message: "Only an errored QA run can carry a driver error" });
    }
  });

export const qaStepResultSchema = z
  .object({
    id: opaqueIdSchema,
    status: qaCheckStatusSchema,
    durationMs: z.number().int().nonnegative().max(3_600_000),
  })
  .strict();

export const qaAssertionResultSchema = z
  .object({
    id: opaqueIdSchema,
    status: qaCheckStatusSchema,
    details: shortDescriptionSchema.nullable(),
  })
  .strict();

export const qaScenarioExecutionSchema = z
  .object({
    targetId: opaqueIdSchema,
    scenarioId: opaqueIdSchema,
    durationMs: z.number().int().nonnegative().max(3_600_000),
    steps: z.array(qaStepResultSchema).min(1).max(MAX_QA_STEPS_PER_SCENARIO),
    assertions: z.array(qaAssertionResultSchema).min(1).max(MAX_QA_ASSERTIONS_PER_SCENARIO),
  })
  .strict();

export const qaObservationSchema = z
  .object({
    kind: qaObservationKindSchema,
    severity: qaObservationSeveritySchema,
    blocking: z.boolean(),
    targetId: opaqueIdSchema,
    scenarioId: opaqueIdSchema,
    summary: shortDescriptionSchema,
  })
  .strict();

export const qaAttachmentDraftSchema = z
  .object({
    handle: opaqueIdSchema,
    kind: qaAttachmentKindSchema,
    contentHash: contentHashSchema,
    byteSize: z.number().int().positive().max(1_073_741_824),
    targetId: opaqueIdSchema,
    scenarioId: opaqueIdSchema,
    capturedAt: utcTimestampSchema,
  })
  .strict();

export const qaAttachmentRefSchema = qaAttachmentDraftSchema
  .omit({ handle: true })
  .extend({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    qaRunId: opaqueIdSchema,
    retentionClass: qaRetentionClassSchema,
    storageKey: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !value.startsWith("/") && !value.includes("\\"), "Storage key must be relative")
      .refine(
        (value) =>
          value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        "Storage key must contain only portable segments",
      ),
  })
  .strict();

export const qaDefectDraftSchema = z
  .object({
    severity: qaDefectSeveritySchema,
    title: titleSchema,
    description: descriptionSchema,
    reproduction: z.array(shortDescriptionSchema).min(1).max(20),
    targetId: opaqueIdSchema,
    scenarioId: opaqueIdSchema,
  })
  .strict();

export const qaDefectSchema = qaDefectDraftSchema
  .extend({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    qaRunId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    testedTree: treeShaSchema,
    ordinal: z.number().int().positive().max(MAX_QA_DEFECTS),
    status: qaDefectStatusSchema,
    resolutionReason: descriptionSchema.nullable(),
    createdAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((defect, context) => {
    const open = defect.status === "OPEN";
    const hasAnyResolution = defect.resolutionReason !== null || defect.resolvedAt !== null;
    const hasCompleteResolution = defect.resolutionReason !== null && defect.resolvedAt !== null;
    if ((open && hasAnyResolution) || (!open && !hasCompleteResolution)) {
      context.addIssue({ code: "custom", message: "A terminal QA defect requires complete resolution data" });
    }
  });

const qaMeasuredDriverResultSchema = z
  .object({
    outcome: z.literal("MEASURED"),
    environment: qaEnvironmentSchema,
    executions: z.array(qaScenarioExecutionSchema).min(1).max(MAX_QA_EXECUTIONS),
    observations: z.array(qaObservationSchema).max(MAX_QA_OBSERVATIONS),
    attachments: z.array(qaAttachmentDraftSchema).max(MAX_QA_ATTACHMENTS),
    defects: z.array(qaDefectDraftSchema).max(MAX_QA_DEFECTS),
  })
  .strict();

const qaErroredDriverResultSchema = z
  .object({
    outcome: z.literal("ERROR"),
    code: qaDriverErrorCodeSchema,
    summary: shortDescriptionSchema,
  })
  .strict();

export const qaDriverResultSchema = z.discriminatedUnion("outcome", [
  qaMeasuredDriverResultSchema,
  qaErroredDriverResultSchema,
]);

export type BrowserDriverId = z.infer<typeof browserDriverIdSchema>;
export type QARunStatus = z.infer<typeof qaRunStatusSchema>;
export type QACheckStatus = z.infer<typeof qaCheckStatusSchema>;
export type QAPlanSnapshot = z.infer<typeof qaPlanSnapshotSchema>;
export type QAEnvironment = z.infer<typeof qaEnvironmentSchema>;
export type QARun = z.infer<typeof qaRunSchema>;
export type QAScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QAObservation = z.infer<typeof qaObservationSchema>;
export type QAAttachmentDraft = z.infer<typeof qaAttachmentDraftSchema>;
export type QAAttachmentRef = z.infer<typeof qaAttachmentRefSchema>;
export type QADefectDraft = z.infer<typeof qaDefectDraftSchema>;
export type QADefect = z.infer<typeof qaDefectSchema>;
export type QADriverResult = z.infer<typeof qaDriverResultSchema>;
