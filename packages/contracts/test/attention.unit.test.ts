import { describe, expect, it } from "vitest";

import { attentionInboxResponseSchema, maxAttentionItems } from "../src/index.js";

describe("attention contracts", () => {
  const request = {
    schemaVersion: 1,
    id: "request-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    stageAttemptId: "attempt-1",
    kind: "SINGLE_CHOICE",
    blocking: true,
    title: "Choose the implementation boundary",
    context: "The current stage needs one owner decision before it can continue.",
    recommendation: "Keep the module local to the domain package.",
    options: [
      {
        id: "domain",
        label: "Use the domain module",
        consequence: "Keep classification deterministic and infrastructure-free.",
        recommended: true,
      },
    ],
    allowOther: true,
    status: "OPEN",
    version: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    resolvedAt: null,
  } as const;

  const item = {
    schemaVersion: 1,
    id: request.id,
    request,
    project: { id: request.projectId, name: "Loomrail" },
    workItem: {
      id: request.workItemId,
      title: "Build Attention Inbox",
      priority: "HIGH",
      state: "BLOCKED",
    },
    stage: { id: request.stageAttemptId, name: "PLAN", status: "WAITING_HUMAN" },
    section: "BLOCKING_NOW",
    category: "QUESTION",
    reason: null,
    action: "ANSWER_REQUEST",
    acceptancePackageId: null,
    affectedStages: ["PLAN"],
  } as const;

  it("accepts one closed, owner-facing item", () => {
    expect(attentionInboxResponseSchema.parse({ schemaVersion: 1, items: [item], hasMore: false })).toEqual({
      schemaVersion: 1,
      items: [item],
      hasMore: false,
    });
  });

  it("rejects an unbounded response", () => {
    expect(() =>
      attentionInboxResponseSchema.parse({
        schemaVersion: 1,
        items: Array.from({ length: maxAttentionItems + 1 }, (_, index) => ({
          ...item,
          id: `request-${index.toString()}`,
          request: { ...request, id: `request-${index.toString()}` },
        })),
        hasMore: true,
      }),
    ).toThrow();
  });

  it("rejects an action outside the closed vocabulary", () => {
    expect(() =>
      attentionInboxResponseSchema.parse({
        schemaVersion: 1,
        items: [{ ...item, action: "AUTO_APPROVE" }],
        hasMore: false,
      }),
    ).toThrow();
  });
});
