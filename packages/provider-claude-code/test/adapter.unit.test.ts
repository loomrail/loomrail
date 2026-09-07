import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { CheckpointDraft, ProviderUsage } from "@loomrail/contracts";
import type {
  ProviderInvocation,
  ProviderJsonRequest,
  ProviderSessionListener,
} from "@loomrail/provider-core";
import { describe, expect, it, vi } from "vitest";

import { createAnthropicMessagesProvider } from "../src/index.js";

const invocation = (): ProviderInvocation => {
  const text = "A bounded discovery context pack.";
  return {
    dispatch: {
      schemaVersion: 1,
      id: "dispatch-anthropic-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "pipeline-1",
      stageAttemptId: "attempt-1",
      mode: "START",
      status: "PENDING",
      createdAt: "2026-09-06T10:00:00.000Z",
      completedAt: null,
    },
    session: {
      id: "session-anthropic-1",
      ordinal: 1,
      stageAttemptId: "attempt-1",
      stage: "DISCOVERY",
      attempt: 1,
    },
    contextPack: {
      schemaVersion: 1,
      text,
      contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
    modelTier: "FAST",
    tokenBudget: {
      maxEstimatedTokens: 100_000,
      recordedEstimatedTokens: 0,
      remainingEstimatedTokens: 100_000,
    },
    acceptanceInput: null,
    humanRequests: "ALLOWED",
    mcpConnections: [],
    authoritySignal: new AbortController().signal,
  };
};

const listener = (): ProviderSessionListener & {
  checkpoints: CheckpointDraft[];
  usage: ProviderUsage[];
} => {
  const checkpoints: CheckpointDraft[] = [];
  const usage: ProviderUsage[] = [];
  return {
    checkpoints,
    usage,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    onContextWindow: () => undefined,
    onUsage: (report) => usage.push(report),
  };
};

const completedResult = {
  result: {
    type: "COMPLETED",
    summary: "The real Anthropic discovery completed.",
    completed: ["Inspected the bounded context."],
    remaining: [],
    deadEnds: [],
    openQuestions: [],
  },
};

describe("Anthropic Messages provider", () => {
  it("forces a structured result tool and passes max_tokens before dispatch", async () => {
    const requests: ProviderJsonRequest[] = [];
    const sink = listener();
    const provider = createAnthropicMessagesProvider({
      apiKey: "test-anthropic-key",
      contextWindowTokens: 20_000,
      transport: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 200,
          body: {
            type: "message",
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "submit_stage_result",
                input: completedResult,
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 30,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
            },
          },
        });
      },
    });

    expect(provider.capabilities()).toMatchObject({
      provider: "CLAUDE_CODE",
      start: true,
      tokenBudgetEnforcement: "HARD",
      stages: ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"],
    });
    await expect(provider.start(invocation(), sink)).resolves.toMatchObject({
      type: "COMPLETED",
      summary: "The real Anthropic discovery completed.",
    });
    expect(sink.checkpoints).toHaveLength(1);
    expect(sink.usage).toEqual([
      {
        inputTokens: 130,
        outputTokens: 30,
        cachedInputTokens: 20,
        quality: "ACTUAL",
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toEqual({
      "x-api-key": "test-anthropic-key",
      "anthropic-version": "2023-06-01",
    });
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body["max_tokens"]).toEqual(expect.any(Number));
    expect(body["max_tokens"]).toBeLessThan(invocation().tokenBudget.remainingEstimatedTokens);
    expect(
      Number(body["max_tokens"]) + Buffer.byteLength(JSON.stringify(body), "utf8") + 512,
    ).toBeLessThanOrEqual(20_000);
    expect(body["tool_choice"]).toEqual({
      type: "tool",
      name: "submit_stage_result",
      disable_parallel_tool_use: true,
    });
    expect(JSON.stringify(body["tools"])).toContain('"name":"submit_stage_result"');
    expect(JSON.stringify(body["tools"])).toContain('"input_schema":');
  });

  it("fails closed without an API key", async () => {
    const transport = vi.fn();
    const provider = createAnthropicMessagesProvider({ apiKey: "", transport });
    expect(provider.capabilities().start).toBe(false);
    await expect(provider.start(invocation(), listener())).rejects.toThrow(
      "ANTHROPIC_API_KEY is not configured",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects malformed remote input instead of guessing a stage result", async () => {
    const provider = createAnthropicMessagesProvider({
      apiKey: "test-anthropic-key",
      transport: () =>
        Promise.resolve({
          status: 200,
          body: {
            type: "message",
            stop_reason: "tool_use",
            content: [{ type: "text", text: "looks good" }],
            usage: { input_tokens: 100, output_tokens: 30 },
          },
        }),
    });
    await expect(provider.start(invocation(), listener())).rejects.toThrow(
      "did not submit exactly one Loomrail stage result",
    );
  });
});
