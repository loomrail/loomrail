import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  domainEventSchema,
  opaqueIdSchema,
  projectSchema,
  stateCommandResultSchema,
  stateCommandSchema,
  workItemSchema,
  workItemStateSchema,
  type Actor,
  type DomainEvent,
  type Project,
  type RegisterProjectCommand,
  type StateCommand,
  type StateCommandResult,
  type WorkItem,
} from "@loomrail/contracts";
import {
  decideWorkItemCommand,
  WorkItemDomainError,
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

const stateQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LIST_PROJECTS") }).strict(),
  z.object({ type: z.literal("GET_PROJECT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORK_ITEM"), workItemId: opaqueIdSchema }).strict(),
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

    const persistWorkItemDecision = (
      command: Exclude<StateCommand, RegisterProjectCommand>,
      decision: WorkItemDecision,
    ): void => {
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
        if (error instanceof WorkItemDomainError || error instanceof StateStoreError) throw error;
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
