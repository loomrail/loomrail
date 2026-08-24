import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decisionSchema,
  domainEventSchema,
  humanRequestSchema,
  humanRequestStatusSchema,
  opaqueIdSchema,
  pipelineRunSchema,
  projectSchema,
  stageAttemptSchema,
  stateCommandResultSchema,
  stateCommandSchema,
  workflowDispatchSchema,
  workflowSnapshotSchema,
  workflowTemplateSchema,
  workItemSchema,
  workItemStateSchema,
  type Actor,
  type Decision,
  type DomainEvent,
  type HumanRequest,
  type PipelineRun,
  type Project,
  type RegisterProjectCommand,
  type StageAttempt,
  type StartMockPipelineCommand,
  type StateCommand,
  type StateCommandResult,
  type WorkItem,
  type WorkflowDispatch,
  type WorkflowSnapshot,
} from "@loomrail/contracts";
import {
  decideAnswerHumanRequest,
  decideApplyMockProviderOutcome,
  decideStartMockPipeline,
  decideWorkItemCommand,
  WorkflowDomainError,
  WorkItemDomainError,
  type AnswerHumanRequestDecision,
  type ApplyProviderOutcomeDecision,
  type StartWorkflowDecision,
  type WorkItemCommand,
  type WorkItemDecision,
  type WorkItemEventIntent,
} from "@loomrail/domain";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { applyMigrations, databaseWasNonEmpty } from "./migrations.js";
import {
  StateStoreError,
  type LocalState,
  type OpenLocalStateOptions,
  type StateQuery,
  type StateQueryResult,
} from "./types.js";

export * from "./types.js";

const DEFAULT_WORKSPACE_ID = "workspace-local";
const DEFAULT_WORKSPACE_NAME = "Local workspace";

const projectRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  fixture_id: z.string(),
  name: z.string(),
  repository_path: z.string(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const workItemRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  current_stage: z.string().nullable(),
  priority: z.string(),
  risk: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const criterionRowSchema = z.object({ criterion: z.string() });

const eventRowSchema = z.object({
  sequence: z.number().int(),
  id: z.string(),
  schema_version: z.number().int(),
  type: z.string(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  project_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  occurred_at: z.string(),
  correlation_id: z.string(),
  data_json: z.string(),
});

const commandReceiptRowSchema = z.object({
  command_type: z.string(),
  input_hash: z.string(),
  result_json: z.string(),
});

const pipelineRunRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  workflow_template_id: z.string(),
  workflow_version: z.number().int(),
  status: z.string(),
  current_stage_attempt_id: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});

const stageAttemptRowSchema = z.object({
  id: z.string(),
  pipeline_run_id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  stage: z.string(),
  attempt: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  failure_code: z.string().nullable(),
});

const humanRequestRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  stage_attempt_id: z.string(),
  kind: z.string(),
  blocking: z.number().int(),
  title: z.string(),
  context: z.string(),
  recommendation: z.string().nullable(),
  allow_other: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});

const humanRequestOptionRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  consequence: z.string(),
  recommended: z.number().int(),
});

const decisionRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  human_request_id: z.string(),
  answer_json: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

const workflowDispatchRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  mode: z.string(),
  status: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

const stateQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LIST_PROJECTS") }).strict(),
  z.object({ type: z.literal("GET_PROJECT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORK_ITEM"), workItemId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORKFLOW_SNAPSHOT"), workItemId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("LIST_HUMAN_REQUESTS"),
      projectId: opaqueIdSchema.optional(),
      status: humanRequestStatusSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("LIST_PENDING_DISPATCHES") }).strict(),
  z
    .object({
      type: z.literal("LIST_WORK_ITEMS"),
      projectId: opaqueIdSchema,
      state: workItemStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_EVENTS"),
      afterSequence: z.number().int().nonnegative().default(0),
      projectId: opaqueIdSchema.optional(),
      aggregateId: opaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
]);

const parseJson = (value: string): unknown => JSON.parse(value) as unknown;

