import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const MAX_QA_TARGETS = 24;
export const MAX_QA_SCENARIOS = 20;
export const MAX_QA_STEPS_PER_SCENARIO = 50;
export const MAX_QA_ASSERTIONS_PER_SCENARIO = 50;
export const MAX_QA_EXECUTIONS = MAX_QA_TARGETS * MAX_QA_SCENARIOS;
export const MAX_QA_OBSERVATIONS = 100;
export const MAX_QA_ATTACHMENTS = 50;
export const MAX_QA_DEFECTS = 50;
export const MAX_QA_RUN_HISTORY = 20;
export const MAX_AUTOMATIC_QA_CORRECTION_RUNS = 2;
export const MAX_TOTAL_QA_CORRECTION_RUNS = 3;
export const MAX_QA_CORRECTION_DEFECTS = MAX_TOTAL_QA_CORRECTION_RUNS * MAX_QA_DEFECTS;
export const MAX_QA_ATTACHMENT_BYTES = 32 * 1_024 * 1_024;
export const MAX_QA_STORED_ATTACHMENT_BYTES = 1_024 * 1_024 * 1_024;
export const MAX_QA_TOTAL_ATTACHMENT_BYTES = 256 * 1_024 * 1_024;
export const MAX_QA_RESPONSE_BYTES = 8 * 1_024 * 1_024;
export const MAX_QA_TOTAL_RESPONSE_BYTES = 64 * 1_024 * 1_024;
export const MAX_QA_REQUESTS = 250;

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().min(1).max(4_000);
const shortDescriptionSchema = z.string().trim().min(1).max(1_000);
const treeShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const portableStorageSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Storage key segment is not portable")
  .refine(
    (value) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    "Storage key segment is reserved on Windows",
  );

const isLoopbackHostname = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 31) return true;
  }
  return false;
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
export const qaAttachmentRetentionOutcomeSchema = z.enum(["DELETED", "ALREADY_ABSENT"]);
export const qaDefectSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const qaDefectStatusSchema = z.enum(["OPEN", "RESOLVED", "WAIVED"]);
export const qaCorrectionRunStatusSchema = z.enum([
  "ACTIVE",
  "PASSED",
  "SUPERSEDED",
  "EXHAUSTED",
  "CANCELLED",
]);
export const qaRetestCellReasons = [
  "FAILED_CHECK",
  "BLOCKING_OBSERVATION",
  "OPEN_DEFECT",
  "REGRESSION",
] as const;
export const qaRetestCellReasonSchema = z.enum(qaRetestCellReasons);
export const qaDriverErrorCodeSchema = z.enum([
  "TARGET_UNHEALTHY",
  "DRIVER_CRASHED",
  "ORIGIN_FORBIDDEN",
  "TIMEOUT",
  "EVIDENCE_INVALID",
]);
export const qaRunScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("FULL") }).strict(),
  z
    .object({
      type: z.literal("RETEST"),
      correctionRunId: opaqueIdSchema,
      retestPlanId: opaqueIdSchema,
    })
    .strict(),
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

export const qaLocatorSchema = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("ROLE"),
      role: z.enum([
        "button",
        "checkbox",
        "dialog",
        "heading",
        "link",
        "listitem",
        "menuitem",
        "radio",
        "region",
        "tab",
        "textbox",
      ]),
      name: titleSchema,
    })
    .strict(),
  z.object({ by: z.literal("TEST_ID"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ by: z.literal("TEXT"), value: titleSchema }).strict(),
]);

const qaRelativeUrlPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^\/(?!\/)[^\\]*$/, "Navigation target must be a same-origin absolute path")
  .refine((value) => !hasControlCharacter(value), "Navigation target cannot contain control characters");

export const qaStepActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NAVIGATE"), path: qaRelativeUrlPathSchema }).strict(),
  z.object({ type: z.literal("CLICK"), locator: qaLocatorSchema }).strict(),
  z
    .object({
      type: z.literal("PRESS"),
      locator: qaLocatorSchema,
      key: z.enum([
        "Tab",
        "Shift+Tab",
        "Enter",
        "Space",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("WAIT_FOR_IDLE") }).strict(),
]);

export const qaAssertionRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("VISIBLE"), locator: qaLocatorSchema }).strict(),
  z
    .object({ type: z.literal("TEXT_CONTAINS"), locator: qaLocatorSchema, expected: shortDescriptionSchema })
    .strict(),
  z.object({ type: z.literal("URL_PATH"), path: qaRelativeUrlPathSchema }).strict(),
  z.object({ type: z.literal("NO_HORIZONTAL_OVERFLOW") }).strict(),
  z.object({ type: z.literal("FOCUSED"), locator: qaLocatorSchema }).strict(),
]);

