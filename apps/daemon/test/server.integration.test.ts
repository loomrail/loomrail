import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apiErrorResponseSchema,
  correlationIdSchema,
  sessionExchangeResponseSchema,
  stateCommandResultSchema,
} from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";

const bootstrapToken = (): string => randomBytes(32).toString("base64url");

type AuthenticatedSession = {
  cookie: string;
  csrfToken: string;
  setCookie: string;
};

const authenticate = async (daemon: RunningDaemon, token: string): Promise<AuthenticatedSession> => {
  const exchange = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: daemon.baseUrl },
    body: JSON.stringify({ bootstrapToken: token }),
  });
  const setCookie = exchange.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie || !setCookie) throw new Error("Session exchange did not return a cookie");
  const session = sessionExchangeResponseSchema.parse(await exchange.json());
  return { cookie, csrfToken: session.csrfToken, setCookie };
};

const mutationHeaders = (daemon: RunningDaemon, session: AuthenticatedSession): Record<string, string> => ({
  "content-type": "application/json",
  cookie: session.cookie,
  origin: daemon.baseUrl,
  "x-loomrail-csrf": session.csrfToken,
});

describe("local daemon session and state boundary", () => {
  let daemon: RunningDaemon | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("exposes health but protects product status", async () => {
    daemon = await startDaemon({ bootstrapToken: bootstrapToken(), logger: false });

    const health = await fetch(`${daemon.baseUrl}/health/ready`);
    const status = await fetch(`${daemon.baseUrl}/api/v1/status`);

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ready", apiVersion: "v1" });
    expect(status.status).toBe(401);
    expect(new URL(daemon.baseUrl).hostname).toBe("127.0.0.1");
    expect(daemon.app.server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("accepts only a valid correlation ID from an HTTP header", async () => {
    daemon = await startDaemon({ bootstrapToken: bootstrapToken(), logger: false });

    const invalid = await fetch(`${daemon.baseUrl}/api/v1/status`, {
      headers: { "x-correlation-id": "invalid correlation id" },
    });
    const invalidError = apiErrorResponseSchema.parse(await invalid.json());
    const valid = await fetch(`${daemon.baseUrl}/api/v1/status`, {
      headers: { "x-correlation-id": "client-request_42" },
    });
    const validError = apiErrorResponseSchema.parse(await valid.json());

    expect(invalid.status).toBe(401);
    expect(correlationIdSchema.parse(invalidError.error.correlationId)).not.toBe("invalid correlation id");
    expect(valid.status).toBe(401);
    expect(validError.error.correlationId).toBe("client-request_42");
  });

  it("keeps bootstrap and session canaries out of structured logs", async () => {
    const token = "bootstrap-canary-do-not-log".padEnd(43, "x");
    const logLines: string[] = [];
    daemon = await startDaemon({
      bootstrapToken: token,
      loggerStream: {
        write: (line) => {
          logLines.push(line);
        },
      },
    });
    const session = await authenticate(daemon, token);
    const cookieCanary = "cookie-canary-do-not-log";
    const authorizationCanary = "authorization-canary-do-not-log";
    const csrfCanary = "csrf-canary-do-not-log";

    daemon.app.log.info(
      {
        req: {
          headers: {
            authorization: authorizationCanary,
            cookie: cookieCanary,
            "x-loomrail-csrf": csrfCanary,
          },
        },
        res: { headers: { "set-cookie": cookieCanary } },
      },
      "redaction canary",
    );

    const logs = logLines.join("");
    expect(logs).toContain("redaction canary");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(cookieCanary);
    expect(logs).not.toContain(authorizationCanary);
    expect(logs).not.toContain(csrfCanary);
    expect(logs).not.toContain(session.csrfToken);
  });

  it("rejects a foreign bootstrap origin", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });

    const response = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ bootstrapToken: token }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an expired bootstrap token", async () => {
    const token = bootstrapToken();
    let currentTime = new Date("2026-08-22T18:00:00.000Z");
    daemon = await startDaemon({ bootstrapToken: token, logger: false, now: () => currentTime });
    currentTime = new Date(currentTime.getTime() + 61_000);

    const response = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: daemon.baseUrl },
      body: JSON.stringify({ bootstrapToken: token }),
    });

    expect(response.status).toBe(401);
  });

  it("consumes a bootstrap token once and reports the M2 kernel", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const replay = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: daemon.baseUrl },
      body: JSON.stringify({ bootstrapToken: token }),
    });
    const status = await fetch(`${daemon.baseUrl}/api/v1/status`, {
      headers: { cookie: session.cookie },
    });

    expect(replay.status).toBe(401);
    expect(status.status).toBe(200);
    expect(session.setCookie).toMatch(/HttpOnly/i);
    expect(session.setCookie).toMatch(/SameSite=Strict/i);
    expect(status.headers.get("access-control-allow-origin")).toBeNull();
    expect(await status.json()).toMatchObject({
      authenticated: true,
      foundation: { phase: "phase-0", milestone: "M2", persistence: "sqlite" },
    });
  });

  it("requires a valid session-bound CSRF token for mutations", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const body = JSON.stringify({
      schemaVersion: 1,
      commandId: "register-without-csrf",
      fixtureId: "web-app-a",
    });

    const missing = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: daemon.baseUrl,
      },
      body,
    });
    const foreign = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: {
        ...mutationHeaders(daemon, session),
        origin: "https://example.com",
      },
      body,
    });
    const wrong = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: {
        ...mutationHeaders(daemon, session),
        "x-loomrail-csrf": "wrong-csrf-token",
      },
      body,
    });

    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("rejects a non-catalog fixture identifier at the HTTP boundary", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-traversal-fixture",
        fixtureId: "../web-app-a",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("persists Project, WorkItem, idempotency receipt and Events across daemon restart", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon state "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const firstToken = bootstrapToken();
    const firstDaemon = await startDaemon({ bootstrapToken: firstToken, logger: false, stateDatabasePath });
    daemon = firstDaemon;
    const firstSession = await authenticate(firstDaemon, firstToken);

    const registration = await fetch(`${firstDaemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(firstDaemon, firstSession),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-web-fixture",
        fixtureId: "web-app-a",
      }),
    });
    expect(registration.status).toBe(200);

    const createBody = {
      schemaVersion: 1,
      commandId: "create-first-work-item",
      projectId: "project-fixture-web-app-a",
      type: "TASK",
      title: "Persist the first task",
      acceptanceCriteria: ["It survives restart"],
    };
    const createResponses = await Promise.all(
      [0, 1].map(() =>
        fetch(`${firstDaemon.baseUrl}/api/v1/work-items`, {
          method: "POST",
          headers: mutationHeaders(firstDaemon, firstSession),
          body: JSON.stringify(createBody),
        }),
      ),
    );
    const createResults = await Promise.all(
      createResponses.map(async (response) => stateCommandResultSchema.parse(await response.json())),
    );
    const created = createResults.find((result) => !result.replayed);
    const replayed = createResults.find((result) => result.replayed);
    if (!created || !replayed) throw new Error("Expected one accepted command and one replay");
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");

    expect(createResponses.every((response) => response.status === 200)).toBe(true);
    expect(replayed).toMatchObject({ type: "WORK_ITEM_CREATED", replayed: true });

    const updatedResponse = await fetch(`${firstDaemon.baseUrl}/api/v1/work-items/${created.workItem.id}`, {
      method: "PATCH",
      headers: mutationHeaders(firstDaemon, firstSession),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "update-first-work-item",
        expectedVersion: 1,
        patch: { title: "Persist the updated task" },
      }),
    });
    const updated = stateCommandResultSchema.parse(await updatedResponse.json());
    const movedResponse = await fetch(
      `${firstDaemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`,
      {
        method: "POST",
        headers: mutationHeaders(firstDaemon, firstSession),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "ready-first-work-item",
          expectedVersion: 2,
          targetState: "READY",
        }),
      },
    );
    const moved = stateCommandResultSchema.parse(await movedResponse.json());

    expect(updatedResponse.status).toBe(200);
    expect(updated).toMatchObject({ type: "WORK_ITEM_UPDATED", workItem: { version: 2 } });
    expect(movedResponse.status).toBe(200);
    expect(moved).toMatchObject({ type: "WORK_ITEM_MOVED", workItem: { state: "READY", version: 3 } });

    await firstDaemon.close();
    daemon = undefined;
    const secondToken = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: secondToken, logger: false, stateDatabasePath });
    const secondSession = await authenticate(daemon, secondToken);
    const loaded = await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}`, {
      headers: { cookie: secondSession.cookie },
    });
    const events = await fetch(`${daemon.baseUrl}/api/v1/events`, {
      headers: { cookie: secondSession.cookie },
    });

    expect(await loaded.json()).toMatchObject({
      workItem: {
        id: created.workItem.id,
        state: "READY",
        title: "Persist the updated task",
        version: 3,
      },
    });
    expect(await events.json()).toMatchObject({
      nextSequence: 4,
      events: [
        { type: "PROJECT_REGISTERED" },
        { type: "WORK_ITEM_CREATED" },
        { type: "WORK_ITEM_UPDATED" },
        { type: "WORK_ITEM_STATE_CHANGED" },
      ],
    });
  });
});
