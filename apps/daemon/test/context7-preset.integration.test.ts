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
      const consent = {
        schemaVersion: 1,
        id: "context7-consent-test",
        projectId: revision.projectId,
        profileRevisionId: revision.id,
        canonicalDigest,
        ownerId: "local-owner",
        consentedAt: "2026-08-31T12:00:00.000Z",
      } as const;
      let observation = await gateway.probe(revision, consent);
      // The five-second C1 deadline is intentionally strict. A cold, contended CI worker may return
      // the honest retryable TIMED_OUT state while loading the bundled server; the next independent
      // probe must still discover the real process and exact capabilities without widening that
      // per-attempt production bound.
      if (observation.state === "TIMED_OUT") observation = await gateway.probe(revision, consent);

      expect(observation.state).toBe("READY");
      expect(observation.tools).toEqual(["query-docs", "resolve-library-id"]);
      expect(observation.resources).toEqual([]);
      expect(observation.prompts).toEqual([]);
    } finally {
      await gateway.shutdown();
    }
  }, 20_000);
});