const qaPlannedStepSchema = z
  .object({ id: opaqueIdSchema, title: titleSchema, action: qaStepActionSchema })
  .strict();
const qaPlannedAssertionSchema = z
  .object({ id: opaqueIdSchema, title: titleSchema, rule: qaAssertionRuleSchema })
  .strict();

export const qaScenarioPlanSchema = z
  .object({
    id: opaqueIdSchema,
    title: titleSchema,
    steps: z.array(qaPlannedStepSchema).min(1).max(MAX_QA_STEPS_PER_SCENARIO),
    assertions: z.array(qaPlannedAssertionSchema).min(1).max(MAX_QA_ASSERTIONS_PER_SCENARIO),
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
    const executions = plan.targets.length * plan.scenarios.length;
    if (executions + plan.targets.length > MAX_QA_ATTACHMENTS) {
      context.addIssue({
        code: "custom",
        message: "QA matrix is too large for one screenshot per execution and one trace per target",
      });
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
    scope: qaRunScopeSchema,
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
    byteSize: z.number().int().positive().max(MAX_QA_ATTACHMENT_BYTES),
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
    // Existing databases created by migration 0022 allowed refs up to 1 GiB. New driver drafts are
    // capped at MAX_QA_ATTACHMENT_BYTES; the wider read bound preserves those append-only rows.
    byteSize: z.number().int().positive().max(MAX_QA_STORED_ATTACHMENT_BYTES),
    retentionClass: qaRetentionClassSchema,
    storageKey: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !value.startsWith("/") && !value.includes("\\"), "Storage key must be relative")
      .refine(
        (value) =>
          value.split("/").every((segment) => portableStorageSegmentSchema.safeParse(segment).success),
        "Storage key must contain only portable segments",
      ),
  })
  .strict();

export const qaAttachmentSummarySchema = qaAttachmentRefSchema.omit({ storageKey: true }).strict();

