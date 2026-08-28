import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acquireWorkspaceLeaseCommandSchema,
  changedFileSchema,
  createWorkItemWorkspaceCommandSchema,
  fileDiffSchema,
  markWorkspaceOrphanedCommandSchema,
  maxCarriedPaths,
  releaseWorkspaceLeaseCommandSchema,
  workItemChangeSummarySchema,
  workItemChangesResponseSchema,
  workItemFileDiffResponseSchema,
  workItemWorkspaceCreatedEventSchema,
  workItemWorkspaceOrphanedEventSchema,
  workItemWorkspaceResponseSchema,
  workItemWorkspaceSchema,
} from "../src/index.js";
// Type-only, erased by verbatimModuleSyntax: reaches across a relative path into
// @loomrail/workspace's own source rather than the package "@loomrail/workspace", so neither
// package gains a dependency edge (see the long comment above workItemChangeSummarySchema in
// ../src/workspace.ts for why). ChangedFile and FileDiff are the ONE declaration of these shapes
// (Tasks 1-2 of this milestone); the equality checks below hold changedFileSchema/fileDiffSchema to
// it at the type level, in both directions, so the two cannot drift without `pnpm typecheck` (part
// of `pnpm verify`) catching it -- a stronger guarantee than any runtime fixture test can give,
// because a fixture only proves the cases it was given and this is checked against every field of
// the actual type.
import type {
  ChangedFile as WorkspaceChangedFile,
  FileDiff as WorkspaceFileDiff,
} from "../../workspace/src/changes.js";

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

