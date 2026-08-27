import { describe, expect, it } from "vitest";

import {
  acquireWorkspaceLeaseCommandSchema,
  createWorkItemWorkspaceCommandSchema,
  markWorkspaceOrphanedCommandSchema,
  maxCarriedPaths,
  releaseWorkspaceLeaseCommandSchema,
  workItemWorkspaceCreatedEventSchema,
  workItemWorkspaceOrphanedEventSchema,
  workItemWorkspaceResponseSchema,
  workItemWorkspaceSchema,
} from "../src/index.js";

// Drops one key from a fixture built by validWorkspace/validAcquireCommand/etc. so a negative case
// can test "this field is missing" without a destructured-and-discarded binding that
// @typescript-eslint/no-unused-vars (no varsIgnorePattern configured in this repo) refuses to let
// through even when it is prefixed `_`.
const omitField = (object: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...object };
  Reflect.deleteProperty(copy, key);
  return copy;
};

describe("work item workspace contracts", () => {
  // Built field by field, not by omitting the one field a test names -- a `.toThrow()` test that
  // starts from an incomplete fixture passes because the fixture is incomplete, not because of the
  // violation the test claims to check (this bit packages/contracts/test/session.unit.test.ts
  // during A2). Every negative case below starts from this complete, valid object and changes
  // exactly one field.
  const validWorkspace = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    id: "workspace-1",
    projectId: "project-1",
    workItemId: "workItem-1",
    branch: "loomrail/9a342451-fix-the-login-redirect",
    worktreePath: "/var/loomrail/worktrees/workspace-1",
    baseCommit: "a".repeat(40),
    snapshotCommit: "b".repeat(40),
    status: "READY",
    leaseHolder: null,
    createdAt: "2026-08-26T18:00:00.000Z",
    version: 1,
    ...overrides,
  });

  it("accepts a well-formed workspace with a base commit, a snapshot, and no lease", () => {
    expect(workItemWorkspaceSchema.parse(validWorkspace())).toBeTruthy();
  });

  it("accepts a workspace with no base commit and no snapshot, because an empty repository has neither", () => {
    expect(
      workItemWorkspaceSchema.parse(validWorkspace({ baseCommit: null, snapshotCommit: null })),
    ).toBeTruthy();
  });

  it("accepts a workspace currently leased to a stage attempt", () => {
    expect(workItemWorkspaceSchema.parse(validWorkspace({ leaseHolder: "attempt-1" }))).toBeTruthy();
  });

  it("refuses a workspace that names no worktree", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ worktreePath: "" }))).toThrow();
  });

  it("does not silently accept a field nobody declared", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ remoteUrl: "x" }))).toThrow();
  });

  it("refuses a branch name that is empty", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ branch: "" }))).toThrow();
  });

  // Both sides of the bound in one test, each changing exactly one field of the complete fixture: a
  // bound asserted only from above passes just as happily when someone moves it, and one asserted
  // only from below never notices it being dropped. 255 is git's own limit on a single path
  // component under `.git/refs`, which is what a branch name becomes.
  it("accepts a branch name at 255 characters and refuses one past it", () => {
    expect(workItemWorkspaceSchema.parse(validWorkspace({ branch: "b".repeat(255) }))).toBeTruthy();
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ branch: "b".repeat(256) }))).toThrow();
  });

  // The same shape for the worktree path. Nothing in Loomrail generates a path anywhere near 4000
  // -- the bound is there so a caller cannot hand the daemon an unbounded string to store, log and
  // interpolate into an owner-facing question -- which is exactly why nothing would notice it going
  // away without this.
  it("accepts a worktree path at 4000 characters and refuses one past it", () => {
    const at = `/var/loomrail/${"w".repeat(4_000 - "/var/loomrail/".length)}`;
    expect(workItemWorkspaceSchema.parse(validWorkspace({ worktreePath: at }))).toBeTruthy();
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ worktreePath: `${at}w` }))).toThrow();
  });

  it("refuses a base commit that is not a 40-character hex sha", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ baseCommit: "not-a-sha" }))).toThrow();
  });

  it("refuses a snapshot commit that is not a 40-character hex sha", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ snapshotCommit: "a".repeat(39) }))).toThrow();
  });

  it("refuses baseCommit being omitted rather than recorded as null", () => {
    expect(() => workItemWorkspaceSchema.parse(omitField(validWorkspace(), "baseCommit"))).toThrow();
  });

  it("refuses a status outside READY, ORPHANED, REMOVED", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ status: "REMOVING" }))).toThrow();
  });

  it("refuses a non-positive version", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ version: 0 }))).toThrow();
  });

  it("refuses a lease holder that is not a valid id", () => {
    expect(() => workItemWorkspaceSchema.parse(validWorkspace({ leaseHolder: "" }))).toThrow();
  });

  const validCreatedEvent = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    sequence: 1,
    id: "event-1",
    aggregateId: "workItem-1",
    projectId: "project-1",
    actor: { type: "SYSTEM", id: "daemon" },
    occurredAt: "2026-08-26T18:00:00.000Z",
    correlationId: "correlation-1",
    type: "WORK_ITEM_WORKSPACE_CREATED",
    aggregateType: "WORK_ITEM",
    data: {
      workspace: validWorkspace(),
      carriedPaths: ["tracked-modified.txt", "subdir/untracked-nested.txt"],
    },
    ...overrides,
  });

  it("accepts a well-formed workspace-created event, including its carried paths", () => {
    expect(workItemWorkspaceCreatedEventSchema.parse(validCreatedEvent())).toBeTruthy();
  });

  it("accepts a workspace-created event that carried nothing in", () => {
    expect(
      workItemWorkspaceCreatedEventSchema.parse(
        validCreatedEvent({ data: { workspace: validWorkspace(), carriedPaths: [] } }),
      ),
    ).toBeTruthy();
  });

  it("refuses a workspace-created event with more than 500 carried paths", () => {
    const tooMany = Array.from({ length: maxCarriedPaths + 1 }, (_, index) => `file-${String(index)}.txt`);
    expect(() =>
      workItemWorkspaceCreatedEventSchema.parse(
        validCreatedEvent({ data: { workspace: validWorkspace(), carriedPaths: tooMany } }),
      ),
    ).toThrow();
  });

  // The other bound on the carried-in list, and the one nothing reached: `maxCarriedPaths` caps how
  // MANY paths may be listed, this caps how long any one of them may be. A list of 500 unbounded
  // strings is not a bounded event, and this event is persisted and replayed.
  it("accepts a carried path at 4096 characters and refuses one past it", () => {
    const at = "p".repeat(4_096);
    const eventWith = (path: string): Record<string, unknown> =>
      validCreatedEvent({ data: { workspace: validWorkspace(), carriedPaths: [path] } });
    expect(workItemWorkspaceCreatedEventSchema.parse(eventWith(at))).toBeTruthy();
    expect(() => workItemWorkspaceCreatedEventSchema.parse(eventWith(`${at}p`))).toThrow();
  });

  it("does not silently accept a field the workspace-created event never declared", () => {
    expect(() => workItemWorkspaceCreatedEventSchema.parse({ ...validCreatedEvent(), extra: "x" })).toThrow();
  });

  const validOrphanedEvent = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    sequence: 2,
    id: "event-2",
    aggregateId: "workItem-1",
    projectId: "project-1",
    actor: { type: "SYSTEM", id: "daemon" },
    occurredAt: "2026-08-26T18:05:00.000Z",
    correlationId: "correlation-1",
    type: "WORK_ITEM_WORKSPACE_ORPHANED",
    aggregateType: "WORK_ITEM",
    data: {
      workspace: validWorkspace({ status: "ORPHANED" }),
      previousStatus: "READY",
    },
    ...overrides,
  });

  it("accepts a well-formed workspace-orphaned event", () => {
    expect(workItemWorkspaceOrphanedEventSchema.parse(validOrphanedEvent())).toBeTruthy();
  });

  it("does not silently accept a field the workspace-orphaned event never declared", () => {
    expect(() =>
      workItemWorkspaceOrphanedEventSchema.parse({ ...validOrphanedEvent(), extra: "x" }),
    ).toThrow();
  });

  const validCreateCommand = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    commandId: "command-1",
    correlationId: "correlation-1",
    actor: { type: "SYSTEM", id: "daemon" },
    type: "CREATE_WORK_ITEM_WORKSPACE",
    payload: {
      workItemId: "workItem-1",
      projectId: "project-1",
      branch: "loomrail/9a342451-fix-the-login-redirect",
      worktreePath: "/var/loomrail/worktrees/workspace-1",
      baseCommit: "a".repeat(40),
      snapshotCommit: "b".repeat(40),
      carriedPaths: ["tracked-modified.txt"],
    },
    ...overrides,
  });

  it("accepts a well-formed create-workspace command", () => {
    expect(createWorkItemWorkspaceCommandSchema.parse(validCreateCommand())).toBeTruthy();
  });

  it("accepts a create-workspace command cut from an empty repository", () => {
    expect(
      createWorkItemWorkspaceCommandSchema.parse(
        validCreateCommand({
          payload: {
            ...validCreateCommand().payload,
            baseCommit: null,
            snapshotCommit: null,
            carriedPaths: [],
          },
        }),
      ),
    ).toBeTruthy();
  });

  // The payload applies the same nullable-not-optional discipline as the entity -- an empty
  // repository genuinely has no HEAD, and null RECORDS that where absent would read as "not
  // recorded" -- but only the entity had the test. Written the same way, from the complete valid
  // payload with exactly one key removed.
  it("refuses baseCommit being omitted from the create-workspace payload rather than recorded as null", () => {
    const { payload, ...rest } = validCreateCommand();
    const payloadWithoutBaseCommit = omitField(payload, "baseCommit");
    expect(() =>
      createWorkItemWorkspaceCommandSchema.parse({ ...rest, payload: payloadWithoutBaseCommit }),
    ).toThrow();
  });

  it("does not silently accept a field the create-workspace command never declared", () => {
    expect(() =>
      createWorkItemWorkspaceCommandSchema.parse({
        ...validCreateCommand(),
        payload: { ...validCreateCommand().payload, id: "workspace-1" },
      }),
    ).toThrow();
  });

  const validAcquireCommand = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    commandId: "command-2",
    correlationId: "correlation-1",
    actor: { type: "SYSTEM", id: "daemon" },
    type: "ACQUIRE_WORKSPACE_LEASE",
    payload: {
      workspaceId: "workspace-1",
      stageAttemptId: "attempt-1",
      expectedVersion: 1,
    },
    ...overrides,
  });

  it("accepts a well-formed acquire-lease command", () => {
    expect(acquireWorkspaceLeaseCommandSchema.parse(validAcquireCommand())).toBeTruthy();
  });

  it("refuses an acquire-lease command with no expected version", () => {
    const { payload, ...rest } = validAcquireCommand();
    const payloadWithoutVersion = omitField(payload, "expectedVersion");
    expect(() =>
      acquireWorkspaceLeaseCommandSchema.parse({ ...rest, payload: payloadWithoutVersion }),
    ).toThrow();
  });

  const validReleaseCommand = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    commandId: "command-3",
    correlationId: "correlation-1",
    actor: { type: "SYSTEM", id: "daemon" },
    type: "RELEASE_WORKSPACE_LEASE",
    payload: {
      workspaceId: "workspace-1",
      stageAttemptId: "attempt-1",
      expectedVersion: 2,
    },
    ...overrides,
  });

  it("accepts a well-formed release-lease command", () => {
    expect(releaseWorkspaceLeaseCommandSchema.parse(validReleaseCommand())).toBeTruthy();
  });

  it("does not silently accept a field the release-lease command never declared", () => {
    expect(() =>
      releaseWorkspaceLeaseCommandSchema.parse({
        ...validReleaseCommand(),
        payload: { ...validReleaseCommand().payload, force: true },
      }),
    ).toThrow();
  });

  const validMarkOrphanedCommand = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    commandId: "command-4",
    correlationId: "correlation-1",
    actor: { type: "SYSTEM", id: "daemon" },
    type: "MARK_WORKSPACE_ORPHANED",
    payload: {
      workspaceId: "workspace-1",
      expectedVersion: 1,
    },
    ...overrides,
  });

  it("accepts a well-formed mark-orphaned command", () => {
    expect(markWorkspaceOrphanedCommandSchema.parse(validMarkOrphanedCommand())).toBeTruthy();
  });

  it("refuses a mark-orphaned command with no workspace id", () => {
    const { payload, ...rest } = validMarkOrphanedCommand();
    const payloadWithoutId = omitField(payload, "workspaceId");
    expect(() => markWorkspaceOrphanedCommandSchema.parse({ ...rest, payload: payloadWithoutId })).toThrow();
  });

  // The lease is how the daemon keeps two StageAttempts out of one worktree. It is stored, and it
  // is deliberately not published: no caller of the workspace route reads it, and a field on a
  // response with no consumer is a defect rather than a convenience.
  it("refuses a workspace response that carries the lease holder, or any other field its one reader never uses", () => {
    expect(() =>
      workItemWorkspaceResponseSchema.parse({ schemaVersion: 1, workspace: validWorkspace() }),
    ).toThrow();
    // `leaseHolder` alone gone is not enough: `publishedWorkItemWorkspaceSchema` (workspace.ts) also
    // drops `id`, `projectId`, `workItemId`, `createdAt` and `version` -- every field WorkspacePanel
    // (WorkbenchPage.tsx) does not read -- so a fixture that still carries any of those is refused the
    // same way a fixture carrying `leaseHolder` is.
    const publishedShape = ["id", "projectId", "workItemId", "createdAt", "version"].reduce(
      (workspace, field) => omitField(workspace, field),
      omitField(validWorkspace(), "leaseHolder"),
    );
    const fullWorkspace = validWorkspace();
    for (const field of ["id", "projectId", "workItemId", "createdAt", "version"]) {
      expect(() =>
        workItemWorkspaceResponseSchema.parse({
          schemaVersion: 1,
          workspace: { ...publishedShape, [field]: fullWorkspace[field as keyof typeof fullWorkspace] },
        }),
      ).toThrow();
    }
    expect(
      workItemWorkspaceResponseSchema.parse({
        schemaVersion: 1,
        workspace: publishedShape,
      }).workspace?.worktreePath,
    ).toBe("/var/loomrail/worktrees/workspace-1");
    // And "no workspace at all" is still the ordinary answer, not an error.
    expect(workItemWorkspaceResponseSchema.parse({ schemaVersion: 1, workspace: null }).workspace).toBeNull();
  });
});
