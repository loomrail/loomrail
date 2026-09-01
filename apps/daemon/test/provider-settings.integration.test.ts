import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectProviderSelectionResponseSchema,
  projectsResponseSchema,
  type ProviderId,
  type WorkflowStage,
} from "@loomrail/contracts";
import { providerCapabilitiesSchema, type ProviderAdapter } from "@loomrail/provider-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/provider-selection.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";

const stages: readonly WorkflowStage[] = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"];

const inertAdapter = (provider: ProviderId, supportedStages: readonly WorkflowStage[]): ProviderAdapter => ({
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider,
      start: true,
      interrupt: false,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: supportedStages,
      costReporting: provider === "CLAUDE_CODE",
    }),
  start: () => Promise.reject(new Error("This provider-settings test never starts a session")),
  requestHandoff: () => Promise.resolve(undefined),
  abortSession: () => Promise.resolve(undefined),
});

describe("Project provider settings API", () => {
  let directory = "";
  let daemon: RunningDaemon | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail provider settings "));
  });

  afterEach(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const registerFixture = async (running: RunningDaemon, token: string) => {
    const session = await authenticate(running, token);
    const response = await fetch(`${running.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(running, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-project", fixtureId: "web-app-a" }),
    });
    expect(response.status).toBe(200);
    return session;
  };

  it("auto-selects the one authenticated live CLI and persists an explicit choice", async () => {
    let claudeAuthenticated = false;
    const registry = createProviderRegistry({
      env: {},
      adapters: {
        CODEX: inertAdapter("CODEX", stages),
        CLAUDE_CODE: inertAdapter("CLAUDE_CODE", ["DISCOVERY", "PLAN", "REVIEW"]),
      },
      executableAvailable: () => true,
      probeAuthentication: (provider) =>
        Promise.resolve(provider === "CODEX" || claudeAuthenticated ? "AUTHENTICATED" : "REQUIRED"),
    });
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo-projects"),
      providerRegistry: registry,
      logger: false,
    });
    const session = await registerFixture(daemon, token);
    const projectId = "project-fixture-web-app-a";

    const initialResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection`, {
      headers: { cookie: session.cookie },
    });
    const initial = projectProviderSelectionResponseSchema.parse(await initialResponse.json());
    expect(initial).toMatchObject({
      selection: { preference: "AUTO", projectVersion: 1 },
      effectiveProvider: "CODEX",
      source: "AUTO",
      fallbackReason: null,
    });
    expect(initial.providers.find(({ provider }) => provider === "CLAUDE_CODE")).toMatchObject({
      installed: true,
      authentication: "REQUIRED",
      ready: false,
    });

    const setResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection`, {
      method: "PUT",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "choose-claude",
        expectedProjectVersion: 1,
        preference: "CLAUDE_CODE",
      }),
    });
    const selected = projectProviderSelectionResponseSchema.parse(await setResponse.json());
    expect(selected).toMatchObject({
      selection: { preference: "CLAUDE_CODE", projectVersion: 2 },
      effectiveProvider: "CLAUDE_CODE",
      source: "PROJECT_PREFERENCE",
      fallbackReason: "LIVE_PROVIDER_UNAVAILABLE",
    });

    claudeAuthenticated = true;
    const refreshedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection/refresh`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({ schemaVersion: 1 }),
      },
    );
    const refreshed = projectProviderSelectionResponseSchema.parse(await refreshedResponse.json());
    expect(refreshed).toMatchObject({
      selection: { preference: "CLAUDE_CODE", projectVersion: 2 },
      effectiveProvider: "CLAUDE_CODE",
      fallbackReason: null,
    });

    const projectsResponse = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await projectsResponse.json());
    expect(projects.projects[0]).toMatchObject({ providerPreference: "CLAUDE_CODE", version: 2 });
  });

  it("makes an environment override visible and refuses a selector that cannot take effect", async () => {
    const registry = createProviderRegistry({
      env: { LOOMRAIL_PROVIDER: "MOCK" },
      executableAvailable: () => false,
      probeAuthentication: () => Promise.resolve("UNKNOWN"),
    });
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo-projects"),
      providerRegistry: registry,
      logger: false,
    });
    const session = await registerFixture(daemon, token);
    const projectId = "project-fixture-web-app-a";
    const selectionResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection`,
      { headers: { cookie: session.cookie } },
    );
    expect(projectProviderSelectionResponseSchema.parse(await selectionResponse.json())).toMatchObject({
      effectiveProvider: "MOCK",
      environmentOverride: "MOCK",
      environmentOverrideLocked: true,
    });

    const mutation = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/provider-selection`, {
      method: "PUT",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "choose-codex",
        expectedProjectVersion: 1,
        preference: "CODEX",
      }),
    });
    expect(mutation.status).toBe(409);
    expect(await mutation.text()).toContain("PROVIDER_OVERRIDE_ACTIVE");
  });
});