export const qaFinalizedAttachmentSchema = z
  .object({
    handle: opaqueIdSchema,
    ref: qaAttachmentRefSchema,
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

export const qaRetestCellSchema = z
  .object({
    targetId: opaqueIdSchema,
    scenarioId: opaqueIdSchema,
    reasons: z.array(qaRetestCellReasonSchema).min(1).max(qaRetestCellReasons.length),
  })
  .strict()
  .superRefine((cell, context) => {
    if (new Set(cell.reasons).size !== cell.reasons.length) {
      context.addIssue({ code: "custom", message: "A QA retest cell cannot repeat a scope reason" });
    }
    const ordered = [...cell.reasons].sort(
      (left, right) => qaRetestCellReasons.indexOf(left) - qaRetestCellReasons.indexOf(right),
    );
    if (ordered.some((reason, index) => reason !== cell.reasons[index])) {
      context.addIssue({ code: "custom", message: "QA retest cell reasons must use canonical order" });
    }
  });

export const qaRetestPlanSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    correctionRunId: opaqueIdSchema,
    baselineQARunId: opaqueIdSchema,
    sourceQARunId: opaqueIdSchema,
    sourceEvidenceBundleId: opaqueIdSchema,
    baselinePlanRevision: z.number().int().positive(),
    baselinePlanContentHash: contentHashSchema,
    cells: z.array(qaRetestCellSchema).min(1).max(MAX_QA_EXECUTIONS),
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const keys = plan.cells.map(({ targetId, scenarioId }) => `${targetId}\u0000${scenarioId}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "A QA retest plan cannot repeat a target/scenario cell" });
    }
  });

export const qaCorrectionRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    ordinal: z.number().int().positive().max(MAX_TOTAL_QA_CORRECTION_RUNS),
    sourceQARunId: opaqueIdSchema,
    baselineQARunId: opaqueIdSchema,
    sourceEvidenceBundleId: opaqueIdSchema,
    sourceTestedTree: treeShaSchema,
    defectIds: z.array(opaqueIdSchema).min(1).max(MAX_QA_CORRECTION_DEFECTS),
    status: qaCorrectionRunStatusSchema,
    createdAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    if (new Set(run.defectIds).size !== run.defectIds.length) {
      context.addIssue({ code: "custom", message: "A QA correction run cannot repeat a defect ID" });
    }
    const terminal = run.status === "PASSED" || run.status === "SUPERSEDED" || run.status === "CANCELLED";
    if (terminal !== (run.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only a terminal QA correction run can carry a completion time",
      });
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

export const qaEvidenceBundleSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    qaRunId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    testedTree: treeShaSchema,
    verdict: z.enum(["PASSED", "FAILED"]),
    environment: qaEnvironmentSchema,
    executions: z.array(qaScenarioExecutionSchema).min(1).max(MAX_QA_EXECUTIONS),
    observations: z.array(qaObservationSchema).max(MAX_QA_OBSERVATIONS),
    attachmentIds: z.array(opaqueIdSchema).max(MAX_QA_ATTACHMENTS),
    defectIds: z.array(opaqueIdSchema).max(MAX_QA_DEFECTS),
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    if (new Set(bundle.attachmentIds).size !== bundle.attachmentIds.length) {
      context.addIssue({ code: "custom", message: "QA evidence cannot repeat an attachment ID" });
    }
    if (new Set(bundle.defectIds).size !== bundle.defectIds.length) {
      context.addIssue({ code: "custom", message: "QA evidence cannot repeat a defect ID" });
    }
    if (bundle.verdict === "PASSED" && bundle.defectIds.length !== 0) {
      context.addIssue({ code: "custom", message: "Passed QA evidence cannot reference defects" });
    }
    if (bundle.verdict === "FAILED" && bundle.defectIds.length === 0) {
      context.addIssue({ code: "custom", message: "Failed QA evidence requires a defect" });
    }
  });

const qaEventBaseSchema = z
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

export const qaRunReservedEventSchema = qaEventBaseSchema.extend({
  type: z.literal("QA_RUN_RESERVED"),
  data: z.object({ qaRun: qaRunSchema }).strict(),
});

export const qaRunCompletedEventSchema = qaEventBaseSchema.extend({
  type: z.literal("QA_RUN_COMPLETED"),
  data: z
    .object({
      qaRun: qaRunSchema,
      evidenceBundleId: opaqueIdSchema.nullable(),
      defectIds: z.array(opaqueIdSchema).max(MAX_QA_DEFECTS),
    })
    .strict(),
});

export const qaDefectWaivedEventSchema = qaEventBaseSchema.extend({
  type: z.literal("QA_DEFECT_WAIVED"),
  data: z.object({ defect: qaDefectSchema }).strict(),
});

const qaCommandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const reserveQARunCommandSchema = qaCommandBaseSchema.extend({
  type: z.literal("RESERVE_QA_RUN"),
  payload: z
    .object({
      stageAttemptId: opaqueIdSchema,
      agentRunId: opaqueIdSchema,
      testedTree: treeShaSchema,
      targetOrigin: qaTargetOriginSchema,
      plan: qaPlanSnapshotSchema,
      scope: qaRunScopeSchema,
    })
    .strict(),
});

export const completeQARunCommandSchema = qaCommandBaseSchema.extend({
  type: z.literal("COMPLETE_QA_RUN"),
  payload: z
    .object({
      qaRunId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      currentTree: treeShaSchema,
      result: qaDriverResultSchema,
      finalizedAttachments: z.array(qaFinalizedAttachmentSchema).max(MAX_QA_ATTACHMENTS),
    })
    .strict(),
});

export const recordQAAttachmentRetentionCommandSchema = qaCommandBaseSchema.extend({
  type: z.literal("RECORD_QA_ATTACHMENT_RETENTION"),
  payload: z
    .object({
      attachmentId: opaqueIdSchema,
      outcome: qaAttachmentRetentionOutcomeSchema,
    })
    .strict(),
});

export const waiveQADefectCommandSchema = qaCommandBaseSchema.extend({
  type: z.literal("WAIVE_QA_DEFECT"),
  payload: z
    .object({
      defectId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      reason: descriptionSchema,
    })
    .strict(),
});

export const waiveQADefectRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    reason: descriptionSchema,
  })
  .strict();

const qaCommandResultBaseSchema = z
  .object({ schemaVersion: schemaVersionSchema, replayed: z.boolean() })
  .strict();

export const qaRunReservedResultSchema = qaCommandResultBaseSchema.extend({
  type: z.literal("QA_RUN_RESERVED"),
  workItemId: opaqueIdSchema,
  qaRun: qaRunSchema,
  event: qaRunReservedEventSchema,
});

export const qaRunCompletedResultSchema = qaCommandResultBaseSchema.extend({
  type: z.literal("QA_RUN_COMPLETED"),
  workItemId: opaqueIdSchema,
  qaRun: qaRunSchema,
  evidence: qaEvidenceBundleSchema.nullable(),
  attachments: z.array(qaAttachmentRefSchema).max(MAX_QA_ATTACHMENTS),
  defects: z.array(qaDefectSchema).max(MAX_QA_DEFECTS),
  event: qaRunCompletedEventSchema,
});

export const qaAttachmentRetentionRecordedResultSchema = qaCommandResultBaseSchema.extend({
  type: z.literal("QA_ATTACHMENT_RETENTION_RECORDED"),
  attachmentId: opaqueIdSchema,
  outcome: qaAttachmentRetentionOutcomeSchema,
  recordedAt: utcTimestampSchema,
});

export const qaDefectWaivedResultSchema = qaCommandResultBaseSchema.extend({
  type: z.literal("QA_DEFECT_WAIVED"),
  workItemId: opaqueIdSchema,
  defect: qaDefectSchema,
  event: qaDefectWaivedEventSchema,
});

export const qaStateResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    runs: z.array(qaRunSchema).max(MAX_QA_RUN_HISTORY),
    evidence: z.array(qaEvidenceBundleSchema).max(MAX_QA_RUN_HISTORY),
    attachments: z.array(qaAttachmentSummarySchema).max(MAX_QA_RUN_HISTORY * MAX_QA_ATTACHMENTS),
    defects: z.array(qaDefectSchema).max(MAX_QA_RUN_HISTORY * MAX_QA_DEFECTS),
  })
  .strict();

export type BrowserDriverId = z.infer<typeof browserDriverIdSchema>;
export type QARunStatus = z.infer<typeof qaRunStatusSchema>;
export type QARunScope = z.infer<typeof qaRunScopeSchema>;
export type QACheckStatus = z.infer<typeof qaCheckStatusSchema>;
export type QAPlanSnapshot = z.infer<typeof qaPlanSnapshotSchema>;
export type QALocator = z.infer<typeof qaLocatorSchema>;
export type QAStepAction = z.infer<typeof qaStepActionSchema>;
export type QAAssertionRule = z.infer<typeof qaAssertionRuleSchema>;
export type QAEnvironment = z.infer<typeof qaEnvironmentSchema>;
export type QARun = z.infer<typeof qaRunSchema>;
export type QAScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QAObservation = z.infer<typeof qaObservationSchema>;
export type QAAttachmentDraft = z.infer<typeof qaAttachmentDraftSchema>;
export type QAAttachmentRef = z.infer<typeof qaAttachmentRefSchema>;
export type QAAttachmentSummary = z.infer<typeof qaAttachmentSummarySchema>;
export type QAFinalizedAttachment = z.infer<typeof qaFinalizedAttachmentSchema>;
export type QADefectDraft = z.infer<typeof qaDefectDraftSchema>;
export type QADefect = z.infer<typeof qaDefectSchema>;
export type QACorrectionRunStatus = z.infer<typeof qaCorrectionRunStatusSchema>;
export type QARetestCellReason = z.infer<typeof qaRetestCellReasonSchema>;
export type QARetestCell = z.infer<typeof qaRetestCellSchema>;
export type QARetestPlan = z.infer<typeof qaRetestPlanSchema>;
export type QACorrectionRun = z.infer<typeof qaCorrectionRunSchema>;
export type QADriverResult = z.infer<typeof qaDriverResultSchema>;
export type QAEvidenceBundle = z.infer<typeof qaEvidenceBundleSchema>;
export type QARunReservedEvent = z.infer<typeof qaRunReservedEventSchema>;
export type QARunCompletedEvent = z.infer<typeof qaRunCompletedEventSchema>;
export type QADefectWaivedEvent = z.infer<typeof qaDefectWaivedEventSchema>;
export type ReserveQARunCommand = z.infer<typeof reserveQARunCommandSchema>;
export type CompleteQARunCommand = z.infer<typeof completeQARunCommandSchema>;
export type RecordQAAttachmentRetentionCommand = z.infer<typeof recordQAAttachmentRetentionCommandSchema>;
export type WaiveQADefectCommand = z.infer<typeof waiveQADefectCommandSchema>;
export type WaiveQADefectRequest = z.infer<typeof waiveQADefectRequestSchema>;
export type QARunReservedResult = z.infer<typeof qaRunReservedResultSchema>;
export type QARunCompletedResult = z.infer<typeof qaRunCompletedResultSchema>;
export type QAAttachmentRetentionRecordedResult = z.infer<typeof qaAttachmentRetentionRecordedResultSchema>;
export type QADefectWaivedResult = z.infer<typeof qaDefectWaivedResultSchema>;
export type QAStateResponse = z.infer<typeof qaStateResponseSchema>;
