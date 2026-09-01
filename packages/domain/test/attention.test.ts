import { describe, expect, it } from "vitest";
import {
  maxAttentionItems,
  type HumanRequest,
  type Project,
  type StageAttempt,
  type WorkItem,
} from "@loomrail/contracts";

import {
  AttentionProjectionError,
  buildAttentionInbox,
  type AttentionProjectionSource,
} from "../src/attention.js";

const source = (
  overrides: {
    id?: string;
    blocking?: boolean;
    priority?: WorkItem["priority"];
    createdAt?: string;
    stage?: StageAttempt["stage"];
    stageStatus?: StageAttempt["status"];
    failureCode?: string | null;
    acceptancePackageId?: string | null;
  } = {},
): AttentionProjectionSource => {
  const id = overrides.id ?? "one";
  const stage = overrides.stage ?? "PLAN";
  const project: Project = {
    schemaVersion: 1,
    id: `project-${id}`,
    workspaceId: "workspace",
    fixtureId: null,
    name: `Project ${id}`,
    repositoryPath: `/tmp/${id}`,
    providerPreference: "AUTO",
    status: "ACTIVE",
    version: 1,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
  };
  const workItem: WorkItem = {
    schemaVersion: 1,
    id: `work-${id}`,
    projectId: project.id,
    parentId: null,
    type: "TASK",
    title: `Work ${id}`,
    description: "A deterministic Attention fixture.",
    state: "BLOCKED",
    currentStage: stage,
    priority: overrides.priority ?? "MEDIUM",
    risk: "MEDIUM",
    acceptanceCriteria: [],
    version: 1,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
  };
  const stageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: `attempt-${id}`,
    pipelineRunId: `run-${id}`,
    projectId: project.id,
    workItemId: workItem.id,
    stage,
    attempt: 1,
    status: overrides.stageStatus ?? "WAITING_HUMAN",
    version: 1,
    startedAt: "2026-09-01T09:01:00.000Z",
    finishedAt: null,
    failureCode: overrides.failureCode ?? null,
    unproductiveSessions: 0,
    packShareBackoffs: 0,
    resultTree: null,
  };
  const request: HumanRequest = {
    schemaVersion: 1,
    id: `request-${id}`,
    projectId: project.id,
    workItemId: workItem.id,
    stageAttemptId: stageAttempt.id,
    kind: "SINGLE_CHOICE",
    blocking: overrides.blocking ?? true,
    title: `Question ${id}`,
    context: "The stage needs a decision.",
    recommendation: null,
    options: [
      {
        id: `option-${id}`,
        label: "Continue",
        consequence: "Resume the current stage.",
        recommended: true,
      },
    ],
    allowOther: true,
    status: "OPEN",
    version: 1,
    createdAt: overrides.createdAt ?? "2026-09-01T10:00:00.000Z",
    resolvedAt: null,
  };
  return {
    project,
    workItem,
    stageAttempt,
    request,
    acceptancePackageId: overrides.acceptancePackageId ?? null,
  };
};

describe("Attention Inbox projection", () => {
  it("keeps blocking precedence while preserving the action category", () => {
    const approval = source({
      id: "approval",
      stage: "ACCEPTANCE",
      acceptancePackageId: "acceptance-1",
    });
    const manual = source({
      id: "manual",
      stageStatus: "HARD_PAUSED",
      failureCode: "NO_PROGRESS",
    });

    const inbox = buildAttentionInbox([approval, manual]);

    expect(inbox.items.map(({ section, category, action }) => ({ section, category, action }))).toEqual([
      { section: "BLOCKING_NOW", category: "APPROVAL", action: "REVIEW_ACCEPTANCE" },
      { section: "BLOCKING_NOW", category: "MANUAL_ACTION", action: "ANSWER_REQUEST" },
    ]);
  });

  it("groups non-blocking items without guessing from their prose", () => {
    const question = source({ id: "question", blocking: false });
    const manual = source({
      id: "manual",
      blocking: false,
      stageStatus: "HARD_PAUSED",
      failureCode: "SESSION_LIMIT_REACHED",
    });

    const inbox = buildAttentionInbox([manual, question]);

    expect(inbox.items.map(({ section }) => section)).toEqual(["QUESTIONS", "MANUAL_ACTIONS"]);
  });

  it("sorts by section, priority, age and stable id", () => {
    const inbox = buildAttentionInbox([
      source({ id: "low", priority: "LOW", createdAt: "2026-09-01T08:00:00.000Z" }),
      source({ id: "urgent-new", priority: "URGENT", createdAt: "2026-09-01T10:00:00.000Z" }),
      source({ id: "urgent-old", priority: "URGENT", createdAt: "2026-09-01T09:00:00.000Z" }),
    ]);

    expect(inbox.items.map(({ id }) => id)).toEqual([
      "request-urgent-old",
      "request-urgent-new",
      "request-low",
    ]);
  });

  it("fails closed when a relation crosses WorkItems", () => {
    const inconsistent = source();
    inconsistent.request = { ...inconsistent.request, workItemId: "other-work" };

    expect(() => buildAttentionInbox([inconsistent])).toThrow(AttentionProjectionError);
  });

  it("bounds the public response and reports omitted items", () => {
    const sources = Array.from({ length: maxAttentionItems + 1 }, (_, index) =>
      source({ id: String(index).padStart(3, "0") }),
    );

    const inbox = buildAttentionInbox(sources);

    expect(inbox.items).toHaveLength(maxAttentionItems);
    expect(inbox.hasMore).toBe(true);
  });

  it("refuses a caller that bypasses the bounded read seam", () => {
    const sources = Array.from({ length: maxAttentionItems + 2 }, (_, index) =>
      source({ id: String(index).padStart(3, "0") }),
    );

    expect(() => buildAttentionInbox(sources)).toThrow(/bounded sources/u);
  });
});