const projectFromRow = (value: unknown): Project => {
  const row = projectRowSchema.parse(value);
  return projectSchema.parse({
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspace_id,
    fixtureId: row.fixture_id,
    name: row.name,
    repositoryPath: row.repository_path,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const eventFromRow = (value: unknown): DomainEvent => {
  const row = eventRowSchema.parse(value);
  return domainEventSchema.parse({
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    projectId: row.project_id,
    actor: { type: row.actor_type, id: row.actor_id },
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    data: parseJson(row.data_json),
  });
};

const pipelineRunFromRow = (value: unknown): PipelineRun => {
  const row = pipelineRunRowSchema.parse(value);
  return pipelineRunSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workflowTemplateId: row.workflow_template_id,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStageAttemptId: row.current_stage_attempt_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
};

const stageAttemptFromRow = (value: unknown): StageAttempt => {
  const row = stageAttemptRowSchema.parse(value);
  return stageAttemptSchema.parse({
    schemaVersion: 1,
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    version: row.version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code,
  });
};

const decisionFromRow = (value: unknown): Decision => {
  const row = decisionRowSchema.parse(value);
  return decisionSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    humanRequestId: row.human_request_id,
    answer: parseJson(row.answer_json),
    actor: { type: row.actor_type, id: row.actor_id },
    reason: row.reason,
    createdAt: row.created_at,
  });
};

const workflowDispatchFromRow = (value: unknown): WorkflowDispatch => {
  const row = workflowDispatchRowSchema.parse(value);
  return workflowDispatchSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
};

const commandHash = (command: StateCommand): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: command.schemaVersion,
        type: command.type,
        actor: command.actor,
        payload: command.payload,
      }),
    )
    .digest("hex");

const lastInsertSequence = (value: number | bigint): number => {
  const sequence = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new StateStoreError("PERSISTENCE_FAILURE", "SQLite returned an invalid Event sequence");
  }
  return sequence;
};

const asReplayed = (result: StateCommandResult): StateCommandResult =>
  stateCommandResultSchema.parse({ ...result, replayed: true });

const assertNever = (value: never): never => {
  throw new StateStoreError("PERSISTENCE_FAILURE", "Unknown local-state operation", {
    value: String(value),
  });
};

