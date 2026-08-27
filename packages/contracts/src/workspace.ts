import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

// A Git object id (spec §2.9). Not a general opaqueIdSchema: an object id has a shape of its own,
// unrelated to Loomrail's id shape, and validating it here catches a caller that passes a truncated
// or garbled sha before it is ever handed to `git`.
//
// Lowercase 40 hex is SHA-1, and that is a statement about THIS codebase rather than about git: git
// also supports SHA-256 repositories, whose object ids are 64 hex characters, and a schema claiming
// git's format is fixed would simply be wrong. Every sha reaching this contract comes from
// `@loomrail/workspace` running plumbing against a repository Loomrail itself cut a worktree from,
// and nothing in this project creates or accepts a SHA-256 repository. Widening this regex is
// therefore part of adding that support, not a bug fix -- and until then the narrow bound is what
// catches a caller passing something that is not an object id at all.
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

const branchSchema = z.string().trim().min(1).max(255);
const worktreePathSchema = z.string().trim().min(1).max(4_000);

// The cap on how many paths one WORK_ITEM_WORKSPACE_CREATED event may list. Exported alongside the
// schema that uses it (like maxContextPackRecipeSources in workflow.ts) so a caller building the
// carry-in list can check it against the same bound the schema will enforce, rather than
// discovering the limit only when `.parse` rejects it.
export const maxCarriedPaths = 500;

// Relative repository paths, one per file the carry-in snapshot (packages/workspace's
// createCarryInSnapshot) actually moved -- see docs/plans/14-e1-workspace-execution-implementation-
// plan.ru.md Задача 4. Not opaqueIdSchema: these are filesystem paths, not Loomrail ids, and can
// contain characters (slashes, dots) opaqueIdSchema's pattern forbids.
const carriedPathsSchema = z.array(z.string().trim().min(1).max(4_096)).max(maxCarriedPaths);

export const workItemWorkspaceStatusSchema = z.enum(["READY", "ORPHANED", "REMOVED"]);

export const workItemWorkspaceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    branch: branchSchema,
    worktreePath: worktreePathSchema,
    // Nullable, not optional: an empty repository genuinely has no HEAD (spec §2.12). Absent would
    // read as "not recorded"; null records the fact that there was nothing to record.
    baseCommit: commitShaSchema.nullable(),
    // Nullable, not optional: a workspace cut from a clean working copy genuinely carried nothing
    // forward, so there is no snapshot commit to name (spec §2.9's "переносить нечего" path).
    snapshotCommit: commitShaSchema.nullable(),
    status: workItemWorkspaceStatusSchema,
    // Nullable: names the StageAttempt currently allowed to write, or no one (spec D6). The
    // workspace belongs to the WorkItem and outlives any single attempt, so this is a lease held
    // for the attempt's duration, not an owner.
    leaseHolder: opaqueIdSchema.nullable(),
    createdAt: utcTimestampSchema,
    version: z.number().int().positive(),
  })
  .strict();

const eventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

// Carries the workspace plus the files the carry-in snapshot moved into it (spec §4): the
// workspace's own worktreePath/branch/baseCommit/snapshotCommit tell a reader *that* something was
// carried in, but not *what* -- and that is exactly what an owner reviewing the work item's history
// needs to see without re-deriving a `git diff` against a commit that may since have moved on.
export const workItemWorkspaceCreatedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORK_ITEM_WORKSPACE_CREATED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      workspace: workItemWorkspaceSchema,
      carriedPaths: carriedPathsSchema,
    })
    .strict(),
});

// Recorded when a workspace is found orphaned -- its worktree directory prunable, or gone outside
// Loomrail's control -- at daemon startup (spec §6, "Восстановление"). previousStatus is carried
// because the only status this transition is ever taken from is READY, and recording that fact
// (rather than assuming it) keeps the audit trail honest if that ever stops being true.
export const workItemWorkspaceOrphanedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORK_ITEM_WORKSPACE_ORPHANED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      workspace: workItemWorkspaceSchema,
      previousStatus: workItemWorkspaceStatusSchema,
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

// The workspace's own `id` is not part of the payload -- it is assigned by the persistence layer
// that writes it, the same way CREATE_WORK_ITEM never takes the WorkItem's own id (work-
// management.ts). `workItemId` is enough to identify which entity this workspace belongs to, and
// the 0011 migration's UNIQUE constraint on work_item_id (spec Задача 7) makes a second one for the
// same WorkItem a storage-level refusal, not something this contract has to guard against.
export const createWorkItemWorkspaceCommandSchema = commandBaseSchema.extend({
  type: z.literal("CREATE_WORK_ITEM_WORKSPACE"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      projectId: opaqueIdSchema,
      branch: branchSchema,
      worktreePath: worktreePathSchema,
      baseCommit: commitShaSchema.nullable(),
      snapshotCommit: commitShaSchema.nullable(),
      carriedPaths: carriedPathsSchema,
    })
    .strict(),
});

