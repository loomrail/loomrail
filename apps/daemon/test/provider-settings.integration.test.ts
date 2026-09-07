import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectProviderSelectionResponseSchema,
  projectsResponseSchema,
  type Project,
  type ProviderId,
  type WorkflowStage,
} from "@loomrail/contracts";
import { providerCapabilitiesSchema, type ProviderAdapter } from "@loomrail/provider-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/provider-selection.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";

const stages: readonly WorkflowStage[] = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"];
const testModels = { FAST: "test-fast", STANDARD: "test-standard", DEEP: "test-deep" } as const;

const inertAdapter = (provider: Exclude<ProviderId, "MOCK">, supportedStages = stages): ProviderAdapter => ({
  modelMapping: () => testModels,
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider,
      start: true,
      interrupt: true,
      eventStream: false,
      usageReporting: true,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: supportedStages,
      costReporting: provider === "CLAUDE_CODE",
      tokenBudgetEnforcement: "POST_SESSION",
      canReportRateLimits: false,
    }),
  start: () => Promise.reject(new Error("This provider-selection test never dispatches")),
  requestHandoff: () => Promise.resolve(),
  abortSession: () => Promise.resolve(),
});

describe("real provider settings API", () => {
  let directory = "";
  let daemon: RunningDaemon | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail real provider settings "));
  });

  afterEach(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const project = (): Project => ({
    schemaVersion: 1,
    id: "project-real-selection",
    workspaceId: "workspace-local",
    fixtureId: null,
    name: "Real provider selection",
    repositoryPath: directory,
    providerPreference: "AUTO",
    status: "ACTIVE",
    version: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  });

  it("lists only local Codex and Claude and selects a ready CLI adapter", async () => {
    const registry = createProviderRegistry({
      env: {},
      adapters: {
        CODEX: inertAdapter("CODEX"),
        CLAUDE_CODE: inertAdapter("CLAUDE_CODE", ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"]),
      },
      probeAuthentication: (provider) =>
        Promise.resolve(provider === "CLAUDE_CODE" ? "AUTHENTICATED" : "REQUIRED"),
      probeRuntime: () => Promise.resolve({ installed: true, compatibility: "VERIFIED", version: "1.0.0" }),
    });
    await registry.refresh();

    expect(registry.availability().map(({ provider }) => provider)).toEqual(["CODEX", "CLAUDE_CODE"]);
    expect(registry.resolve(project()).response).toMatchObject({
      effectiveProvider: "CLAUDE_CODE",
      fallbackReason: null,
      source: "AUTO",
    });
  });

  it("fails closed when neither local provider runtime is ready", async () => {
    const registry = createProviderRegistry({ env: {} });
    await registry.refresh();
    const resolution = registry.resolve(project());

    expect(resolution.response.providers).toHaveLength(2);
    expect(resolution.response.providers.every(({ ready }) => !ready)).toBe(true);
    expect(resolution.response.fallbackReason).toBe("NO_READY_LIVE_PROVIDER");
    expect(resolution.adapter.capabilities().start).toBe(false);
  });

  it("persists an explicit Anthropic choice through the authenticated API", async () => {
    const registry = createProviderRegistry({
      env: {},
      adapters: { CODEX: inertAdapter("CODEX"), CLAUDE_CODE: inertAdapter("CLAUDE_CODE") },
      probeAuthentication: () => Promise.resolve("AUTHENTICATED"),
      probeRuntime: () => Promise.resolve({ installed: true, compatibility: "VERIFIED", version: "1.0.0" }),
    });
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo-projects"),
      providerRegistry: registry,
      logger: false,
    });
    const session = await authenticate(daemon, token);
    await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-project", fixtureId: "web-app-a" }),
    });
    const projectId = "project-fixture-web-app-a";
    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection`, {
      method: "PUT",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "select-anthropic",
        expectedProjectVersion: 1,
        preference: "CLAUDE_CODE",
      }),
    });
    expect(response.status).toBe(200);
    expect(projectProviderSelectionResponseSchema.parse(await response.json())).toMatchObject({
      selection: { preference: "CLAUDE_CODE", projectVersion: 2 },
      effectiveProvider: "CLAUDE_CODE",
    });

    const projectsResponse = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await projectsResponse.json());
    expect(projects.projects[0]).toMatchObject({ providerPreference: "CLAUDE_CODE", version: 2 });
  });
});