describe("work item change summary and file diff contracts (E1.5, spec §4 §5)", () => {
  // Built field by field, then every negative case below changes exactly one field of it -- the
  // same discipline validWorkspace above documents and session.unit.test.ts (A2) is the cautionary
  // tale for.
  const validChangedFile = (overrides: Record<string, unknown> = {}) => ({
    path: "src/index.ts",
    previousPath: null,
    status: "MODIFIED",
    insertions: 3,
    deletions: 1,
    binary: false,
    ...overrides,
  });

  it("accepts a well-formed modified file", () => {
    expect(changedFileSchema.parse(validChangedFile())).toBeTruthy();
  });

  it("accepts a renamed file carrying its previous path", () => {
    expect(
      changedFileSchema.parse(validChangedFile({ status: "RENAMED", previousPath: "src/old-name.ts" })),
    ).toBeTruthy();
  });

  // Verbatim from the Task 3 brief (§ Задача 3, Step 1): the case this whole schema exists to get
  // right. A binary file's line counts are null, not zero -- zero would read as "nothing changed".
  it("keeps a binary file's line counts null, so zero cannot be read as `nothing changed`", () => {
    const parsed = changedFileSchema.parse({
      path: "pic.bin",
      previousPath: null,
      status: "MODIFIED",
      insertions: null,
      deletions: null,
      binary: true,
    });

    expect(parsed.insertions).toBeNull();
    expect(parsed.deletions).toBeNull();
  });

  // Verbatim from the Task 3 brief (§ Задача 3, Step 1): a file record carrying a field nobody
  // declared -- `hunks`, the kind of thing a careless refactor might one day bolt onto a
  // ChangedFile -- must be refused, not silently accepted.
  //
  // Mutation performed and reverted for this test: removed `.strict()` from changedFileSchema in
  // ../src/workspace.ts. Red, by assertion: "expected [Function] to throw" (the object parsed
  // successfully with `hunks` intact instead of throwing). Restored by re-adding `.strict()` --
  // never by `git checkout --`.
  it("refuses a file record carrying an unknown field", () => {
    expect(() =>
      changedFileSchema.parse({
        path: "a.txt",
        previousPath: null,
        status: "MODIFIED",
        insertions: 1,
        deletions: 1,
        binary: false,
        hunks: [],
      }),
    ).toThrow();
  });

  it("refuses a negative insertions count", () => {
    expect(() => changedFileSchema.parse(validChangedFile({ insertions: -1 }))).toThrow();
  });

  it("refuses a non-integer insertions count", () => {
    expect(() => changedFileSchema.parse(validChangedFile({ insertions: 1.5 }))).toThrow();
  });

  it("refuses a status outside ADDED, MODIFIED, DELETED, RENAMED", () => {
    expect(() => changedFileSchema.parse(validChangedFile({ status: "COPIED" }))).toThrow();
  });

  it("refuses an empty path", () => {
    expect(() => changedFileSchema.parse(validChangedFile({ path: "" }))).toThrow();
  });

  // Both sides of the bound, from the one complete fixture, the same shape as the worktree-path and
  // branch bound tests above. 4096 is the Task 3 brief's own figure ("path — до 4096 символов, как
  // carriedPathsSchema рядом").
  it("accepts a path at 4096 characters and refuses one past it", () => {
    const at = "p".repeat(4_096);
    expect(changedFileSchema.parse(validChangedFile({ path: at }))).toBeTruthy();
    expect(() => changedFileSchema.parse(validChangedFile({ path: `${at}p` }))).toThrow();
  });

  // A path is an IDENTIFIER on these two schemas, not an input to be tidied: the summary publishes
  // it and the file-diff handle has to accept the very same string back. `.trim()`, inherited from
  // `carriedPathsSchema` where it bounds an input list, broke that round trip -- a file really
  // named `"trail "` (a trailing space is a legal filename character on POSIX, and the summary
  // lists it that way) was published as `"trail"`, and asking for `"trail"` back earned a
  // PathNotAFileError for a file that is really there.
  //
  // Mutation performed and reverted for this test: put `.trim()` back on `changedPathSchema` in
  // ../src/workspace.ts. Red, by assertion, on the first expect of this test:
  // "expected 'dir/trail' to be 'dir/trail ' // Object.is equality". Restored by deleting
  // `.trim()` again, never by `git checkout --`.
  it("keeps a path with surrounding whitespace exactly as it was given, on both schemas", () => {
    const trailing = "dir/trail ";
    const leading = " dir/lead.txt";

    expect(changedFileSchema.parse(validChangedFile({ path: trailing })).path).toBe(trailing);
    expect(changedFileSchema.parse(validChangedFile({ path: leading })).path).toBe(leading);
    expect(
      changedFileSchema.parse(validChangedFile({ status: "RENAMED", previousPath: trailing })).previousPath,
    ).toBe(trailing);

    // The round trip itself, said in one line: what the summary publishes for a file is what the
    // file-diff handle accepts and republishes for it.
    const published = changedFileSchema.parse(validChangedFile({ path: trailing })).path;
    expect(fileDiffSchema.parse(validFileDiff({ path: published })).path).toBe(trailing);
  });

  const validChangeSummary = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    baseline: "a".repeat(40),
    files: [validChangedFile()],
    truncated: false,
    ...overrides,
  });

  it("accepts a well-formed change summary", () => {
    expect(workItemChangeSummarySchema.parse(validChangeSummary())).toBeTruthy();
  });

  // D7: an empty file list is "the worktree is unchanged", a fact about the world, not a refusal --
  // so the schema has to accept it rather than treat it as a shape the daemon failed to fill in.
  it("accepts a change summary with no changed files", () => {
    expect(workItemChangeSummarySchema.parse(validChangeSummary({ files: [] }))).toBeTruthy();
  });

  it("accepts a change summary marked truncated", () => {
    expect(workItemChangeSummarySchema.parse(validChangeSummary({ truncated: true }))).toBeTruthy();
  });

  it("refuses a change summary whose baseline is not a 40-character hex sha", () => {
    expect(() => workItemChangeSummarySchema.parse(validChangeSummary({ baseline: "not-a-sha" }))).toThrow();
  });

  // Unlike WorkItemWorkspace.baseCommit, `baseline` here is never null: a summary computed with no
  // base to compare against is not a summary at all (spec §5, the Task 3 brief's "ненулевой").
  it("refuses a change summary with a null baseline", () => {
    expect(() => workItemChangeSummarySchema.parse(validChangeSummary({ baseline: null }))).toThrow();
  });

  it("refuses a change summary with a file entry that is itself invalid", () => {
    expect(() =>
      workItemChangeSummarySchema.parse(
        validChangeSummary({ files: [validChangedFile({ insertions: -1 })] }),
      ),
    ).toThrow();
  });

  it("does not silently accept a field the change summary never declared", () => {
    expect(() => workItemChangeSummarySchema.parse({ ...validChangeSummary(), workItemId: "x" })).toThrow();
  });

  const validFileDiff = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    path: "src/index.ts",
    baseline: "a".repeat(40),
    binary: false,
    patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
    truncated: false,
    omittedBytes: 0,
    ...overrides,
  });

  it("accepts a well-formed text file diff", () => {
    expect(fileDiffSchema.parse(validFileDiff())).toBeTruthy();
  });

  // D8: a binary file's patch is null, never "" -- an empty string would read as an empty but real
  // diff rather than "there is no text to show".
  it("accepts a binary file diff whose patch is null", () => {
    const parsed = fileDiffSchema.parse(validFileDiff({ binary: true, patch: null }));
    expect(parsed.patch).toBeNull();
  });

  it("accepts a truncated file diff naming how many bytes were omitted", () => {
    expect(fileDiffSchema.parse(validFileDiff({ truncated: true, omittedBytes: 42 }))).toBeTruthy();
  });

  // Nullable, not optional -- the same distinction the workspace tests draw for baseCommit above,
  // applied here to patch: omitting the field entirely would let a lazy caller skip stating whether
  // there was anything to show, which null forces it to.
  it("refuses a file diff with patch omitted rather than recorded as null", () => {
    expect(() => fileDiffSchema.parse(omitField(validFileDiff(), "patch"))).toThrow();
  });

  it("refuses a negative omittedBytes", () => {
    expect(() => fileDiffSchema.parse(validFileDiff({ omittedBytes: -1 }))).toThrow();
  });

  it("refuses a file diff whose baseline is not a 40-character hex sha", () => {
    expect(() => fileDiffSchema.parse(validFileDiff({ baseline: "a".repeat(39) }))).toThrow();
  });

  it("does not silently accept a field the file diff never declared", () => {
    expect(() => fileDiffSchema.parse({ ...validFileDiff(), hunkCount: 1 })).toThrow();
  });

  // The two response envelopes the daemon's handles answer with (spec §5). They exist because the
  // fact "this work item has no workspace" cannot be said in a summary at all: `baseline` above is
  // non-nullable on purpose, so the alternative to an envelope is a second, degraded summary shape
  // -- and the daemon already says this same fact one way, on GET .../workspace, as `null` with a
  // 200. One convention for one condition.
  it("carries a summary, and says 'no workspace' with null rather than with a baseline-less summary", () => {
    expect(
      workItemChangesResponseSchema.parse({ schemaVersion: 1, changes: validChangeSummary() }).changes
        ?.baseline,
    ).toBe("a".repeat(40));
    // Said as an assertion rather than left to the parse: if the envelope ever stopped being
    // nullable, "this work item has no workspace" would become unsayable, and the failure should
    // read as that claim rather than as a ZodError thrown out of the test body.
    expect(() => workItemChangesResponseSchema.parse({ schemaVersion: 1, changes: null })).not.toThrow();
    expect(workItemChangesResponseSchema.parse({ schemaVersion: 1, changes: null }).changes).toBeNull();
    // Not an alternative spelling of the same news: a summary with no base is refused outright, so
    // no caller can be handed one to interpret.
    expect(() =>
      workItemChangesResponseSchema.parse({
        schemaVersion: 1,
        changes: validChangeSummary({ baseline: null }),
      }),
    ).toThrow();
    expect(() =>
      workItemChangesResponseSchema.parse({ schemaVersion: 1, changes: null, workspace: null }),
    ).toThrow();
  });

  it("carries a file diff, and says 'no workspace' the same way the summary response does", () => {
    expect(workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: validFileDiff() }).diff?.path).toBe(
      "src/index.ts",
    );
    expect(() => workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: null })).not.toThrow();
    expect(workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: null }).diff).toBeNull();
    expect(() =>
      workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: validFileDiff({ patch: 1 }) }),
    ).toThrow();
    expect(() =>
      workItemFileDiffResponseSchema.parse({ schemaVersion: 1, diff: null, path: "src/index.ts" }),
    ).toThrow();
  });
});