export const openLocalState = async (options: OpenLocalStateOptions): Promise<LocalState> => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  const wasNonEmpty = await databaseWasNonEmpty(options.databasePath);
  if (options.databasePath !== ":memory:") {
    await mkdir(dirname(options.databasePath), { recursive: true });
  }

  const database = new DatabaseSync(options.databasePath, {
    defensive: true,
    timeout: 5_000,
  });
  let closed = false;

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");

    const startup = await applyMigrations(database, {
      databasePath: options.databasePath,
      ...(options.backupsDirectory === undefined ? {} : { backupsDirectory: options.backupsDirectory }),
      ...(options.migrationsDirectory === undefined
        ? {}
        : { migrationsDirectory: options.migrationsDirectory }),
      now,
      databaseWasNonEmpty: wasNonEmpty,
    });

    const openedAt = now().toISOString();
    database
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, openedAt, openedAt);

    const selectProjectById = database.prepare("SELECT * FROM projects WHERE id = ?");
    const selectWorkItemById = database.prepare("SELECT * FROM work_items WHERE id = ?");
    const selectCriteria = database.prepare(
      `SELECT criterion FROM work_item_acceptance_criteria
       WHERE work_item_id = ? ORDER BY ordinal`,
    );
    const insertCriterion = database.prepare(
      `INSERT INTO work_item_acceptance_criteria (work_item_id, ordinal, criterion)
       VALUES (?, ?, ?)`,
    );
    const deleteCriteria = database.prepare(
      "DELETE FROM work_item_acceptance_criteria WHERE work_item_id = ?",
    );
    const selectCommandReceipt = database.prepare(
      "SELECT command_type, input_hash, result_json FROM commands WHERE command_id = ?",
    );
    const insertCommandReceipt = database.prepare(
      `INSERT INTO commands (command_id, command_type, input_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertEvent = database.prepare(
      `INSERT INTO events (
        id, schema_version, type, aggregate_type, aggregate_id, project_id,
        actor_type, actor_id, occurred_at, correlation_id, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectPipelineRunById = database.prepare("SELECT * FROM pipeline_runs WHERE id = ?");
    const selectLatestPipelineRun = database.prepare(
      "SELECT * FROM pipeline_runs WHERE work_item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const selectActivePipelineRun = database.prepare(
      `SELECT * FROM pipeline_runs
       WHERE work_item_id = ? AND status IN ('RUNNING', 'WAITING_HUMAN')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const selectStageAttemptById = database.prepare("SELECT * FROM stage_attempts WHERE id = ?");
    const selectHumanRequestById = database.prepare("SELECT * FROM human_requests WHERE id = ?");
    const selectHumanRequestOptions = database.prepare(
      `SELECT id, label, consequence, recommended FROM human_request_options
       WHERE human_request_id = ? ORDER BY ordinal`,
    );
    const selectWorkflowDispatchById = database.prepare("SELECT * FROM workflow_dispatches WHERE id = ?");

    const assertOpen = (): void => {
      if (closed) throw new StateStoreError("STATE_CLOSED", "The local state module is closed");
    };

    const readProject = (projectId: string): Project | null => {
      const row = selectProjectById.get(projectId);
      return row === undefined ? null : projectFromRow(row);
    };

    const readWorkItem = (workItemId: string): WorkItem | null => {
      const value = selectWorkItemById.get(workItemId);
      if (value === undefined) return null;
      const row = workItemRowSchema.parse(value);
      const acceptanceCriteria = criterionRowSchema
        .array()
        .parse(selectCriteria.all(workItemId))
        .map(({ criterion }) => criterion);
      return workItemSchema.parse({
        schemaVersion: 1,
        id: row.id,
        projectId: row.project_id,
        parentId: row.parent_id,
        type: row.type,
        title: row.title,
        description: row.description,
        state: row.state,
        currentStage: row.current_stage,
        priority: row.priority,
        risk: row.risk,
        acceptanceCriteria,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    };

    const readPipelineRun = (pipelineRunId: string): PipelineRun | null => {
      const value = selectPipelineRunById.get(pipelineRunId);
      return value === undefined ? null : pipelineRunFromRow(value);
    };

    const readLatestPipelineRun = (workItemId: string): PipelineRun | null => {
      const value = selectLatestPipelineRun.get(workItemId);
      return value === undefined ? null : pipelineRunFromRow(value);
    };

    const readStageAttempt = (stageAttemptId: string): StageAttempt | null => {
      const value = selectStageAttemptById.get(stageAttemptId);
      return value === undefined ? null : stageAttemptFromRow(value);
    };

    const readHumanRequest = (humanRequestId: string): HumanRequest | null => {
      const value = selectHumanRequestById.get(humanRequestId);
      if (value === undefined) return null;
      const row = humanRequestRowSchema.parse(value);
      const options = humanRequestOptionRowSchema
        .array()
        .parse(selectHumanRequestOptions.all(humanRequestId))
        .map((option) => ({
          id: option.id,
          label: option.label,
          consequence: option.consequence,
          recommended: option.recommended === 1,
        }));
      return humanRequestSchema.parse({
        schemaVersion: 1,
        id: row.id,
        projectId: row.project_id,
        workItemId: row.work_item_id,
        stageAttemptId: row.stage_attempt_id,
        kind: row.kind,
        blocking: row.blocking === 1,
        title: row.title,
        context: row.context,
        recommendation: row.recommendation,
        options,
        allowOther: row.allow_other === 1,
        status: row.status,
        version: row.version,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      });
    };

    const readWorkflowDispatch = (dispatchId: string): WorkflowDispatch | null => {
      const value = selectWorkflowDispatchById.get(dispatchId);
      return value === undefined ? null : workflowDispatchFromRow(value);
    };

    const readWorkflowSnapshot = (workItemId: string): WorkflowSnapshot => {
      const run = readLatestPipelineRun(workItemId);
      if (!run) {
        return workflowSnapshotSchema.parse({
          schemaVersion: 1,
          run: null,
          stageAttempts: [],
          humanRequests: [],
          decisions: [],
        });
      }
      const stageAttempts = database
        .prepare("SELECT * FROM stage_attempts WHERE pipeline_run_id = ? ORDER BY rowid")
        .all(run.id)
        .map(stageAttemptFromRow);
      const humanRequests = database
        .prepare("SELECT * FROM human_requests WHERE work_item_id = ? ORDER BY created_at, id")
        .all(workItemId)
        .map((row) => {
          const request = readHumanRequest(humanRequestRowSchema.parse(row).id);
          if (!request) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "A listed HumanRequest could not be reloaded");
          }
          return request;
        });
      const decisions = database
        .prepare("SELECT * FROM decisions WHERE work_item_id = ? ORDER BY created_at, id")
        .all(workItemId)
        .map(decisionFromRow);
      return workflowSnapshotSchema.parse({
        schemaVersion: 1,
        run,
        stageAttempts,
        humanRequests,
        decisions,
      });
    };

    const writeCriteria = (workItem: WorkItem): void => {
      deleteCriteria.run(workItem.id);
      workItem.acceptanceCriteria.forEach((criterion, ordinal) => {
        insertCriterion.run(workItem.id, ordinal, criterion);
      });
    };

    const appendEvent = (
      intent: WorkItemEventIntent,
      metadata: {
        aggregateId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): DomainEvent => {
      const eventId = createId("event");
      const result = insertEvent.run(
        eventId,
        1,
        intent.type,
        "WORK_ITEM",
        metadata.aggregateId,
        metadata.projectId,
        metadata.actor.type,
        metadata.actor.id,
        metadata.occurredAt,
        metadata.correlationId,
        JSON.stringify(intent.data),
      );
      return domainEventSchema.parse({
        schemaVersion: 1,
        sequence: lastInsertSequence(result.lastInsertRowid),
        id: eventId,
        type: intent.type,
        aggregateType: "WORK_ITEM",
        aggregateId: metadata.aggregateId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const appendProjectEvent = (
      project: Project,
      command: RegisterProjectCommand,
      occurredAt: string,
    ): DomainEvent => {
      const eventId = createId("event");
      const data = { project };
      const result = insertEvent.run(
        eventId,
        1,
        "PROJECT_REGISTERED",
        "PROJECT",
        project.id,
        project.id,
        command.actor.type,
        command.actor.id,
        occurredAt,
        command.correlationId,
        JSON.stringify(data),
      );
      return domainEventSchema.parse({
        schemaVersion: 1,
        sequence: lastInsertSequence(result.lastInsertRowid),
        id: eventId,
        type: "PROJECT_REGISTERED",
        aggregateType: "PROJECT",
        aggregateId: project.id,
        projectId: project.id,
        actor: command.actor,
        occurredAt,
        correlationId: command.correlationId,
        data,
      });
    };

    type WorkflowEventIntent =
      | StartWorkflowDecision["events"][number]
      | ApplyProviderOutcomeDecision["events"][number]
      | AnswerHumanRequestDecision["events"][number];

    const appendWorkflowEvents = (
      intents: readonly WorkflowEventIntent[],
      metadata: {
        workItemId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): DomainEvent[] =>
      intents.map((intent) => {
        const eventId = createId("event");
        const result = insertEvent.run(
          eventId,
          1,
          intent.type,
          "WORK_ITEM",
          metadata.workItemId,
          metadata.projectId,
          metadata.actor.type,
          metadata.actor.id,
          metadata.occurredAt,
          metadata.correlationId,
          JSON.stringify(intent.data),
        );
        return domainEventSchema.parse({
          schemaVersion: 1,
          sequence: lastInsertSequence(result.lastInsertRowid),
          id: eventId,
          type: intent.type,
          aggregateType: "WORK_ITEM",
          aggregateId: metadata.workItemId,
          projectId: metadata.projectId,
          actor: metadata.actor,
          occurredAt: metadata.occurredAt,
          correlationId: metadata.correlationId,
          data: intent.data,
        });
      });

    const persistWorkflowTemplate = (
      templateInput: StartMockPipelineCommand["payload"]["template"],
      createdAt: string,
    ): void => {
      const template = workflowTemplateSchema.parse(templateInput);
      const templateJson = canonicalJson(template);
      database
        .prepare(
          `INSERT OR IGNORE INTO workflow_templates
           (id, version, schema_version, name, template_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(template.id, template.version, template.schemaVersion, template.name, templateJson, createdAt);
      const stored = z
        .object({ template_json: z.string() })
        .parse(
          database
            .prepare("SELECT template_json FROM workflow_templates WHERE id = ? AND version = ?")
            .get(template.id, template.version),
        );
      if (stored.template_json !== templateJson) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "A workflow template version cannot be changed after it is persisted",
        );
      }
    };

    const updateWorkflowWorkItem = (workItem: WorkItem): void => {
      const update = database
        .prepare(
          `UPDATE work_items SET state = ?, current_stage = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          workItem.state,
          workItem.currentStage,
          workItem.version,
          workItem.updatedAt,
          workItem.id,
          workItem.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The WorkItem changed while the workflow command was being applied",
        );
      }
    };

    const insertPipelineRun = (run: PipelineRun): void => {
      database
        .prepare(
          `INSERT INTO pipeline_runs (
            id, project_id, work_item_id, workflow_template_id, workflow_version, status,
            current_stage_attempt_id, version, created_at, updated_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.workItemId,
          run.workflowTemplateId,
          run.workflowVersion,
          run.status,
          run.currentStageAttemptId,
          run.version,
          run.createdAt,
          run.updatedAt,
          run.finishedAt,
        );
    };

    const updatePipelineRun = (run: PipelineRun): void => {
      const update = database
        .prepare(
          `UPDATE pipeline_runs SET status = ?, current_stage_attempt_id = ?, version = ?,
             updated_at = ?, finished_at = ? WHERE id = ? AND version = ?`,
        )
        .run(
          run.status,
          run.currentStageAttemptId,
          run.version,
          run.updatedAt,
          run.finishedAt,
          run.id,
          run.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The PipelineRun changed while the command was being applied",
        );
      }
    };

    const insertStageAttempt = (attempt: StageAttempt): void => {
      database
        .prepare(
          `INSERT INTO stage_attempts (
            id, pipeline_run_id, project_id, work_item_id, stage, attempt, status, version,
            started_at, finished_at, failure_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.id,
          attempt.pipelineRunId,
          attempt.projectId,
          attempt.workItemId,
          attempt.stage,
          attempt.attempt,
          attempt.status,
          attempt.version,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.failureCode,
        );
    };

    const updateStageAttempt = (attempt: StageAttempt): void => {
      const update = database
        .prepare(
          `UPDATE stage_attempts SET status = ?, version = ?, started_at = ?, finished_at = ?,
             failure_code = ? WHERE id = ? AND version = ?`,
        )
        .run(
          attempt.status,
          attempt.version,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.failureCode,
          attempt.id,
          attempt.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The StageAttempt changed while the command was being applied",
        );
      }
    };

    const insertWorkflowDispatch = (dispatch: WorkflowDispatch): void => {
      database
        .prepare(
          `INSERT INTO workflow_dispatches (
            id, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            mode, status, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dispatch.id,
          dispatch.projectId,
          dispatch.workItemId,
          dispatch.pipelineRunId,
          dispatch.stageAttemptId,
          dispatch.mode,
          dispatch.status,
          dispatch.createdAt,
          dispatch.completedAt,
        );
    };

    const updateWorkflowDispatch = (dispatch: WorkflowDispatch): void => {
      const update = database
        .prepare(
          "UPDATE workflow_dispatches SET status = ?, completed_at = ? WHERE id = ? AND status = 'PENDING'",
        )
        .run(dispatch.status, dispatch.completedAt, dispatch.id);
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_DISPATCH_ALREADY_COMPLETED",
          "The workflow dispatch has already been applied",
        );
      }
    };

    const insertHumanRequest = (request: HumanRequest): void => {
      database
        .prepare(
          `INSERT INTO human_requests (
            id, project_id, work_item_id, stage_attempt_id, kind, blocking, title, context,
            recommendation, allow_other, status, version, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.projectId,
          request.workItemId,
          request.stageAttemptId,
          request.kind,
          request.blocking ? 1 : 0,
          request.title,
          request.context,
          request.recommendation,
          request.allowOther ? 1 : 0,
          request.status,
          request.version,
          request.createdAt,
          request.resolvedAt,
        );
      const insertOption = database.prepare(
        `INSERT INTO human_request_options
         (human_request_id, ordinal, id, label, consequence, recommended)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      request.options.forEach((option, ordinal) => {
        insertOption.run(
          request.id,
          ordinal,
          option.id,
          option.label,
          option.consequence,
          option.recommended ? 1 : 0,
        );
      });
    };

    const updateHumanRequest = (request: HumanRequest): void => {
      const update = database
        .prepare(
          `UPDATE human_requests SET status = ?, version = ?, resolved_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(request.status, request.version, request.resolvedAt, request.id, request.version - 1);
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The HumanRequest changed while the answer was being applied",
        );
      }
    };

    const insertDecision = (decision: Decision): void => {
      database
        .prepare(
          `INSERT INTO decisions (
            id, schema_version, project_id, work_item_id, human_request_id, answer_json,
            actor_type, actor_id, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.schemaVersion,
          decision.projectId,
          decision.workItemId,
          decision.humanRequestId,
          JSON.stringify(decision.answer),
          decision.actor.type,
          decision.actor.id,
          decision.reason,
          decision.createdAt,
        );
    };

    const persistWorkItemDecision = (command: WorkItemCommand, decision: WorkItemDecision): void => {
      const item = decision.workItem;
      if (command.type === "CREATE_WORK_ITEM") {
        database
          .prepare(
            `INSERT INTO work_items (
              id, project_id, parent_id, type, title, description, state, current_stage,
              priority, risk, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.projectId,
            item.parentId,
            item.type,
            item.title,
            item.description,
            item.state,
            item.currentStage,
            item.priority,
            item.risk,
            item.version,
            item.createdAt,
            item.updatedAt,
          );
      } else {
        const update = database
          .prepare(
            `UPDATE work_items SET
              title = ?, description = ?, state = ?, current_stage = ?, priority = ?, risk = ?,
              version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            item.title,
            item.description,
            item.state,
            item.currentStage,
            item.priority,
            item.risk,
            item.version,
            item.updatedAt,
            item.id,
            item.version - 1,
          );
        if (update.changes !== 1) {
          throw new WorkItemDomainError(
            "VERSION_CONFLICT",
            "The WorkItem changed while the command was being applied",
          );
        }
      }
      writeCriteria(item);
    };

    const executeFresh = (command: StateCommand, occurredAt: string): StateCommandResult => {
      if (command.type === "REGISTER_FIXTURE_PROJECT") {
        const existing = database
          .prepare(
            `SELECT id FROM projects
             WHERE id = ? OR fixture_id = ? OR repository_path = ? LIMIT 1`,
          )
          .get(command.payload.id, command.payload.fixtureId, command.payload.repositoryPath);
        if (existing !== undefined) {
          throw new StateStoreError(
            "PROJECT_ALREADY_REGISTERED",
            "The fixture Project is already registered",
          );
        }
        const project = projectSchema.parse({
          schemaVersion: 1,
          id: command.payload.id,
          workspaceId: DEFAULT_WORKSPACE_ID,
          fixtureId: command.payload.fixtureId,
          name: command.payload.name,
          repositoryPath: command.payload.repositoryPath,
          status: "ACTIVE",
          version: 1,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        database
          .prepare(
            `INSERT INTO projects (
              id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            project.id,
            project.workspaceId,
            project.fixtureId,
            project.name,
            project.repositoryPath,
            project.status,
            project.version,
            project.createdAt,
            project.updatedAt,
          );
        const event = appendProjectEvent(project, command, occurredAt);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_REGISTERED",
          replayed: false,
          project,
          event,
        });
      }

      if (command.type === "START_MOCK_PIPELINE") {
        const workItem = readWorkItem(command.payload.workItemId);
        if (!workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const activeRunValue = selectActivePipelineRun.get(workItem.id);
        const activeRun = activeRunValue === undefined ? null : pipelineRunFromRow(activeRunValue);
        const hasChildren =
          database
            .prepare("SELECT 1 AS present FROM work_items WHERE parent_id = ? LIMIT 1")
            .get(workItem.id) !== undefined;
        const decision = decideStartMockPipeline(command, {
          now: occurredAt,
          workItem,
          activeRun,
          hasChildren,
          ids: {
            pipelineRunId: createId("pipelineRun"),
            stageAttemptId: createId("stageAttempt"),
            dispatchId: createId("workflowDispatch"),
          },
        });
        persistWorkflowTemplate(command.payload.template, occurredAt);
        updateWorkflowWorkItem(decision.workItem);
        insertPipelineRun(decision.run);
        insertStageAttempt(decision.stageAttempt);
        insertWorkflowDispatch(decision.dispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PIPELINE_STARTED",
          replayed: false,
          workItemId: decision.workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (command.type === "APPLY_MOCK_PROVIDER_OUTCOME") {
        const dispatch = readWorkflowDispatch(command.payload.dispatchId);
        if (!dispatch) {
          throw new WorkflowDomainError(
            "WORKFLOW_DISPATCH_NOT_FOUND",
            "The workflow dispatch does not exist",
          );
        }
        const run = readPipelineRun(dispatch.pipelineRunId);
        const stageAttempt = readStageAttempt(dispatch.stageAttemptId);
        const workItem = readWorkItem(dispatch.workItemId);
        if (!run || !stageAttempt || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const decision = decideApplyMockProviderOutcome(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          dispatch,
          humanRequestId: createId("humanRequest"),
          nextStageAttemptId: createId("stageAttempt"),
          nextDispatchId: createId("workflowDispatch"),
        });
        persistWorkflowTemplate(command.payload.template, occurredAt);
        updateWorkflowDispatch(decision.dispatch);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        if (decision.workItem.version !== workItem.version) updateWorkflowWorkItem(decision.workItem);
        if (decision.request) insertHumanRequest(decision.request);
        if (decision.nextStageAttempt) insertStageAttempt(decision.nextStageAttempt);
        if (decision.nextDispatch) insertWorkflowDispatch(decision.nextDispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MOCK_PROVIDER_OUTCOME_APPLIED",
          replayed: false,
          workItemId: decision.workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          events,
        });
      }

      if (command.type === "ANSWER_HUMAN_REQUEST") {
        const request = readHumanRequest(command.payload.humanRequestId);
        if (!request) {
          throw new WorkflowDomainError("HUMAN_REQUEST_NOT_FOUND", "The HumanRequest does not exist");
        }
        const stageAttempt = readStageAttempt(request.stageAttemptId);
        const run = stageAttempt ? readPipelineRun(stageAttempt.pipelineRunId) : null;
        const workItem = readWorkItem(request.workItemId);
        if (!stageAttempt || !run || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const decision = decideAnswerHumanRequest(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          request,
          decisionId: createId("decision"),
          dispatchId: createId("workflowDispatch"),
        });
        updateHumanRequest(decision.request);
        insertDecision(decision.decision);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        insertWorkflowDispatch(decision.dispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "HUMAN_REQUEST_ANSWERED",
          replayed: false,
          workItemId: decision.workItem.id,
          request: decision.request,
          decision: decision.decision,
          dispatch: decision.dispatch,
          events,
        });
      }

      const projectId =
        command.type === "CREATE_WORK_ITEM"
          ? command.payload.projectId
          : readWorkItem(command.payload.workItemId)?.projectId;
      if (!projectId || !readProject(projectId)) {
        throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
      }

      const current =
        command.type === "CREATE_WORK_ITEM"
          ? undefined
          : (readWorkItem(command.payload.workItemId) ?? undefined);
      const parent =
        command.type === "CREATE_WORK_ITEM" && command.payload.parentId !== null
          ? (readWorkItem(command.payload.parentId) ?? undefined)
          : undefined;
      if (
        command.type === "MOVE_WORK_ITEM" &&
        current &&
        selectActivePipelineRun.get(current.id) !== undefined
      ) {
        throw new WorkItemDomainError(
          "ACTIVE_WORKFLOW_CONTROLS_STATE",
          "The active workflow controls this WorkItem state until it stops",
        );
      }
      const hasChildren =
        current === undefined
          ? false
          : database
              .prepare("SELECT 1 AS present FROM work_items WHERE parent_id = ? LIMIT 1")
              .get(current.id) !== undefined;
      const decision = decideWorkItemCommand(command, {
        now: occurredAt,
        ...(command.type === "CREATE_WORK_ITEM" ? { newWorkItemId: createId("workItem") } : {}),
        ...(current === undefined ? {} : { current }),
        ...(parent === undefined ? {} : { parent }),
        hasChildren,
      });
      persistWorkItemDecision(command, decision);
      const event = appendEvent(decision.event, {
        aggregateId: decision.workItem.id,
        projectId: decision.workItem.projectId,
        actor: command.actor,
        occurredAt,
        correlationId: command.correlationId,
      });

      switch (decision.event.type) {
        case "WORK_ITEM_CREATED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_CREATED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
        case "WORK_ITEM_UPDATED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_UPDATED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
        case "WORK_ITEM_STATE_CHANGED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_MOVED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
      }
    };

    const execute = (input: StateCommand): StateCommandResult => {
      assertOpen();
      const command = stateCommandSchema.parse(input);
      const inputHash = commandHash(command);
      let transactionStarted = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        const receiptValue = selectCommandReceipt.get(command.commandId);
        if (receiptValue !== undefined) {
          const receipt = commandReceiptRowSchema.parse(receiptValue);
          if (receipt.command_type !== command.type || receipt.input_hash !== inputHash) {
            throw new StateStoreError(
              "COMMAND_ID_REUSED",
              "The command ID was already used for different input",
            );
          }
          const replayed = asReplayed(stateCommandResultSchema.parse(parseJson(receipt.result_json)));
          database.exec("COMMIT");
          transactionStarted = false;
          return replayed;
        }

        const occurredAt = now().toISOString();
        const result = executeFresh(command, occurredAt);
        insertCommandReceipt.run(
          command.commandId,
          command.type,
          inputHash,
          JSON.stringify(result),
          occurredAt,
        );
        database.exec("COMMIT");
        transactionStarted = false;
        return result;
      } catch (error: unknown) {
        if (transactionStarted) database.exec("ROLLBACK");
        if (
          error instanceof WorkItemDomainError ||
          error instanceof WorkflowDomainError ||
          error instanceof StateStoreError
        )
          throw error;
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The local state command could not be applied",
          {},
          { cause: error },
        );
      }
    };

    const query = (input: StateQuery): StateQueryResult => {
      assertOpen();
      const queryValue = stateQuerySchema.parse(input);
      switch (queryValue.type) {
        case "LIST_PROJECTS":
          return {
            type: "PROJECTS",
            projects: database
              .prepare("SELECT * FROM projects ORDER BY created_at, id")
              .all()
              .map(projectFromRow),
          };
        case "GET_PROJECT":
          return { type: "PROJECT", project: readProject(queryValue.projectId) };
        case "GET_WORK_ITEM":
          return { type: "WORK_ITEM", workItem: readWorkItem(queryValue.workItemId) };
        case "GET_WORKFLOW_SNAPSHOT":
          return { type: "WORKFLOW_SNAPSHOT", snapshot: readWorkflowSnapshot(queryValue.workItemId) };
        case "LIST_HUMAN_REQUESTS": {
          const rows = database
            .prepare(
              `SELECT * FROM human_requests
               WHERE (? IS NULL OR project_id = ?)
                 AND (? IS NULL OR status = ?)
               ORDER BY blocking DESC, created_at, id`,
            )
            .all(
              queryValue.projectId ?? null,
              queryValue.projectId ?? null,
              queryValue.status ?? null,
              queryValue.status ?? null,
            );
          return {
            type: "HUMAN_REQUESTS",
            humanRequests: humanRequestRowSchema
              .array()
              .parse(rows)
              .map((row) => {
                const request = readHumanRequest(row.id);
                if (!request) {
                  throw new StateStoreError(
                    "PERSISTENCE_FAILURE",
                    "A listed HumanRequest could not be reloaded",
                  );
                }
                return request;
              }),
          };
        }
        case "LIST_PENDING_DISPATCHES":
          return {
            type: "WORKFLOW_DISPATCHES",
            dispatches: database
              .prepare("SELECT * FROM workflow_dispatches WHERE status = 'PENDING' ORDER BY created_at, id")
              .all()
              .map(workflowDispatchFromRow),
          };
        case "LIST_WORK_ITEMS": {
          const rows =
            queryValue.state === undefined
              ? database
                  .prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at, id")
                  .all(queryValue.projectId)
              : database
                  .prepare(
                    "SELECT * FROM work_items WHERE project_id = ? AND state = ? ORDER BY created_at, id",
                  )
                  .all(queryValue.projectId, queryValue.state);
          return {
            type: "WORK_ITEMS",
            workItems: workItemRowSchema
              .array()
              .parse(rows)
              .map((row) => {
                const item = readWorkItem(row.id);
                if (!item) {
                  throw new StateStoreError("PERSISTENCE_FAILURE", "A listed WorkItem could not be reloaded");
                }
                return item;
              }),
          };
        }
        case "LIST_EVENTS": {
          const events = database
            .prepare(
              `SELECT * FROM events
               WHERE sequence > ?
                 AND (? IS NULL OR project_id = ?)
                 AND (? IS NULL OR aggregate_id = ?)
               ORDER BY sequence
               LIMIT ?`,
            )
            .all(
              queryValue.afterSequence,
              queryValue.projectId ?? null,
              queryValue.projectId ?? null,
              queryValue.aggregateId ?? null,
              queryValue.aggregateId ?? null,
              queryValue.limit,
            )
            .map(eventFromRow);
          return {
            type: "EVENTS",
            events,
            nextSequence: events.at(-1)?.sequence ?? queryValue.afterSequence,
          };
        }
        default:
          return assertNever(queryValue);
      }
    };

    return {
      startup,
      execute,
      query,
      close: () => {
        if (closed) return;
        database.close();
        closed = true;
      },
    };
  } catch (error: unknown) {
    database.close();
    throw error;
  }
};