// expectedVersion follows the same optimistic-concurrency convention as every other mutation of an
// existing entity in this package (UPDATE_WORK_ITEM, PAUSE_PIPELINE, RESOLVE_ACCEPTANCE, …): the
// caller names the version it read, so a lease raced against a concurrent writer is rejected rather
// than silently overwritten.
export const acquireWorkspaceLeaseCommandSchema = commandBaseSchema.extend({
  type: z.literal("ACQUIRE_WORKSPACE_LEASE"),
  payload: z
    .object({
      workspaceId: opaqueIdSchema,
      stageAttemptId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

// Names the releasing StageAttempt, not just the workspace: a release is only ever valid from the
// attempt that currently holds the lease (spec D6), and carrying that id lets the handler refuse a
// release from anyone else instead of trusting the caller's say-so.
export const releaseWorkspaceLeaseCommandSchema = commandBaseSchema.extend({
  type: z.literal("RELEASE_WORKSPACE_LEASE"),
  payload: z
    .object({
      workspaceId: opaqueIdSchema,
      stageAttemptId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

// System-driven, not a StageAttempt action: this is the reconciliation path (spec §6,
// "Восстановление") that notices a worktree directory is gone or prunable and records the fact.
// Nothing is resurrected (AD-008) -- this command only ever moves a workspace toward ORPHANED.
export const markWorkspaceOrphanedCommandSchema = commandBaseSchema.extend({
  type: z.literal("MARK_WORKSPACE_ORPHANED"),
  payload: z
    .object({
      workspaceId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

// Command results, in the shape stateCommandResultSchema (work-management.ts) expects of every
// member: schemaVersion/type/replayed plus whatever the caller needs back. `workItemId` is carried
// even though every payload already lets a caller re-derive it, the same convenience
// providerSessionStartedResultSchema (workflow.ts) offers -- a caller acting on the result should
// not have to also hold the command payload just to route the outcome to the right WorkItem.
export const workItemWorkspaceCreatedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORK_ITEM_WORKSPACE_CREATED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    workspace: workItemWorkspaceSchema,
    event: workItemWorkspaceCreatedEventSchema,
  })
  .strict();

// No event: a lease is current state for a StageAttempt to act on, not something the audit log or
// the owner needs to see -- the same reasoning providerSessionProcessRecordedResultSchema
// (workflow.ts) gives for a pid. `events` stays in the shape for uniformity across every command
// result, typed so only `[]` can satisfy it.
export const workspaceLeaseAcquiredResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORKSPACE_LEASE_ACQUIRED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    workspace: workItemWorkspaceSchema,
    events: z.array(z.never()),
  })
  .strict();

export const workspaceLeaseReleasedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORKSPACE_LEASE_RELEASED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    workspace: workItemWorkspaceSchema,
    events: z.array(z.never()),
  })
  .strict();

export const workItemWorkspaceOrphanedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORK_ITEM_WORKSPACE_ORPHANED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    workspace: workItemWorkspaceSchema,
    event: workItemWorkspaceOrphanedEventSchema,
  })
  .strict();

// What `GET /api/v1/work-items/:workItemId/workspace` answers: the workspace a WorkItem has, or the
// recorded fact that it has none.
//
// `null` rather than a 404, because "this WorkItem has no workspace" is the ordinary state of every
// prose-only stage and of every work item before its first code stage -- not a missing resource. A
// 404 would make the caller distinguish "no workspace" from "no such WorkItem" by inspecting an
// error code, and the cockpit asks this question for whichever item the owner selected, most of
// which have never cut one.
//
// A response object rather than the bare workspace for the same reason every other listing here
// wraps its payload (projectsResponseSchema, workItemsResponseSchema): a top-level `null` body
// carries no schemaVersion, so a later field could not be added without breaking every reader.
//
// `leaseHolder` is deliberately not on it. The lease is how the daemon keeps two StageAttempts from
// writing the same worktree at once (spec D6); no caller of this route reads it, and none is
// planned to -- the cockpit shows where the agent writes, not which attempt currently holds the
// pen. A field on a response nobody reads is a declaration without a consumer, so the response
// projects the stored workspace rather than forwarding it whole.
export const publishedWorkItemWorkspaceSchema = workItemWorkspaceSchema.omit({ leaseHolder: true });

export const workItemWorkspaceResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    workspace: publishedWorkItemWorkspaceSchema.nullable(),
  })
  .strict();

export type WorkItemWorkspaceStatus = z.infer<typeof workItemWorkspaceStatusSchema>;
export type WorkItemWorkspaceResponse = z.infer<typeof workItemWorkspaceResponseSchema>;
export type PublishedWorkItemWorkspace = z.infer<typeof publishedWorkItemWorkspaceSchema>;
export type WorkItemWorkspace = z.infer<typeof workItemWorkspaceSchema>;
export type WorkItemWorkspaceCreatedEvent = z.infer<typeof workItemWorkspaceCreatedEventSchema>;
export type WorkItemWorkspaceOrphanedEvent = z.infer<typeof workItemWorkspaceOrphanedEventSchema>;
export type CreateWorkItemWorkspaceCommand = z.infer<typeof createWorkItemWorkspaceCommandSchema>;
export type AcquireWorkspaceLeaseCommand = z.infer<typeof acquireWorkspaceLeaseCommandSchema>;
export type ReleaseWorkspaceLeaseCommand = z.infer<typeof releaseWorkspaceLeaseCommandSchema>;
export type MarkWorkspaceOrphanedCommand = z.infer<typeof markWorkspaceOrphanedCommandSchema>;
export type WorkItemWorkspaceCreatedResult = z.infer<typeof workItemWorkspaceCreatedResultSchema>;
export type WorkspaceLeaseAcquiredResult = z.infer<typeof workspaceLeaseAcquiredResultSchema>;
export type WorkspaceLeaseReleasedResult = z.infer<typeof workspaceLeaseReleasedResultSchema>;
export type WorkItemWorkspaceOrphanedResult = z.infer<typeof workItemWorkspaceOrphanedResultSchema>;