// R2 (controller ruling): the shape of a change summary is declared once, in
// packages/workspace/src/changes.ts (ChangeStatus/ChangedFile/ChangeSummary/FileDiff, Tasks 1-2).
// changedFileSchema and fileDiffSchema's non-boundary fields are that declaration's boundary form,
// copied by hand because Zod cannot be derived from a plain TypeScript type -- so what stops the
// copy from drifting is not a runtime test (a fixture only proves the cases someone thought to
// write) but a type-level equality check that runs on every `pnpm typecheck`, which `pnpm verify`
// always runs. Mutual assignability (each side extends the other) is enough here: every field below
// is a plain string/number/boolean/literal-union, optionally unioned with `null`, and never itself a
// bare, undistributed type parameter -- exactly the shapes mutual `extends` tells apart correctly,
// including a required field from an optional one and `T | null` from `T | null | undefined`.
type IsEqual<A, B> = A extends B ? (B extends A ? true : false) : false;

describe("changedFileSchema and fileDiffSchema stay equal to @loomrail/workspace's declared shape (R2)", () => {
  // Mutation performed and reverted for this test: changed `insertions: changeLineCountSchema` to
  // `insertions: changeLineCountSchema.optional()` in ../src/workspace.ts (making it `number | null
  // | undefined` instead of `number | null`, which ChangedFile.insertions never allows). Red, by
  // assertion: a TypeScript compile error at this test's `const identical: IsEqual<...> = true;`
  // line -- "Type 'true' is not assignable to type 'false'" -- caught by `pnpm typecheck` even
  // though vitest's own esbuild-transformed run stays green (esbuild strips types; it does not
  // check them). Restored by re-editing the field back to `changeLineCountSchema`, never by `git
  // checkout --`.
  it("keeps changedFileSchema's inferred type identical to ChangedFile, in both directions", () => {
    const identical: IsEqual<z.infer<typeof changedFileSchema>, WorkspaceChangedFile> = true;
    expect(identical).toBe(true);
  });

  // fileDiffSchema carries one boundary-only field FileDiff never declares -- `schemaVersion`, the
  // envelope every response here has -- so the check subtracts exactly that field and compares
  // everything else. `baseline` is one of the shared ones and is checked like any other: spec §4
  // lists it on FileDiff, the reading is where it is known, and it was missing from the workspace
  // type until this round put it there.
  //
  // `Omit`, and deliberately not the `Pick<..., "path" | "baseline" | ...>` this test carried until
  // now. A `Pick` names the fields to compare, so it is a THIRD hand-maintained copy of the same
  // shape, and a field added to the schema and not to FileDiff was simply left out of the
  // comparison -- the headline claim of this describe block ("stay equal") was false for this
  // schema, proved by a mutation that added a field to fileDiffSchema and stayed green. `Omit`
  // names only what is NOT compared, so a new field is compared by default and this test fails
  // closed. `changedFileSchema` above shares no boundary-only field and needs no subtraction at
  // all, so it compares the whole inferred type and never had the hole.
  //
  // Mutation performed and reverted for this test: added `mode: z.string()` to `fileDiffSchema` in
  // ../src/workspace.ts -- a field FileDiff does not declare. Red, by assertion: "Type 'true' is
  // not assignable to type 'false'" at this test's `identical` declaration, under `pnpm
  // typecheck`. With the old `Pick`, the very same mutation was GREEN. Restored by deleting the
  // added line, never by `git checkout --`.
  it("keeps fileDiffSchema's non-boundary fields identical to FileDiff, in both directions", () => {
    type FileDiffSharedFields = Omit<z.infer<typeof fileDiffSchema>, "schemaVersion">;
    const identical: IsEqual<FileDiffSharedFields, WorkspaceFileDiff> = true;
    expect(identical).toBe(true);
  });
});
