import { createHash } from "node:crypto";

import { canonicalMcpProfileSource } from "@loomrail/domain";
import { createMcpGateway } from "@loomrail/mcp-gateway";
import { describe, expect, it } from "vitest";

import { resolveBundledContext7Candidate } from "../src/context7-preset.js";

describe("bundled Context7 MCP server", () => {
  it("starts through the real gateway and exposes only the two pinned tools", async () => {
    const gateway = createMcpGateway();
    try {
      const candidate = await gateway.resolveCandidate(resolveBundledContext7Candidate());
      const canonicalDigest = createHash("sha256").update(canonicalMcpProfileSource(candidate)).digest("hex");
      const revision = {
        schemaVersion: 1,
        id: "context7-revision-test",
        projectId: "context7-project-test",
        revision: 1,
        ...candidate,
        profileId: "context7-profile-test",
        canonicalDigest,
        createdAt: "2026-08-31T12:00:00.000Z",
      } as const;
      const observation = await gateway.probe(revision, {
        schemaVersion: 1,
        id: "context7-consent-test",
        projectId: revision.projectId,
        profileRevisionId: revision.id,
        canonicalDigest,
        ownerId: "local-owner",
        consentedAt: "2026-08-31T12:00:00.000Z",
      });

      expect(observation.state).toBe("READY");
      expect(observation.tools).toEqual(["query-docs", "resolve-library-id"]);
      expect(observation.resources).toEqual([]);
      expect(observation.prompts).toEqual([]);
    } finally {
      await gateway.shutdown();
    }
  }, 15_000);
});
