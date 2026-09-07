import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { CheckpointDraft, ProviderUsage } from "@loomrail/contracts";
import type {
  ProviderInvocation,
  ProviderJsonRequest,
  ProviderSessionListener,
} from "@loomrail/provider-core";
import { ProviderProtocolError } from "@loomrail/provider-core";
import { describe, expect, it, vi } from "vitest";

import { createOpenAIResponsesProvider } from "../src/index.js";

const invocation = (): ProviderInvocation => {
  const text = "A bounded discovery context pack.";
  return {
    dispatch: {
      schemaVersion: 1,
      id: "dispatch-openai-1",
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
      id: "session-openai-1",
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
    summary: "The real OpenAI discovery completed.",
    completed: ["Inspected the bounded context."],
    remaining: [],
    deadEnds: [],
    openQuestions: [],
  },
};

describe("OpenAI Responses provider", () => {
  it("is selectable only with a credential and enforces the token budget before dispatch", async () => {
    const requests: ProviderJsonRequest[] = [];
    const sink = listener();
    const provider = createOpenAIResponsesProvider({
      apiKey: "test-openai-key",
      contextWindowTokens: 20_000,
      transport: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 200,
          body: {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(completedResult) }],
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 40,
              input_tokens_details: { cached_tokens: 20 },
              output_tokens_details: { reasoning_tokens: 10 },
            },
          },
        });
      },
    });

    expect(provider.capabilities()).toMatchObject({
      provider: "CODEX",
      start: true,
      tokenBudgetEnforcement: "HARD",
      stages: ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"],
    });
    await expect(provider.start(invocation(), sink)).resolves.toMatchObject({
      type: "COMPLETED",
      summary: "The real OpenAI discovery completed.",
    });
    expect(sink.checkpoints).toHaveLength(1);
    expect(sink.usage).toEqual([
      {
        inputTokens: 120,
        outputTokens: 40,
        cachedInputTokens: 20,
        reasoningOutputTokens: 10,
        quality: "ACTUAL",
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers).toEqual({ authorization: "Bearer test-openai-key" });
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body["store"]).toBe(false);
    expect(body["max_output_tokens"]).toEqual(expect.any(Number));
    expect(body["max_output_tokens"]).toBeLessThan(invocation().tokenBudget.remainingEstimatedTokens);
    expect(
      Number(body["max_output_tokens"]) + Buffer.byteLength(JSON.stringify(body), "utf8") + 512,
    ).toBeLessThanOrEqual(20_000);
    expect(body["text"]).toMatchObject({
      format: { type: "json_schema", name: "loomrail_stage_result", strict: true },
    });
  });

  it("fails closed without an API key and never reaches the network transport", async () => {
    const transport = vi.fn();
    const provider = createOpenAIResponsesProvider({ apiKey: "", transport });
    expect(provider.capabilities().start).toBe(false);
    await expect(provider.start(invocation(), listener())).rejects.toMatchObject({
      name: "ProviderProtocolError",
      message: "OPENAI_API_KEY is not configured",
    } satisfies Partial<ProviderProtocolError>);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a provider usage report that exceeds the dispatched remainder", async () => {
    const provider = createOpenAIResponsesProvider({
      apiKey: "test-openai-key",
      transport: () =>
        Promise.resolve({
          status: 200,
          body: {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(completedResult) }],
              },
            ],
            usage: { input_tokens: 90_000, output_tokens: 20_000 },
          },
        }),
    });
    await expect(provider.start(invocation(), listener())).rejects.toThrow(
      "The provider exceeded the dispatched token cap",
    );
  });
});
