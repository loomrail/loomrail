import { describe, expect, it } from "vitest";

import { createMcpProposalChallengeStore } from "../src/mcp-proposals.js";

const candidate = {
  profileId: null,
  name: "Local docs",
  executable: "/opt/loomrail/docs-mcp",
  args: ["--read-only"],
  declaredTools: ["read_docs"],
};

describe("MCP proposal challenge store", () => {
  it("returns exact display data and burns a challenge after one confirmation", () => {
    const store = createMcpProposalChallengeStore({
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      createId: () => "challenge-one",
    });
    const proposal = store.issue({
      projectId: "project-one",
      expectedProjectVersion: 3,
      candidate,
      canonicalDigest: "0".repeat(64),
    });

    expect(proposal).toMatchObject({
      challengeId: "challenge-one",
      candidate,
      expiresAt: "2026-08-31T12:05:00.000Z",
    });
    expect(
      store.consume({
        projectId: "project-one",
        expectedProjectVersion: 3,
        challengeId: "challenge-one",
        canonicalDigest: "0".repeat(64),
      }),
    ).toEqual(proposal);
    expect(() =>
      store.consume({
        projectId: "project-one",
        expectedProjectVersion: 3,
        challengeId: "challenge-one",
        canonicalDigest: "0".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "MCP_PROPOSAL_CONSUMED" }));
  });

  it("burns mismatched and expired challenges", () => {
    let current = new Date("2026-08-31T12:00:00.000Z");
    let nextId = 0;
    const store = createMcpProposalChallengeStore({
      now: () => current,
      createId: () => `challenge-${(nextId += 1).toString()}`,
      ttlMs: 100,
    });
    const mismatched = store.issue({
      projectId: "project-one",
      expectedProjectVersion: 3,
      candidate,
      canonicalDigest: "0".repeat(64),
    });
    expect(() =>
      store.consume({
        projectId: "project-one",
        expectedProjectVersion: 3,
        challengeId: mismatched.challengeId,
        canonicalDigest: "1".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "MCP_PROPOSAL_MISMATCH" }));
    expect(() =>
      store.consume({
        projectId: "project-one",
        expectedProjectVersion: 3,
        challengeId: mismatched.challengeId,
        canonicalDigest: "0".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "MCP_PROPOSAL_CONSUMED" }));

    const expired = store.issue({
      projectId: "project-one",
      expectedProjectVersion: 3,
      candidate,
      canonicalDigest: "0".repeat(64),
    });
    current = new Date("2026-08-31T12:00:00.101Z");
    expect(() =>
      store.consume({
        projectId: "project-one",
        expectedProjectVersion: 3,
        challengeId: expired.challengeId,
        canonicalDigest: "0".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "MCP_PROPOSAL_EXPIRED" }));
  });
});
