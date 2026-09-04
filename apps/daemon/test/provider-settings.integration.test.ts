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

const testModels = {
  FAST: "test-fast",
  STANDARD: "test-standard",
  DEEP: "test-deep",
} as const;

const inertAdapter = (
  provider: ProviderId,
  supportedStages: readonly WorkflowStage[],
  options: { canReportRateLimits?: boolean; readAllowance?: ProviderAdapter["readAllowance"] } = {},
): ProviderAdapter => ({
  modelMapping: () => testModels,
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
      canReportRateLimits: options.canReportRateLimits ?? false,
    }),
  ...(options.readAllowance === undefined ? {} : { readAllowance: options.readAllowance }),
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

  it("prefers an alternate ready reviewer only while AUTO remains in control", async () => {
    const codex = inertAdapter("CODEX", stages);
    const claude = inertAdapter("CLAUDE_CODE", ["DISCOVERY", "PLAN", "REVIEW"]);
    const registry = createProviderRegistry({
      env: {},
      adapters: { CODEX: codex, CLAUDE_CODE: claude },
      executableAvailable: () => true,
      probeCompatibility: (provider) =>
        Promise.resolve({
          compatibility: "VERIFIED",
          version: provider === "CODEX" ? "0.152.1" : "2.1.258",
        }),
      probeAuthentication: () => Promise.resolve("AUTHENTICATED"),
    });
    await registry.refresh();
    expect(registry.availability().map(({ provider }) => provider)).toEqual(["MOCK", "CODEX", "CLAUDE_CODE"]);
    const project: Project = {
      schemaVersion: 1,
      id: "project-auto-review",
      workspaceId: "workspace-local",
      fixtureId: null,
      name: "AUTO review",
      repositoryPath: directory,
      providerPreference: "AUTO",
      status: "ACTIVE",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };

    expect(
      registry.resolve(project, { stage: "REVIEW", avoidProvider: "CODEX" }).adapter.capabilities().provider,
    ).toBe("CLAUDE_CODE");
    expect(
      registry.resolve(project, { stage: "REVIEW", avoidProvider: "CLAUDE_CODE" }).adapter.capabilities()
        .provider,
    ).toBe("CODEX");
    expect(
      registry.resolve(project, { stage: "IMPLEMENT", avoidProvider: "CODEX" }).adapter.capabilities()
        .provider,
    ).toBe("CODEX");
    expect(
      registry
        .resolve(
          { ...project, providerPreference: "CODEX" },
          {
            stage: "REVIEW",
            avoidProvider: "CODEX",
          },
        )
        .adapter.capabilities().provider,
    ).toBe("CODEX");
  });

  it("probes auth only after exact compatibility and observes a verified version on refresh", async () => {
    let codexVerified = false;
    const authProbes: ProviderId[] = [];
    const registry = createProviderRegistry({
      env: {},
      adapters: {
        CODEX: inertAdapter("CODEX", stages),
        CLAUDE_CODE: inertAdapter("CLAUDE_CODE", ["DISCOVERY", "PLAN", "REVIEW"]),
      },
      executableAvailable: () => true,
      probeCompatibility: (provider) =>
        Promise.resolve(
          provider === "CODEX"
            ? {
                compatibility: codexVerified ? ("VERIFIED" as const) : ("UNVERIFIED" as const),
                version: "0.152.1",
              }
            : { compatibility: "TOO_OLD" as const, version: "2.1.114" },
        ),
      probeAuthentication: (provider) => {
        authProbes.push(provider);
        return Promise.resolve("AUTHENTICATED");
      },
    });

    await registry.refresh();
    expect(authProbes).toEqual([]);
    expect(registry.availability().find(({ provider }) => provider === "CODEX")).toMatchObject({
      compatibility: "UNVERIFIED",
      version: "0.152.1",
      authentication: "UNKNOWN",
      ready: false,
    });
    expect(registry.availability().find(({ provider }) => provider === "CLAUDE_CODE")).toMatchObject({
      compatibility: "TOO_OLD",
      version: "2.1.114",
      authentication: "UNKNOWN",
      ready: false,
    });
    const project: Project = {
      schemaVersion: 1,
      id: "project-unverified",
      workspaceId: "workspace-local",
      fixtureId: null,
      name: "Unverified provider",
      repositoryPath: directory,
      providerPreference: "AUTO",
      status: "ACTIVE",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    expect(registry.resolve(project).response).toMatchObject({
      effectiveProvider: "MOCK",
      fallbackReason: "NO_READY_LIVE_PROVIDER",
    });
    const explicit = registry.resolve({ ...project, providerPreference: "CODEX" });
    expect(explicit.response).toMatchObject({
      effectiveProvider: "CODEX",
      fallbackReason: "LIVE_PROVIDER_UNAVAILABLE",
    });
    expect(explicit.adapter.capabilities().start).toBe(false);

    codexVerified = true;
    await registry.refresh();
    expect(authProbes).toEqual(["CODEX"]);
    expect(registry.availability().find(({ provider }) => provider === "CODEX")).toMatchObject({
      compatibility: "VERIFIED",
      authentication: "AUTHENTICATED",
      ready: true,
    });
  });

  it("admits allowance only for its exact target and auth, independently from execution", async () => {
    let version = "0.153.0-alpha.5";
    let authentication: "REQUIRED" | "AUTHENTICATED" = "REQUIRED";
    let authenticationMode: "OTHER" | "CHATGPT" = "OTHER";
    let reads = 0;
    const codex = inertAdapter("CODEX", stages, {
      canReportRateLimits: true,
      readAllowance: () => {
        reads += 1;
        return Promise.resolve({
          schemaVersion: 1,
          provider: "CODEX",
          observedAt: "2026-09-04T20:00:00.000Z",
          freshness: "UNAVAILABLE",
          buckets: [],
          unavailableReason: "DATA_NOT_PRESENT",
        });
      },
    });
    const registry = createProviderRegistry({
      env: {},
      adapters: { CODEX: codex },
      executableAvailable: () => true,
      probeCompatibility: (provider) =>
        Promise.resolve({
          compatibility: "UNVERIFIED",
          version: provider === "CODEX" ? version : "2.1.260",
        }),
      probeAuthentication: () => Promise.resolve(authentication),
      rateLimitVersionTargetVerified: (provider, observation) =>
        provider === "CODEX" && observation.version === "0.153.1",
      probeRateLimitAuthenticationMode: () => Promise.resolve(authenticationMode),
    });
    const project: Project = {
      schemaVersion: 1,
      id: "project-allowance-admission",
      workspaceId: "workspace-local",
      fixtureId: null,
      name: "Allowance admission",
      repositoryPath: directory,
      providerPreference: "CODEX",
      status: "ACTIVE",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };

    await registry.refresh();
    expect(registry.resolve(project).adapter.capabilities().canReportRateLimits).toBe(false);
    expect(registry.resolve(project).adapter.readAllowance).toBeUndefined();
    version = "0.153.1";
    await registry.refresh();
    expect(registry.resolve(project).adapter.capabilities().canReportRateLimits).toBe(false);
    authentication = "AUTHENTICATED";
    await registry.refresh();
    expect(registry.resolve(project).adapter.capabilities().canReportRateLimits).toBe(false);
    authenticationMode = "CHATGPT";
    await registry.refresh();
    const admitted = registry.resolve(project).adapter;
    expect(admitted.capabilities().start).toBe(false);
    expect(admitted.capabilities().canReportRateLimits).toBe(true);
    await admitted.readAllowance?.();
    expect(reads).toBe(1);
  });

  it("auto-selects the one authenticated live CLI and persists an explicit choice", async () => {
    let claudeAuthenticated = false;
    const registry = createProviderRegistry({
      env: {},
      adapters: {
        CODEX: inertAdapter("CODEX", stages),
        CLAUDE_CODE: inertAdapter("CLAUDE_CODE", ["DISCOVERY", "PLAN", "REVIEW"]),
      },
      executableAvailable: () => true,
      probeCompatibility: (provider) =>
        Promise.resolve({
          compatibility: "VERIFIED",
          version: provider === "CODEX" ? "0.152.1" : "2.1.258",
        }),
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
    expect(initial.providers.find(({ provider }) => provider === "CODEX")?.models).toEqual(testModels);
    expect(initial.providers.find(({ provider }) => provider === "CLAUDE_CODE")).toMatchObject({
      installed: true,
      authentication: "REQUIRED",
      version: "2.1.258",
      compatibility: "VERIFIED",
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
