import { createHash } from "node:crypto";

import type { ContextPack } from "@loomrail/contracts";
import type { ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/index.js";

const contextPack = (): ContextPack => {
  const text = "fixture context pack";
  return { schemaVersion: 1, text, contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}` };
};

const invocation = (
  stage: "DISCOVERY" | "PLAN" | "IMPLEMENT" | "REVIEW" | "QA" | "ACCEPTANCE",
  stageAttemptId = "attempt-1",
): ProviderInvocation => ({
  dispatch: {
    schemaVersion: 1,
    id: `dispatch-${stageAttemptId}`,
    projectId: "project-1",
    workItemId: "work-item-1",
    pipelineRunId: "run-1",
    stageAttemptId,
    mode: "START",
    status: "PENDING",
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: null,
  },
  session: { id: `session-${stageAttemptId}`, ordinal: 1, stageAttemptId, stage },
  contextPack: contextPack(),
});

const listener = (): ProviderSessionListener => ({
  onContextWindow: () => undefined,
  onCheckpoint: () => undefined,
});

describe("mock provider scenario A", () => {
  it("opens a recommended single-choice request during discovery", async () => {
    const result = await createMockProvider().start(invocation("DISCOVERY"), listener());
    expect(result).toMatchObject({
      type: "NEEDS_HUMAN",
      request: { kind: "SINGLE_CHOICE", allowOther: true, blocking: true },
    });
  });

  it("completes planning without another human request", async () => {
    await expect(createMockProvider().start(invocation("PLAN"), listener())).resolves.toMatchObject({
      type: "COMPLETED",
    });
  });

  it("reports the bounded usage ladder only for the initial implementation attempt", async () => {
    // The same adapter instance must run both StageAttempts: which one is "initial" is tracked
    // per adapter instance now that the raw attempt number is no longer on the invocation.
    const provider = createMockProvider();
    await expect(provider.start(invocation("IMPLEMENT"), listener())).resolves.toMatchObject({
      type: "BUDGET_LIMIT_REACHED",
      usageIncrements: [50, 30, 15, 5],
      quality: "LOOMRAIL_ESTIMATE",
    });
    await expect(provider.start(invocation("IMPLEMENT", "attempt-2"), listener())).resolves.toMatchObject({
      type: "COMPLETED",
    });
  });

  it("records typed review and QA evidence before requesting owner acceptance", async () => {
    await expect(createMockProvider().start(invocation("REVIEW"), listener())).resolves.toMatchObject({
      type: "COMPLETED",
      artifacts: [{ kind: "REVIEW_REPORT" }],
    });
    await expect(createMockProvider().start(invocation("QA"), listener())).resolves.toMatchObject({
      type: "COMPLETED",
      artifacts: [{ kind: "QA_REPORT" }],
    });
    await expect(createMockProvider().start(invocation("ACCEPTANCE"), listener())).resolves.toMatchObject({
      type: "READY_FOR_ACCEPTANCE",
    });
  });
});
