import { describe, expect, it } from "vitest";
import { assembleCoordinatorPack } from "../src/index.js";
const packet = {
  version: 1 as const,
  ownerOutcome: "Show the current task progress",
  discovery: "UNKNOWN" as const,
  unresolvedQuestions: 0,
  attempt: 1,
  sessionOrdinal: 1,
};
describe("separate coordinator assembly", () => {
  it("is bounded, deterministic and traces the immutable policy instead of source-bearing artifacts", () => {
    const input = { packet, agentRunId: "manager-1", budgetTokens: 2000, bytesPerToken: 4 };
    const result = assembleCoordinatorPack(input);
    expect(result).toEqual(assembleCoordinatorPack(input));
    expect(result.type).toBe("ASSEMBLED");
    if (result.type !== "ASSEMBLED") return;
    expect(JSON.parse(result.pack.text)).toEqual(packet);
    expect(result.recipe.sections[0]?.sources).toEqual([{ kind: "AGENT_RUN", id: "manager-1", version: 1 }]);
    expect(result.recipe.estimatedTokens).toBeLessThan(100);
    expect(assembleCoordinatorPack({ ...input, budgetTokens: 1 }).type).toBe("FLOOR_EXCEEDED");
    const traced = assembleCoordinatorPack({
      ...input,
      discoveryCheckpoint: { id: "discovery-checkpoint-1", version: 2 },
    });
    if (traced.type !== "ASSEMBLED") throw new Error("Expected traced packet");
    expect(traced.recipe.sections[0]?.sources).toContainEqual({
      kind: "CHECKPOINT",
      id: "discovery-checkpoint-1",
      version: 2,
    });
    expect(traced.pack).toEqual(result.pack);
  });
  it("rejects free-text reports even when smuggled by an internal caller", () => {
    const poisoned = { ...packet, report: "const CANARY = 'source';" };
    expect(() =>
      assembleCoordinatorPack({
        packet: poisoned,
        agentRunId: "manager",
        budgetTokens: 2000,
        bytesPerToken: 4,
      }),
    ).toThrow();
  });
});
