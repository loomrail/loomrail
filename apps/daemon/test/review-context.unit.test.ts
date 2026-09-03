import type { ContextSources } from "@loomrail/context-assembly";
import { reviewDiffLimits, type WorkItemWorkspace } from "@loomrail/contracts";
import { describe, expect, it, vi } from "vitest";

import { prepareReviewContext, type ReviewDiffReader } from "../src/review-context.js";

const expectedTree = "a".repeat(40);
const baseline = "b".repeat(40);

const sources = (): ContextSources => ({
  workItemBrief: {
    id: "work-item-1",
    version: 1,
    title: "Review the implementation",
    description: "Synthetic review context",
    acceptanceCriteria: [],
    priority: "MEDIUM",
    risk: "LOW",
  },
  workflowPosition: {
    templateId: "review-template",
    templateVersion: 1,
    stage: "REVIEW",
    attempt: 1,
    sessionOrdinal: 1,
  },
  projectConstitution: null,
  qaCorrection: null,
  decisions: [],
  latestCheckpoint: null,
  reviewInput: {
    implementationAttempt: {
      id: "implementation-attempt-1",
      version: 2,
      attempt: 1,
      resultTree: expectedTree,
    },
    authorAgentRun: { id: "author-agent-run-1", version: 2, provider: "CODEX" },
    diffSummary: null,
    openFindings: [],
  },
  evidence: [],
  activity: [],
});

const workspace = (): WorkItemWorkspace => ({
  schemaVersion: 1,
  id: "workspace-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  branch: "loomrail/work-item-1",
  worktreePath: "/tmp/loomrail-worktree",
  baseCommit: baseline,
  snapshotCommit: null,
  status: "READY",
  leaseHolder: "review-attempt-1",
  createdAt: "2026-09-03T10:00:00.000Z",
  version: 3,
});

describe("stable REVIEW context preparation", () => {
  it("attaches only the bounded summary measured for the immutable implementation tree", async () => {
    const readDiff = vi.fn<ReviewDiffReader>().mockResolvedValue({
      baseline,
      tree: expectedTree,
      files: [
        {
          path: "src/auth.ts",
          previousPath: null,
          status: "MODIFIED",
          insertions: 8,
          deletions: 2,
          binary: false,
          content: {
            type: "TEXT",
            patch: "@@ -1 +1 @@\n-old\n+new\n",
            truncated: false,
            omittedBytes: 0,
          },
        },
      ],
      truncated: false,
    });

    const result = await prepareReviewContext({ sources: sources(), workspace: workspace(), readDiff });

    expect(readDiff).toHaveBeenCalledWith({
      worktreePath: "/tmp/loomrail-worktree",
      baseline,
      maxFiles: reviewDiffLimits.maxFiles,
      maxContentFiles: reviewDiffLimits.maxContentFiles,
      maxPatchBytesPerFile: reviewDiffLimits.maxPatchBytesPerFile,
      maxPatchBytesTotal: reviewDiffLimits.maxPatchBytesTotal,
    });
    expect(result).toMatchObject({
      type: "READY",
      sources: {
        reviewInput: {
          implementationAttempt: { resultTree: expectedTree },
          diffSummary: {
            baseline,
            files: [
              {
                path: "src/auth.ts",
                status: "MODIFIED",
                insertions: 8,
                deletions: 2,
                content: { type: "TEXT", patch: "@@ -1 +1 @@\n-old\n+new\n" },
              },
            ],
            truncated: false,
          },
        },
      },
    });
  });

  it("refuses a summary measured from a tree different from the durable implementation", async () => {
    const result = await prepareReviewContext({
      sources: sources(),
      workspace: workspace(),
      readDiff: () => Promise.resolve({ baseline, tree: "c".repeat(40), files: [], truncated: false }),
    });

    expect(result).toMatchObject({
      type: "REFUSED",
      reason: "TREE_CHANGED",
      request: { blocking: true, options: [{ id: "retry-stable-review", recommended: true }] },
    });
  });

  it("refuses a diff returned for a baseline different from the durable workspace baseline", async () => {
    const result = await prepareReviewContext({
      sources: sources(),
      workspace: workspace(),
      readDiff: () =>
        Promise.resolve({
          baseline: "d".repeat(40),
          tree: expectedTree,
          files: [],
          truncated: false,
        }),
    });

    expect(result).toMatchObject({ type: "REFUSED", reason: "BASELINE_MISMATCH" });
  });

  it("refuses an unreadable diff instead of inventing an empty summary", async () => {
    const failure = new Error("synthetic git failure");
    const result = await prepareReviewContext({
      sources: sources(),
      workspace: workspace(),
      readDiff: () => Promise.reject(failure),
    });

    expect(result).toMatchObject({ type: "REFUSED", reason: "DIFF_UNREADABLE", cause: failure });
  });

  it("does no Git work outside an actual REVIEW input", async () => {
    const withoutReview = { ...sources(), reviewInput: null };
    const readDiff = vi.fn<ReviewDiffReader>();

    await expect(
      prepareReviewContext({ sources: withoutReview, workspace: null, readDiff }),
    ).resolves.toEqual({ type: "READY", sources: withoutReview });
    expect(readDiff).not.toHaveBeenCalled();
  });
});
