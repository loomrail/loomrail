import { fileURLToPath } from "node:url";

import type { McpConsent, McpProfileRevision } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { mcpProbeEnvironment, probeMcpRevision } from "../src/probe.js";

const fixturePath = fileURLToPath(new URL("./fixtures/modern-server.mjs", import.meta.url));
const floodFixturePath = fileURLToPath(new URL("./fixtures/flood-server.mjs", import.meta.url));
const invalidFixturePath = fileURLToPath(new URL("./fixtures/invalid-server.mjs", import.meta.url));
const legacyFixturePath = fileURLToPath(new URL("./fixtures/legacy-server.mjs", import.meta.url));
const supervisorEntrypoint = fileURLToPath(new URL("../dist/supervisor.js", import.meta.url));
const canonicalDigest = "0".repeat(64);

const revision = (mode: string): McpProfileRevision => ({
  schemaVersion: 1,
  id: "revision-one",
  profileId: "profile-one",
  projectId: "project-one",
  revision: 1,
  name: "Test MCP",
  executable: process.execPath,
  args: [fixturePath, mode],
  declaredTools: ["tool_00", "tool_01"],
  canonicalDigest,
  createdAt: "2026-08-31T12:00:00.000Z",
});

const consent: McpConsent = {
  schemaVersion: 1,
  id: "consent-one",
  projectId: "project-one",
  profileRevisionId: "revision-one",
  canonicalDigest,
  ownerId: "local-owner",
  consentedAt: "2026-08-31T12:00:00.000Z",
};

const probe = (candidate: McpProfileRevision, ownerConsent: McpConsent = consent) =>
  probeMcpRevision(candidate, ownerConsent, { supervisorEntrypoint });

describe("MCP capability probe", () => {
  it("inherits only the minimal process environment", () => {
    expect(
      mcpProbeEnvironment({
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        HOME: "/secret/home",
        NODE_OPTIONS: "--require malicious.cjs",
        NPM_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8" });
  });

  it("negotiates a modern stdio server and returns bounded sorted capabilities", async () => {
    const observation = await probe(revision("ready"));
    expect(typeof observation.protocolVersion).toBe("string");
    expect(observation).toEqual({
      state: "READY",
      protocolVersion: observation.protocolVersion,
      tools: ["tool_00", "tool_01"],
      resources: ["project_readme"],
      prompts: ["summarize_project"],
    });
  }, 10_000);

  it("rejects a mismatched consent before spawning", async () => {
    await expect(
      probe(revision("ready"), { ...consent, canonicalDigest: "1".repeat(64) }),
    ).rejects.toMatchObject({ code: "CONSENT_MISMATCH" });
  });

  it("rejects capability lists above the C1 limit", async () => {
    await expect(probe(revision("too-many-tools"))).resolves.toMatchObject({
      state: "OUTPUT_LIMIT_REACHED",
      tools: [],
    });
  }, 10_000);

  it("stops a stalled server at the five-second probe deadline", async () => {
    await expect(probe(revision("stalled"))).resolves.toEqual({
      state: "TIMED_OUT",
      protocolVersion: null,
      tools: [],
      resources: [],
      prompts: [],
    });
  }, 10_000);

  it("falls back to a 2025-era stdio server without widening its capabilities", async () => {
    const legacyRevision: McpProfileRevision = {
      ...revision("ready"),
      args: [legacyFixturePath],
      declaredTools: ["legacy_search"],
    };
    await expect(probe(legacyRevision)).resolves.toEqual({
      state: "READY",
      protocolVersion: "2025-06-18",
      tools: ["legacy_search"],
      resources: [],
      prompts: [],
    });
  }, 10_000);

  it("contains invalid JSON from an untrusted server as a typed failed probe", async () => {
    const invalidRevision: McpProfileRevision = {
      ...revision("ready"),
      args: [invalidFixturePath],
    };
    await expect(probe(invalidRevision)).resolves.toEqual({
      state: "INVALID_RESPONSE",
      protocolVersion: null,
      tools: [],
      resources: [],
      prompts: [],
    });
  }, 10_000);

  it("contains a server stdout flood without accepting any capability", async () => {
    const floodRevision: McpProfileRevision = {
      ...revision("ready"),
      args: [floodFixturePath],
    };
    await expect(probe(floodRevision)).resolves.toMatchObject({
      state: "OUTPUT_LIMIT_REACHED",
      tools: [],
      resources: [],
      prompts: [],
    });
  }, 10_000);
});
