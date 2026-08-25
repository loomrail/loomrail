import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  apiErrorResponseSchema,
  correlationIdSchema,
  eventsResponseSchema,
  sessionExchangeResponseSchema,
  stateCommandResultSchema,
  workItemsResponseSchema,
  workflowSnapshotSchema,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
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

  it("shuts down while a client holds a connection it never sent a request on", async () => {
    const started = await startDaemon({ bootstrapToken: bootstrapToken(), logger: false });
    daemon = started;

    // Browsers open speculative connections ahead of the requests they may never make. Such a
    // socket carries no request, so it is not an idle keep-alive connection either, and nothing
    // in the HTTP server reclaims it on close.
    const accepted = once(started.app.server, "connection");
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(started.baseUrl).port) });
    socket.on("error", () => {
      // Shutdown resets this socket, which is the behaviour under test.
    });
    await Promise.all([once(socket, "connect"), accepted]);

    try {
      const outcome = await Promise.race([
        started.close().then(() => "closed" as const),
        delay(3_000, "hung" as const),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      socket.destroy();
    }
  }, 15_000);

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

  it("blocks stylesheet injection while allowing overlay style attributes", async () => {
    daemon = await startDaemon({ bootstrapToken: bootstrapToken(), logger: false });

    const response = await fetch(`${daemon.baseUrl}/health/ready`);
    const policy = response.headers.get("content-security-policy") ?? "";
    const directive = (name: string): string =>
      policy
        .split(";")
        .map((part) => part.trim())
        .find((part) => part === name || part.startsWith(`${name} `)) ?? "";

    // Script and stylesheet sources stay same-origin only.
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("style-src")).toBe("style-src 'self'");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    // Overlay positioning needs inline style attributes; nothing else inline is permitted.
    expect(directive("style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(directive("script-src-attr")).toBe("script-src-attr 'none'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
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

  it("consumes a bootstrap token once and reports the M6 mock workflow", async () => {
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
      foundation: { phase: "phase-0", milestone: "M6", persistence: "sqlite" },
    });
  });

  it("serves web assets added after daemon startup instead of the SPA fallback", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail dynamic web "));
    temporaryDirectories.push(temporaryDirectory);
    await writeFile(join(temporaryDirectory, "index.html"), "<main>Loomrail shell</main>", "utf8");
    daemon = await startDaemon({
      bootstrapToken: bootstrapToken(),
      logger: false,
      webRoot: temporaryDirectory,
    });

    const assetsDirectory = join(temporaryDirectory, "assets");
    await mkdir(assetsDirectory);
    await writeFile(join(assetsDirectory, "fresh-build.js"), "export const ready = true;", "utf8");

    const asset = await fetch(`${daemon.baseUrl}/assets/fresh-build.js`);
    const clientRoute = await fetch(`${daemon.baseUrl}/workbench/current`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(await asset.text()).toBe("export const ready = true;");
    expect(await clientRoute.text()).toBe("<main>Loomrail shell</main>");
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
      hasMore: false,
      nextSequence: 4,
      events: [
        { type: "PROJECT_REGISTERED" },
        { type: "WORK_ITEM_CREATED" },
        { type: "WORK_ITEM_UPDATED" },
        { type: "WORK_ITEM_STATE_CHANGED" },
      ],
    });

    const newestPage = await fetch(
      `${daemon.baseUrl}/api/v1/events?order=DESC&limit=2&aggregateId=${encodeURIComponent(created.workItem.id)}`,
      { headers: { cookie: secondSession.cookie } },
    );
    const newest = eventsResponseSchema.parse(await newestPage.json());
    expect(newest).toMatchObject({
      hasMore: true,
      events: [{ type: "WORK_ITEM_STATE_CHANGED" }, { type: "WORK_ITEM_UPDATED" }],
    });

    const olderPage = await fetch(
      `${daemon.baseUrl}/api/v1/events?order=DESC&limit=2&before=${newest.nextSequence.toString()}&aggregateId=${encodeURIComponent(created.workItem.id)}`,
      { headers: { cookie: secondSession.cookie } },
    );
    expect(await olderPage.json()).toMatchObject({
      hasMore: false,
      events: [{ type: "WORK_ITEM_CREATED" }],
    });
  });

  it("restores a blocking HumanRequest after restart and answers it exactly once", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail workflow state "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const firstToken = bootstrapToken();
    const firstDaemon = await startDaemon({ bootstrapToken: firstToken, logger: false, stateDatabasePath });
    daemon = firstDaemon;
    const firstSession = await authenticate(firstDaemon, firstToken);
    const headers = mutationHeaders(firstDaemon, firstSession);

    await fetch(`${firstDaemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-workflow-fixture",
        fixtureId: "web-app-a",
      }),
    });
    const createResponse = await fetch(`${firstDaemon.baseUrl}/api/v1/work-items`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "create-workflow-item",
        projectId: "project-fixture-web-app-a",
        type: "TASK",
        title: "Run the mock workflow",
      }),
    });
    const created = stateCommandResultSchema.parse(await createResponse.json());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    await fetch(`${firstDaemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "ready-workflow-item",
        expectedVersion: 1,
        targetState: "READY",
      }),
    });
    const startResponse = await fetch(
      `${firstDaemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/start`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "start-workflow-item",
          expectedVersion: 2,
        }),
      },
    );
    const waiting = workflowSnapshotSchema.parse(await startResponse.json());
    expect(startResponse.status).toBe(200);
    expect(waiting).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      humanRequests: [{ status: "OPEN", kind: "SINGLE_CHOICE", blocking: true }],
    });
    const request = waiting.humanRequests[0];
    if (!request) throw new Error("Expected an open HumanRequest");

    await firstDaemon.close();
    daemon = undefined;
    const secondToken = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: secondToken, logger: false, stateDatabasePath });
    const secondSession = await authenticate(daemon, secondToken);
    const restoredResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/workflow`,
      { headers: { cookie: secondSession.cookie } },
    );
    const restored = workflowSnapshotSchema.parse(await restoredResponse.json());
    expect(restored.humanRequests[0]).toMatchObject({ id: request.id, status: "OPEN", version: 1 });

    const answerBody = JSON.stringify({
      schemaVersion: 1,
      commandId: "answer-workflow-request",
      expectedVersion: 1,
      answer: { type: "OPTION", optionIds: ["focused-pass"] },
    });
    const answerResponse = await fetch(`${daemon.baseUrl}/api/v1/human-requests/${request.id}/answer`, {
      method: "POST",
      headers: mutationHeaders(daemon, secondSession),
      body: answerBody,
    });
    const hardPaused = workflowSnapshotSchema.parse(await answerResponse.json());
    expect(answerResponse.status).toBe(200);
    expect(hardPaused.run?.status).toBe("HARD_PAUSED");
    expect(hardPaused.stageAttempts.map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "DISCOVERY", status: "SUCCEEDED" },
      { stage: "PLAN", status: "SUCCEEDED" },
      { stage: "IMPLEMENT", status: "HARD_PAUSED" },
    ]);
    expect(hardPaused.usageRecords.map(({ amount }) => amount)).toEqual([50, 30, 15, 5]);
    expect(hardPaused.humanRequests[0]).toMatchObject({ status: "RESOLVED", version: 2 });
    expect(hardPaused.decisions).toHaveLength(1);

    const overrideResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/budget-override`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, secondSession),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "approve-budget-override",
          expectedVersion: hardPaused.run?.version,
          maxEstimatedTokens: 200,
        }),
      },
    );
    const awaitingAcceptance = workflowSnapshotSchema.parse(await overrideResponse.json());
    expect(overrideResponse.status).toBe(200);
    expect(awaitingAcceptance.run?.status).toBe("WAITING_HUMAN");
    expect(
      awaitingAcceptance.budgetPolicies.map(({ revision, maxEstimatedTokens }) => ({
        revision,
        maxEstimatedTokens,
      })),
    ).toEqual([
      { revision: 1, maxEstimatedTokens: 100 },
      { revision: 2, maxEstimatedTokens: 200 },
    ]);
    expect(awaitingAcceptance.stageAttempts.at(-1)).toMatchObject({
      stage: "ACCEPTANCE",
      status: "WAITING_HUMAN",
    });
    expect(awaitingAcceptance.artifacts.map(({ kind }) => kind).sort()).toEqual([
      "QA_REPORT",
      "REVIEW_REPORT",
    ]);
    expect(awaitingAcceptance.acceptancePackage).toMatchObject({ status: "PENDING" });
    expect([...(awaitingAcceptance.acceptancePackage?.artifactIds ?? [])].sort()).toEqual(
      awaitingAcceptance.artifacts.map(({ id }) => id).sort(),
    );
    const acceptancePackage = awaitingAcceptance.acceptancePackage;
    if (!acceptancePackage || !awaitingAcceptance.run) {
      throw new Error("Expected a pending AcceptancePackage");
    }
    const acceptanceResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/acceptance/${acceptancePackage.id}/resolve`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, secondSession),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "accept-workflow-delivery",
          expectedVersion: acceptancePackage.version,
          expectedRunVersion: awaitingAcceptance.run.version,
          action: "ACCEPT",
          reason: "Synthetic acceptance evidence is sufficient.",
        }),
      },
    );
    const completed = workflowSnapshotSchema.parse(await acceptanceResponse.json());
    expect(acceptanceResponse.status).toBe(200);
    expect(completed.run?.status).toBe("SUCCEEDED");
    expect(completed.acceptancePackage).toMatchObject({ status: "ACCEPTED", version: 2 });
    expect(completed.stageAttempts.at(-1)).toMatchObject({
      stage: "ACCEPTANCE",
      status: "SUCCEEDED",
    });
    const acceptedWorkItemResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}`,
      { headers: { cookie: secondSession.cookie } },
    );
    expect(await acceptedWorkItemResponse.json()).toMatchObject({ workItem: { state: "DONE" } });

    const repeated = await fetch(`${daemon.baseUrl}/api/v1/human-requests/${request.id}/answer`, {
      method: "POST",
      headers: mutationHeaders(daemon, secondSession),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "answer-workflow-request-again",
        expectedVersion: 2,
        answer: { type: "OPTION", optionIds: ["focused-pass"] },
      }),
    });
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      error: { code: "HUMAN_REQUEST_ALREADY_RESOLVED" },
    });
  });

  it("starts the current workflow after a legacy template version was persisted", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail legacy template "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-legacy-template-project",
        correlationId: "correlation-register-legacy-template-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_FIXTURE_PROJECT",
        payload: {
          id: "project-legacy-template",
          fixtureId: "web-app-a",
          name: "Legacy template fixture",
          repositoryPath: temporaryDirectory,
        },
      });
      const created = localState.execute({
        schemaVersion: 1,
        commandId: "create-legacy-template-task",
        correlationId: "correlation-create-legacy-template-task",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-legacy-template",
          parentId: null,
          type: "TASK",
          title: "Legacy template task",
          description: "Persists the pre-M6 workflow template version.",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: [],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute({
        schemaVersion: 1,
        commandId: "ready-legacy-template-task",
        correlationId: "correlation-ready-legacy-template-task",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
      });
      const started = localState.execute({
        schemaVersion: 1,
        commandId: "start-legacy-template-task",
        correlationId: "correlation-start-legacy-template-task",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: {
            schemaVersion: 1,
            id: "mock-delivery-v1",
            version: 1,
            name: "Mock delivery",
            stages: [
              { stage: "DISCOVERY", ordinal: 0 },
              { stage: "PLAN", ordinal: 1 },
            ],
          },
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      localState.execute({
        schemaVersion: 1,
        commandId: "mark-legacy-template-task-started",
        correlationId: "correlation-mark-legacy-template-task-started",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: started.dispatch.id },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-legacy-template-task",
        correlationId: "correlation-apply-legacy-template-task",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: started.dispatch.id,
          template: {
            schemaVersion: 1,
            id: "mock-delivery-v1",
            version: 1,
            name: "Mock delivery",
            stages: [
              { stage: "DISCOVERY", ordinal: 0 },
              { stage: "PLAN", ordinal: 1 },
            ],
          },
          outcome: {
            type: "NEEDS_HUMAN",
            request: {
              kind: "SINGLE_CHOICE",
              blocking: true,
              title: "Choose the discovery depth",
              context: "A durable decision is required before discovery can continue.",
              recommendation: "Use the focused pass.",
              options: [
                {
                  id: "focused-pass",
                  label: "Focused pass",
                  consequence: "Proceed with a bounded discovery.",
                  recommended: true,
                },
              ],
              allowOther: true,
            },
          },
        },
      });
    } finally {
      localState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false, stateDatabasePath });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);
    const createResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "create-current-template-task",
        projectId: "project-legacy-template",
        type: "TASK",
        title: "Current template task",
      }),
    });
    const created = stateCommandResultSchema.parse(await createResponse.json());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "ready-current-template-task",
        expectedVersion: 1,
        targetState: "READY",
      }),
    });
    const startResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/start`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "start-current-template-task",
          expectedVersion: 2,
        }),
      },
    );

    const startBody: unknown = await startResponse.json();
    expect(startResponse.status, JSON.stringify(startBody)).toBe(200);
    expect(workflowSnapshotSchema.parse(startBody)).toMatchObject({
      run: { workflowVersion: mockDeliveryTemplate.version, status: "WAITING_HUMAN" },
    });
  });

  it("marks an orphaned running attempt interrupted before serving startup traffic", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon recovery "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-recovery-project",
        correlationId: "correlation-register-recovery",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_FIXTURE_PROJECT",
        payload: {
          id: "project-recovery",
          fixtureId: "web-app-a",
          name: "Recovery fixture",
          repositoryPath: temporaryDirectory,
        },
      });
      const created = localState.execute({
        schemaVersion: 1,
        commandId: "create-recovery-task",
        correlationId: "correlation-create-recovery",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-recovery",
          parentId: null,
          type: "TASK",
          title: "Recover an orphaned attempt",
          description: "Synthetic recovery fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: [],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute({
        schemaVersion: 1,
        commandId: "ready-recovery-task",
        correlationId: "correlation-ready-recovery",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
      });
      const started = localState.execute({
        schemaVersion: 1,
        commandId: "start-recovery-task",
        correlationId: "correlation-start-recovery",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: mockDeliveryTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      localState.execute({
        schemaVersion: 1,
        commandId: "mark-recovery-task-running",
        correlationId: "correlation-mark-recovery",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: started.dispatch.id },
      });
    } finally {
      localState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false, stateDatabasePath });
    const session = await authenticate(daemon, token);
    const projects = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projectBody = await projects.json();
    expect(projectBody).toMatchObject({ projects: [{ id: "project-recovery" }] });
    const items = await fetch(`${daemon.baseUrl}/api/v1/projects/project-recovery/work-items`, {
      headers: { cookie: session.cookie },
    });
    const listed = workItemsResponseSchema.parse(await items.json());
    const recoveredResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${listed.workItems[0]?.id ?? "missing"}/workflow`,
      { headers: { cookie: session.cookie } },
    );
    const recovered = workflowSnapshotSchema.parse(await recoveredResponse.json());
    expect(recovered).toMatchObject({
      run: { status: "INTERRUPTED" },
      stageAttempts: [{ status: "INTERRUPTED", failureCode: "DAEMON_RESTART" }],
      recoveryReports: [{ reason: "DAEMON_RESTART" }],
    });

    const resumeResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${listed.workItems[0]?.id ?? "missing"}/pipeline/resume`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "resume-recovered-task",
          expectedVersion: recovered.run?.version,
        }),
      },
    );
    const resumed = workflowSnapshotSchema.parse(await resumeResponse.json());
    expect(resumeResponse.status).toBe(200);
    expect(resumed).toMatchObject({
      run: { status: "HARD_PAUSED" },
      recoveryReports: [{ reason: "DAEMON_RESTART" }],
    });

    const cancelResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${listed.workItems[0]?.id ?? "missing"}/pipeline/cancel`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "cancel-recovered-task",
          expectedVersion: resumed.run?.version,
        }),
      },
    );
    const cancelled = workflowSnapshotSchema.parse(await cancelResponse.json());
    expect(cancelResponse.status).toBe(200);
    expect(cancelled.run?.status).toBe("CANCELLED");
  });
});
