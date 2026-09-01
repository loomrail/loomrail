import { createHash } from "node:crypto";

import type { ContextPack } from "@loomrail/contracts";
import type { ProviderInvocation, ProviderSessionListener } from "@loomrail/provider-core";
import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/index.js";

const contextPack = (): ContextPack => {
  const text = "Workflow Position";
  return { schemaVersion: 1, text, contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}` };
};

const invocation = (
  stage: "DISCOVERY" | "PLAN" | "IMPLEMENT" | "REVIEW" | "QA" | "ACCEPTANCE",
  options: { stageAttemptId?: string; workItemId?: string; attempt?: number } = {},
): ProviderInvocation => {
  const stageAttemptId = options.stageAttemptId ?? "attempt-1";
  const workItemId = options.workItemId ?? "work-item-1";
  return {
    dispatch: {
      schemaVersion: 1,
      id: `dispatch-${stageAttemptId}`,
      projectId: "project-1",
      workItemId,
      pipelineRunId: "run-1",
      stageAttemptId,
      mode: "START",
      status: "PENDING",
      createdAt: "2026-08-24T10:00:00.000Z",
      completedAt: null,
    },
    session: {
      id: `session-${stageAttemptId}`,
      ordinal: 1,
      stageAttemptId,
      stage,
      attempt: options.attempt ?? 1,
    },
    contextPack: contextPack(),
    humanRequests: "ALLOWED",
    mcpConnections: [],
  };
};

const listener = (): ProviderSessionListener => ({
  onContextWindow: () => undefined,
  onCheckpoint: () => undefined,
  onUsage: () => undefined,
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
    const provider = createMockProvider();
    await expect(provider.start(invocation("IMPLEMENT", { attempt: 1 }), listener())).resolves.toMatchObject({
      type: "BUDGET_LIMIT_REACHED",
      usageIncrements: [50, 30, 15, 5],
      quality: "LOOMRAIL_ESTIMATE",
    });
    await expect(
      provider.start(invocation("IMPLEMENT", { stageAttemptId: "attempt-2", attempt: 2 }), listener()),
    ).resolves.toMatchObject({ type: "COMPLETED" });
  });

  it("reads the attempt from the session ref, not from adapter-local bookkeeping", async () => {
    // The retry attempt must complete even on a brand-new adapter instance (a daemon restart
    // between the override and the retry) and a first attempt for a different work item must
    // still exhaust its budget even after another work item has already run IMPLEMENT on the
    // same adapter instance. A `Set` keyed by StageAttempt id gets both of these wrong: it
    // forgets on restart and it never resets between work items.
    const sharedProvider = createMockProvider();
    await sharedProvider.start(invocation("IMPLEMENT", { attempt: 1 }), listener());
    await expect(
      sharedProvider.start(
        invocation("IMPLEMENT", { stageAttemptId: "other-work-item-attempt-1", workItemId: "work-item-2" }),
        listener(),
      ),
    ).resolves.toMatchObject({ type: "BUDGET_LIMIT_REACHED" });

    const freshProviderAfterRestart = createMockProvider();
    await expect(
      freshProviderAfterRestart.start(
        invocation("IMPLEMENT", { stageAttemptId: "attempt-2", attempt: 2 }),
        listener(),
      ),
    ).resolves.toMatchObject({ type: "COMPLETED" });
  });

  it("records typed review and QA evidence before requesting owner acceptance", async () => {
    await expect(createMockProvider().start(invocation("REVIEW"), listener())).resolves.toMatchObject({
      type: "COMPLETED",
      artifacts: [{ kind: "REVIEW_REPORT" }],
      reviewReport: { verdict: "PASSED", findings: [] },
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
