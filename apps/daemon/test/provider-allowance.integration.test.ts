import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectProviderAllowanceResponseSchema, type ProviderAllowanceSnapshot } from "@loomrail/contracts";
import { providerCapabilitiesSchema, type ProviderAdapter } from "@loomrail/provider-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/provider-selection.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";

const liveSnapshot: ProviderAllowanceSnapshot = {
  schemaVersion: 1,
  provider: "CODEX",
  observedAt: "2026-09-04T19:59:00.000Z",
  freshness: "LIVE",
  buckets: [
    {
      id: "codex:primary",
      name: "Codex",
      kind: "PRIMARY",
      usedPercent: 30,
      remainingPercent: 70,
      windowDurationMins: 300,
      resetsAt: "2026-09-05T00:00:00.000Z",
      limitReached: false,
    },
  ],
  unavailableReason: null,
};

describe("provider allowance API", () => {
  let directory = "";
  let daemon: RunningDaemon | undefined;
  let now = new Date("2026-09-04T20:00:00.000Z");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail allowance API тест "));
    now = new Date("2026-09-04T20:00:00.000Z");
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const codexAdapter = (readAllowance: () => Promise<ProviderAllowanceSnapshot>): ProviderAdapter => ({
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CODEX",
        start: true,
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        contextWindowReporting: true,
        checkpointOnRequest: false,
        contextWindowTokens: 128_000,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
        canReportRateLimits: true,
      }),
    modelMapping: () => ({ FAST: "fast", STANDARD: "standard", DEEP: "deep" }),
    readAllowance,
    start: () => Promise.reject(new Error("This API test never starts a provider session")),
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  });

  const boot = async (
    readAllowance: () => Promise<ProviderAllowanceSnapshot>,
    options: { allowanceReadDeadlineMs?: number } = {},
  ) => {
    const registry = createProviderRegistry({
      env: {},
      adapters: { CODEX: codexAdapter(readAllowance) },
      executableAvailable: (provider) => provider === "CODEX",
      probeCompatibility: (provider) =>
        Promise.resolve(
          provider === "CODEX"
            ? { compatibility: "VERIFIED" as const, version: "0.153.0-alpha.5" }
            : { compatibility: "UNVERIFIED" as const, version: "2.1.260" },
        ),
      probeAuthentication: () => Promise.resolve("AUTHENTICATED"),
      rateLimitVersionTargetVerified: (provider) => provider === "CODEX",
      probeRateLimitAuthenticationMode: () => Promise.resolve("CHATGPT"),
    });
    const token = bootstrapToken();
    const running = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo-projects"),
      providerRegistry: registry,
      ...(options.allowanceReadDeadlineMs === undefined
        ? {}
        : { providerAllowanceReadDeadlineMs: options.allowanceReadDeadlineMs }),
      now: () => new Date(now),
      logger: false,
    });
    daemon = running;
    const session = await authenticate(running, token);
    const registration = await fetch(`${running.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(running, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-project", fixtureId: "web-app-a" }),
    });
    expect(registration.status).toBe(200);
    return { running, session, projectId: "project-fixture-web-app-a" };
  };

  it("requires a session and keeps unavailable distinct from zero before the first observation", async () => {
    const { running, session, projectId } = await boot(() => Promise.resolve(liveSnapshot));
    const unauthorized = await fetch(`${running.baseUrl}/api/v1/provider/allowance?projectId=${projectId}`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${running.baseUrl}/api/v1/provider/allowance?projectId=${projectId}`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect(projectProviderAllowanceResponseSchema.parse(await response.json()).current).toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason: "DATA_NOT_PRESENT",
      buckets: [],
    });
  });

  it("requires Origin and CSRF, coalesces concurrent reads and persists restart-safe freshness", async () => {
    let reads = 0;
    const { running, session, projectId } = await boot(async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return liveSnapshot;
    });
    const route = `${running.baseUrl}/api/v1/projects/${projectId}/provider-allowance/refresh`;
    const rejected = await fetch(route, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(rejected.status).toBe(403);

    const responses = await Promise.all(
      [0, 1].map(() =>
        fetch(route, {
          method: "POST",
          headers: mutationHeaders(running, session),
          body: JSON.stringify({ schemaVersion: 1 }),
        }),
      ),
    );
    const first = responses[0];
    const second = responses[1];
    if (first === undefined || second === undefined) throw new Error("expected two refresh responses");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(reads).toBe(1);
    expect(projectProviderAllowanceResponseSchema.parse(await first.json()).current).toMatchObject({
      freshness: "LIVE",
      buckets: [{ remainingPercent: 70 }],
    });

    await running.close();
    daemon = undefined;
    now = new Date("2026-09-04T20:20:00.000Z");
    const restarted = await boot(() => Promise.resolve(liveSnapshot));
    const restored = await fetch(
      `${restarted.running.baseUrl}/api/v1/provider/allowance?projectId=${restarted.projectId}`,
      { headers: { cookie: restarted.session.cookie } },
    );
    expect(projectProviderAllowanceResponseSchema.parse(await restored.json()).current).toMatchObject({
      freshness: "STALE",
    });
  });

  it("enforces the outer API deadline and frees the coalescing slot for a retry", async () => {
    let reads = 0;
    const { running, session, projectId } = await boot(
      () => {
        reads += 1;
        return reads === 1
          ? new Promise<ProviderAllowanceSnapshot>(() => undefined)
          : Promise.resolve({ ...liveSnapshot, observedAt: "2026-09-04T20:00:00.001Z" });
      },
      { allowanceReadDeadlineMs: 25 },
    );
    const startedAt = Date.now();
    const response = await fetch(
      `${running.baseUrl}/api/v1/projects/${projectId}/provider-allowance/refresh`,
      {
        method: "POST",
        headers: mutationHeaders(running, session),
        body: JSON.stringify({ schemaVersion: 1 }),
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(response.status).toBe(200);
    expect(projectProviderAllowanceResponseSchema.parse(await response.json()).current).toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason: "PROVIDER_TIMEOUT",
    });

    const retry = await fetch(`${running.baseUrl}/api/v1/projects/${projectId}/provider-allowance/refresh`, {
      method: "POST",
      headers: mutationHeaders(running, session),
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(retry.status).toBe(200);
    expect(reads).toBe(2);
    expect(projectProviderAllowanceResponseSchema.parse(await retry.json()).current).toMatchObject({
      freshness: "LIVE",
      buckets: [{ remainingPercent: 70 }],
    });
  });
});
