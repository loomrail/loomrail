import { describe, expect, it } from "vitest";

import {
  cancelVerificationRunRequestSchema,
  retryVerificationRunRequestSchema,
  startVerificationRunRequestSchema,
  verificationCheckSchema,
  verificationPlanProposalSchema,
  verificationRecipeSchema,
  verificationRunSchema,
  verificationRunSnapshotResponseSchema,
} from "../src/index.js";

const hash = "a".repeat(64);

const recipe = {
  schemaVersion: 1,
  id: "package-test",
  kind: "UNIT",
  label: "Package tests",
  required: true,
  executable: "pnpm",
  argv: ["run", "test"],
  cwd: ".",
  timeoutSeconds: 300,
  outputLimitBytes: 65_536,
  environmentProfile: "VERIFICATION_BASELINE",
  networkPolicy: "INHERIT_HOST",
  provenance: {
    source: "PACKAGE_JSON_SCRIPT",
    manifestPath: "package.json",
    manifestContentHash: hash,
    scriptName: "test",
    scriptBodyPreview: "vitest run",
  },
} as const;

describe("project verification contract", () => {
  it("accepts a bounded no-shell package script proposal", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "ABSENT", digest: null },
      recipes: [recipe],
      warnings: [],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it.each([
    { ...recipe, executable: "./node_modules/.bin/vitest" },
    { ...recipe, executable: "sh", argv: ["-c", "vitest run"] },
    { ...recipe, argv: [] },
    { ...recipe, argv: ["run", "test\u0000--watch"] },
    { ...recipe, cwd: "../outside" },
    { ...recipe, cwd: "/private/project" },
    { ...recipe, timeoutSeconds: 901 },
    { ...recipe, outputLimitBytes: 262_145 },
    { ...recipe, secretEnvironment: { TOKEN: "secret" } },
  ])("rejects an authority-expanding recipe", (candidate) => {
    expect(verificationRecipeSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires a unique id and at least one required recipe", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "ABSENT", digest: null },
      recipes: [{ ...recipe, required: false }],
      warnings: [],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.safeParse(proposal).success).toBe(false);
    expect(
      verificationPlanProposalSchema.safeParse({
        ...proposal,
        recipes: [recipe, recipe],
      }).success,
    ).toBe(false);
  });

  it("allows an inert warning-only proposal when no safe recipe was discovered", () => {
    const proposal = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "BLOCKED", digest: null },
      recipes: [],
      warnings: [
        {
          code: "MANIFEST_SYMLINK",
          path: "package.json",
          message: "The manifest is not a regular file.",
        },
      ],
      proposalHash: "b".repeat(64),
    };

    expect(verificationPlanProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("rejects an ambiguous target state before owner adoption", () => {
    expect(
      verificationPlanProposalSchema.safeParse({
        schemaVersion: 1,
        projectId: "project-1",
        target: { state: "PRESENT", digest: null },
        recipes: [recipe],
        warnings: [],
        proposalHash: "b".repeat(64),
      }).success,
    ).toBe(false);
  });
});

const output = {
  schemaVersion: 1,
  artifactId: "verification-output-1",
  sha256: "d".repeat(64),
  capturedBytes: 128,
  stdoutBytes: 90,
  stderrBytes: 38,
  truncated: false,
  available: true,
} as const;

const runningCheck = {
  schemaVersion: 1,
  id: "verification-check-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  runId: "verification-run-1",
  recipeId: "package-test",
  ordinal: 1,
  required: true,
  status: "RUNNING",
  startedAt: "2026-09-05T10:00:00.000Z",
  completedAt: null,
  durationMs: null,
  exitCode: null,
  signal: null,
  errorCode: null,
  output: null,
  version: 2,
} as const;

const runningRun = {
  schemaVersion: 1,
  id: "verification-run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-run-1",
  workspaceId: "workspace-1",
  planId: "verification-plan-1",
  planRevision: 1,
  planContentHash: "b".repeat(64),
  implementationTree: "c".repeat(40),
  ordinal: 1,
  retryOfRunId: null,
  platform: "darwin",
  status: "RUNNING",
  currentCheckId: runningCheck.id,
  terminalReason: null,
  startedAt: runningCheck.startedAt,
  completedAt: null,
  createdAt: runningCheck.startedAt,
  version: 2,
} as const;

const activePlan = {
  schemaVersion: 1 as const,
  id: runningRun.planId,
  projectId: runningRun.projectId,
  revision: runningRun.planRevision,
  status: "ACTIVE" as const,
  recipes: [recipe],
  sourceProposalHash: "b".repeat(64),
  contentHash: runningRun.planContentHash,
  createdAt: "2026-09-05T09:59:00.000Z",
};

describe("verification run evidence contract", () => {
  it("keeps owner start, retry and cancellation requests strict and version-bound", () => {
    const start = {
      schemaVersion: 1,
      commandId: "start-verification",
      expectedWorkItemVersion: 3,
      expectedPlanRevision: 2,
      expectedPlanContentHash: hash,
    } as const;
    expect(startVerificationRunRequestSchema.parse(start)).toEqual(start);
    expect(
      retryVerificationRunRequestSchema.parse({
        ...start,
        retryOfRunId: "verification-run-1",
        expectedRetryOfRunVersion: 4,
      }),
    ).toMatchObject({ retryOfRunId: "verification-run-1", expectedRetryOfRunVersion: 4 });
    expect(
      cancelVerificationRunRequestSchema.parse({
        schemaVersion: 1,
        commandId: "cancel-verification",
        expectedVersion: 2,
      }),
    ).toMatchObject({ expectedVersion: 2 });
    expect(startVerificationRunRequestSchema.safeParse({ ...start, shell: true }).success).toBe(false);
  });

  it("accepts a structurally measured passing check and current snapshot", () => {
    const check = {
      ...runningCheck,
      status: "PASSED",
      completedAt: "2026-09-05T10:00:01.250Z",
      durationMs: 1_250,
      exitCode: 0,
      output,
      version: 3,
    } as const;
    const run = {
      ...runningRun,
      status: "PASSED",
      currentCheckId: null,
      terminalReason: "ALL_REQUIRED_PASSED",
      completedAt: check.completedAt,
      version: 3,
    } as const;

    expect(verificationCheckSchema.parse(check)).toEqual(check);
    expect(verificationRunSchema.parse(run)).toEqual(run);
    expect(
      verificationRunSnapshotResponseSchema.parse({
        schemaVersion: 1,
        run,
        plan: activePlan,
        checks: [check],
        freshness: "CURRENT",
        staleReasons: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      run,
      plan: activePlan,
      checks: [check],
      freshness: "CURRENT",
      staleReasons: [],
    });
  });

  it.each([
    {
      ...runningCheck,
      status: "PASSED",
      completedAt: runningCheck.startedAt,
      durationMs: 0,
      exitCode: 1,
      output,
    },
    {
      ...runningCheck,
      status: "FAILED",
      completedAt: runningCheck.startedAt,
      durationMs: 0,
      exitCode: 0,
      output,
    },
    {
      ...runningCheck,
      status: "ERROR",
      completedAt: runningCheck.startedAt,
      durationMs: 0,
      errorCode: null,
    },
    { ...runningCheck, status: "QUEUED", startedAt: runningCheck.startedAt },
    { ...runningCheck, ownerPath: "/private/loomrail-fixture/project" },
  ])("rejects contradictory or privacy-expanding check evidence", (candidate) => {
    expect(verificationCheckSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects contradictory terminal Run state and cross-run snapshot checks", () => {
    expect(
      verificationRunSchema.safeParse({
        ...runningRun,
        status: "PASSED",
        terminalReason: "ALL_REQUIRED_PASSED",
        completedAt: runningRun.startedAt,
      }).success,
    ).toBe(false);
    expect(
      verificationRunSnapshotResponseSchema.safeParse({
        schemaVersion: 1,
        run: runningRun,
        plan: activePlan,
        checks: [{ ...runningCheck, runId: "verification-run-foreign" }],
        freshness: "STALE",
        staleReasons: ["TREE_CHANGED"],
      }).success,
    ).toBe(false);
  });

  it("accepts cancellation while a Run is still queued", () => {
    const queuedRun = {
      ...runningRun,
      status: "INTERRUPTED",
      currentCheckId: null,
      terminalReason: "OWNER_CANCELLED",
      startedAt: null,
      completedAt: "2026-09-05T10:00:01.000Z",
    } as const;

    expect(verificationRunSchema.parse(queuedRun)).toEqual(queuedRun);
  });
});
