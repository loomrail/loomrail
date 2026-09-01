import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  attentionInboxResponseSchema,
  apiErrorResponseSchema,
  correlationIdSchema,
  eventsResponseSchema,
  projectsResponseSchema,
  reviewStateResponseSchema,
  stateCommandResultSchema,
  workItemChangesResponseSchema,
  workItemFileDiffResponseSchema,
  workItemsResponseSchema,
  workItemWorkspaceResponseSchema,
  workflowSnapshotSchema,
  type ContextPackSpec,
  type ProviderSession,
  type WorkflowTemplate,
} from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { createCodexProvider } from "@loomrail/provider-codex";
import { providerCapabilitiesSchema, type ProviderAdapter } from "@loomrail/provider-core";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { addWorktree, createCarryInSnapshot, inspectRepository, listWorktrees } from "@loomrail/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBundledFixture } from "../src/fixtures.js";
import { runStageAttempt } from "../src/session-loop.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import {
  authenticate,
  bootstrapToken,
  createReadyWorkItem,
  fetchWorkflowSnapshot,
  mutationHeaders,
  type AuthenticatedSession,
} from "./daemon-fixtures.js";
import { gatedAdapter } from "./gated-adapter.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";
import { seedQueuedAttempt, type SeededAttempt } from "./state-fixtures.js";

// The context pack a legacy (pre-current) persisted template still carries: DISCOVERY and PLAN
// never had an EVIDENCE section, since this legacy fixture only exercises those two stages.
const legacyContextPack: ContextPackSpec = {
  schemaVersion: 1,
  sections: [
    { id: "WORK_ITEM_BRIEF", ordinal: 0, required: true },
    { id: "WORKFLOW_POSITION", ordinal: 1, required: true },
    { id: "DECISIONS", ordinal: 2, required: true },
    { id: "LATEST_CHECKPOINT", ordinal: 3, required: true },
    { id: "ACTIVITY", ordinal: 4, required: false },
  ],
};

// IMPLEMENT alone, so a seeded pipeline's first dispatch is already the stage that needs a
// repository -- the stage the stale demo path used to make impossible.
const implementStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "IMPLEMENT");
if (!implementStage) throw new Error("The mock delivery template no longer declares IMPLEMENT");
const implementOnlyTemplate: WorkflowTemplate = {
  ...mockDeliveryTemplate,
  id: "demo-repair-implement-v1",
  version: 1,
  name: "Demo repair implement",
  stages: [{ ...implementStage, ordinal: 0 }],
};

// An adapter that does nothing and reports the stage done. Everything under test here happens
// before the adapter is called -- the worktree is cut, or the stage is refused -- so what the
// session does inside it is not the subject.
const completingAdapter = (): ProviderAdapter => ({
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider: "MOCK",
      start: true,
      interrupt: true,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      costReporting: false,
    }),
  start: () => Promise.resolve({ type: "COMPLETED", summary: "The mock session finished the stage." }),
  requestHandoff: () => Promise.resolve(),
  abortSession: () => Promise.resolve(),
});

// A READY WorkItem under an existing Project, an IMPLEMENT-only pipeline, and its dispatch already
// marked started -- the shape `runStageAttempt` expects to be handed.
const seedImplementAttempt = (localState: LocalState, projectId: string): SeededAttempt => {
  let nextCommandId = 0;
  const commandId = (): string => `seed-implement-${(nextCommandId += 1).toString()}`;
  const created = localState.execute({
    schemaVersion: 1,
    commandId: commandId(),
    correlationId: "correlation-seed-implement-item",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CREATE_WORK_ITEM",
    payload: {
      projectId,
      parentId: null,
      type: "TASK",
      title: "Fix the login redirect",
      description: "Synthetic work for the demo Project repair.",
      priority: "MEDIUM",
      risk: "LOW",
      acceptanceCriteria: ["The stage runs in a real worktree"],
    },
  });
  if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected a WorkItem");
  localState.execute({
    schemaVersion: 1,
    commandId: commandId(),
    correlationId: "correlation-seed-implement-ready",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "MOVE_WORK_ITEM",
    payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
  });
  const started = localState.execute({
    schemaVersion: 1,
    commandId: commandId(),
    correlationId: "correlation-seed-implement-pipeline",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "START_MOCK_PIPELINE",
    payload: {
      workItemId: created.workItem.id,
      expectedVersion: 2,
      template: implementOnlyTemplate,
      budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
    },
  });
  if (started.type !== "PIPELINE_STARTED") throw new Error("Expected a started pipeline");
  const dispatched = localState.execute({
    schemaVersion: 1,
    commandId: commandId(),
    correlationId: "correlation-seed-implement-dispatch",
    actor: { type: "SYSTEM", id: "session-loop" },
    type: "MARK_WORKFLOW_DISPATCH_STARTED",
    payload: { dispatchId: started.dispatch.id },
  });
  if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("Expected a started dispatch");
  return {
    workItemId: created.workItem.id,
    stageAttemptId: started.stageAttempt.id,
    dispatch: dispatched.dispatch,
  };
};

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

  it("protects the bounded review projection and owner disposition route", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const workItemId = await createReadyWorkItem(daemon, session, "review-route-boundary");

    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/reviews`);
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/reviews`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect(reviewStateResponseSchema.parse(await response.json())).toEqual({
      schemaVersion: 1,
      reports: [],
      findings: [],
    });

    const body = JSON.stringify({
      schemaVersion: 1,
      commandId: "dispose-missing-review-finding",
      expectedVersion: 1,
      disposition: "WAIVED",
      reason: "The owner accepts this bounded synthetic risk.",
    });
    const missingCsrf = await fetch(
      `${daemon.baseUrl}/api/v1/review-findings/missing-review-finding/disposition`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: daemon.baseUrl,
        },
        body,
      },
    );
    expect(missingCsrf.status).toBe(403);

    const missingFinding = await fetch(
      `${daemon.baseUrl}/api/v1/review-findings/missing-review-finding/disposition`,
      { method: "POST", headers: mutationHeaders(daemon, session), body },
    );
    expect(missingFinding.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await missingFinding.json())).toMatchObject({
      error: { code: "REVIEW_FINDING_NOT_FOUND" },
    });
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

  it("registers the bundled fixture as a real repository outside Loomrail's own checkout", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail demo materialise "));
    temporaryDirectories.push(temporaryDirectory);
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false, demoProjectsRoot });
    const session = await authenticate(daemon, token);

    const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-materialised", fixtureId: "web-app-a" }),
    });
    expect(registration.status).toBe(200);
    const registered = stateCommandResultSchema.parse(await registration.json());
    if (registered.type !== "PROJECT_REGISTERED") throw new Error("Expected the Project to register");

    // The Project points at the materialised copy, not at the template inside this checkout -- the
    // whole point of the copy is that `git worktree add` here can never reach Loomrail's own
    // repository.
    expect(registered.project.repositoryPath).not.toContain(join("fixtures", "projects"));
    expect(await realpath(registered.project.repositoryPath)).toBe(
      await realpath(join(demoProjectsRoot, "web-app-a")),
    );
    // The promise of the spec: a bundled fixture is a real repository with a first commit.
    const repository = await inspectRepository(registered.project.repositoryPath);
    expect(repository?.headCommit).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
    expect(await readFile(join(demoProjectsRoot, "web-app-a", "README.md"), "utf8")).toContain(
      "Fixture web application",
    );
  });

  // The one database that matters, and the only defect in this batch that breaks it completely.
  //
  // The owner's two demo Projects were registered before a bundled fixture became a real
  // repository, so their `repository_path` names a directory inside Loomrail's own checkout.
  // Migration 0012 carried those paths across verbatim -- correctly, since a migration cannot know
  // the data directory, which is runtime configuration. Pressing "Initialize demo workspace"
  // afterwards materialised the repository and then answered 409 PROJECT_ALREADY_REGISTERED: the
  // fresh repository orphaned on disk, both Projects pointing at the template forever, every
  // pipeline reaching IMPLEMENT refused at the provisioning guard, and no route in the UI to repair
  // it. This test starts from that exact row.
  it("repairs a demo Project still recording the bundled template, and cuts a workspace from the repository it then names", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail stale demo project "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const workspacesRoot = join(temporaryDirectory, "workspaces");
    // Not a path spelled out here: the bundled template's own path, resolved the same way the
    // daemon resolves it, which is what the pre-milestone registration wrote into the row.
    const fixture = await resolveBundledFixture("web-app-a");

    const seedState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      seedState.execute({
        schemaVersion: 1,
        commandId: "register-stale-demo-project",
        correlationId: "correlation-register-stale-demo",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: fixture.projectId,
          fixtureId: fixture.fixtureId,
          name: fixture.name,
          repositoryPath: fixture.templatePath,
        },
      });
    } finally {
      seedState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath,
      demoProjectsRoot,
    });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-stale-demo-again",
        fixtureId: "web-app-a",
      }),
    });

    // Not 409. The Project is moved onto the repository this call just materialised.
    expect(response.status).toBe(200);
    const repointed = stateCommandResultSchema.parse(await response.json());
    if (repointed.type !== "PROJECT_REGISTERED") throw new Error("Expected the Project to be repointed");
    const materialisedPath = await realpath(join(demoProjectsRoot, "web-app-a"));
    expect(repointed.project.repositoryPath).toBe(materialisedPath);
    expect(repointed.project.id).toBe(fixture.projectId);

    // One Project, at the new path: the repoint moved the existing row rather than adding a second.
    const projects = projectsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(projects.projects.map(({ id, repositoryPath }) => ({ id, repositoryPath }))).toEqual([
      { id: fixture.projectId, repositoryPath: materialisedPath },
    ]);

    // The repository the Project now names is a real one, outside this checkout, and the fresh copy
    // is not an orphan nobody records.
    expect(materialisedPath).not.toContain(join("fixtures", "projects"));
    expect((await inspectRepository(materialisedPath))?.topLevel).toBe(materialisedPath);

    // What the repair is actually for. The daemon is closed first so the stage runs against the same
    // database through a single connection, exactly as the running daemon's own worker would.
    await daemon.close();
    daemon = undefined;
    const runState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      // Seeded after the daemon has gone: a StageAttempt left RUNNING across a daemon start is
      // exactly what startup reconciliation marks INTERRUPTED, and this test is about the
      // repository the stage is handed, not about recovery.
      const seeded = seedImplementAttempt(runState, fixture.projectId);
      await runStageAttempt({
        state: runState,
        adapter: completingAdapter(),
        dispatch: seeded.dispatch,
        template: implementOnlyTemplate,
        workspacesRoot,
        createCommandId: (() => {
          let next = 0;
          return () => `command-stale-demo-${(next += 1).toString()}`;
        })(),
        correlationId: "correlation-stale-demo-run",
        logger: { info: () => undefined, warn: () => undefined },
      });
      const workspace = runState.query({
        type: "GET_WORKSPACE_BY_WORK_ITEM",
        workItemId: seeded.workItemId,
      });
      const cut = workspace.type === "WORKSPACE" ? workspace.workspace : null;
      // The defect this test is named for -- a repaired Project whose IMPLEMENT still cuts nothing --
      // arrives here. Asserted so it is reported as that, rather than as a crash on a sentence of
      // ours that says nothing about which of the two ways it failed.
      expect(cut, "the IMPLEMENT stage should have cut a workspace").not.toBeNull();
      if (!cut) {
        throw new Error("unreachable: the assertion above should already have failed");
      }
      expect(cut.status).toBe("READY");
      // Cut from the materialised repository -- asked of that repository itself, so this cannot pass
      // on a worktree that merely exists somewhere. At the stale path the provisioning guard refused
      // every attempt, because a directory inside a repository is never its own top level.
      const worktrees = await listWorktrees(materialisedPath);
      expect(await Promise.all(worktrees.map(({ path }) => realpath(path)))).toContain(
        await realpath(cut.worktreePath),
      );
      expect(worktrees.map(({ branch }) => branch)).toContain(cut.branch);
      // And living outside that repository, under the data directory, so the owner's own checkout
      // never shows Loomrail's directories.
      expect(await realpath(cut.worktreePath)).toContain(await realpath(workspacesRoot));
    } finally {
      runState.close();
    }
  }, 30_000);

  // The other half of the repair: it moves only a fixture-backed Project still pointing at the
  // bundled template. A Project already registered at its materialised repository is a duplicate
  // registration and still answers 409, unchanged.
  it("still refuses a second registration of a demo Project that already names its repository", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail duplicate demo "));
    temporaryDirectories.push(temporaryDirectory);
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const token = bootstrapToken();
    const started = await startDaemon({ bootstrapToken: token, logger: false, demoProjectsRoot });
    daemon = started;
    const session = await authenticate(started, token);

    const register = async (commandId: string) =>
      await fetch(`${started.baseUrl}/api/v1/projects/fixtures/register`, {
        method: "POST",
        headers: mutationHeaders(started, session),
        body: JSON.stringify({ schemaVersion: 1, commandId, fixtureId: "web-app-a" }),
      });

    expect((await register("register-demo-first")).status).toBe(200);
    const second = await register("register-demo-second");
    expect(second.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await second.json()).error.code).toBe("PROJECT_ALREADY_REGISTERED");
  }, 30_000);

  // "Repair demo repository" is offered on `repositoryStatus === "UNUSABLE"`, which asks one
  // question: could a workspace be cut from this path right now. The repoint behind the button used
  // to apply on a narrower one -- is this path the bundled template -- so for every other way a demo
  // Project goes bad the button was pressable and could only fail. The reviewer's reproduction, and
  // this test's shape: a demo Project recorded at an ordinary directory that is not a repository.
  // Pressing Repair answered 409 with "A Project is already registered with this id, fixture or
  // repository path" printed under the button, the path unchanged, the button still there.
  //
  // Ordinary to reach without any migration in the story: the materialised
  // `<data>/demo-projects/<id>` moved or deleted, or a second daemon with a data directory of its
  // own.
  it("repairs a demo Project recorded at a directory that is not a repository, not only at the bundled template", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail broken demo project "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const fixture = await resolveBundledFixture("web-app-a");
    // Not the bundled template, and not the materialised path either: an ordinary directory that
    // exists and is not a repository -- what is left when the demo repository is moved away and its
    // parent recreated, or what the row already names on a machine whose data directory has since
    // been replaced.
    const brokenPath = join(temporaryDirectory, "not-a-repository");
    await mkdir(brokenPath, { recursive: true });

    const seedState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      seedState.execute({
        schemaVersion: 1,
        commandId: "register-broken-demo-project",
        correlationId: "correlation-register-broken-demo",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: fixture.projectId,
          fixtureId: fixture.fixtureId,
          name: fixture.name,
          repositoryPath: brokenPath,
        },
      });
    } finally {
      seedState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath,
      demoProjectsRoot,
    });
    const session = await authenticate(daemon, token);

    // The premise, asserted rather than assumed: the UI really does offer the button here, because
    // the list really does report this Project as unusable. A test that skipped this would prove
    // nothing about the button an owner can actually press.
    const before = projectsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(before.projects.map(({ id, repositoryStatus }) => ({ id, repositoryStatus }))).toEqual([
      { id: fixture.projectId, repositoryStatus: "UNUSABLE" },
    ]);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "repair-broken-demo-project",
        fixtureId: "web-app-a",
      }),
    });

    // Not 409. The defect, stated directly.
    expect(response.status).toBe(200);
    const repointed = stateCommandResultSchema.parse(await response.json());
    if (repointed.type !== "PROJECT_REGISTERED") throw new Error("Expected the Project to be repointed");
    const materialisedPath = await realpath(join(demoProjectsRoot, "web-app-a"));
    expect(repointed.project.id).toBe(fixture.projectId);
    expect(repointed.project.repositoryPath).toBe(materialisedPath);

    // And the button is gone, because the condition it renders on is now false: one Project, at a
    // real repository. A repair that leaves the Project reported UNUSABLE is the same defect wearing
    // a 200.
    const after = projectsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(
      after.projects.map(({ id, repositoryPath, repositoryStatus }) => ({
        id,
        repositoryPath,
        repositoryStatus,
      })),
    ).toEqual([{ id: fixture.projectId, repositoryPath: materialisedPath, repositoryStatus: "READY" }]);
    expect((await inspectRepository(materialisedPath))?.topLevel).toBe(materialisedPath);
  }, 30_000);

  // The guarantee widening the repoint must not touch: a Project the owner registered BY PATH is
  // never moved, however unusable its path has become. Loomrail does not know where they moved their
  // repository to, so "repairing" it would either do nothing or point their Project somewhere they
  // did not choose -- they register the new path themselves.
  //
  // Seeded with the fixture's own id and a null `fixtureId`, which is the only way to put such a
  // Project in front of this branch at all: the id is what the route looks the row up by, and
  // `fixtureId` is the fence. Without that fence the route would compute a repoint for a row it has
  // no business moving, and the refusal would come back as PROJECT_REPOINT_REFUSED from inside the
  // write transaction -- a different answer, from a check that exists as the second line of defence
  // rather than the first.
  it("never repoints a Project that was not registered from the bundled fixture", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail own project unusable "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const fixture = await resolveBundledFixture("web-app-a");
    const ownPath = join(temporaryDirectory, "the-owners-own-checkout");
    await mkdir(ownPath, { recursive: true });

    const seedState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      seedState.execute({
        schemaVersion: 1,
        commandId: "register-owners-own-project",
        correlationId: "correlation-register-owners-own",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: fixture.projectId,
          fixtureId: null,
          name: "The owner's own repository",
          repositoryPath: ownPath,
        },
      });
    } finally {
      seedState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath,
      demoProjectsRoot,
    });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "repair-owners-own-project",
        fixtureId: "web-app-a",
      }),
    });

    expect(response.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe("PROJECT_ALREADY_REGISTERED");
    // The row is exactly where the owner left it.
    const projects = projectsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(projects.projects.map(({ id, repositoryPath }) => ({ id, repositoryPath }))).toEqual([
      { id: fixture.projectId, repositoryPath: ownPath },
    ]);
  }, 30_000);

  // The project list is what the web client fetches to render the app's main screen. Adding a
  // per-Project repository probe to it turned a pure database read into one that spawns `git`, and
  // `runGit` REJECTS with `GitMissingError` when `git` cannot be spawned at all -- uncaught by
  // `inspectRepository`, unhandled by `sendOperationError`. On a machine with no `git` on PATH the
  // route therefore answered a generic 500 and the owner could not list ANY of their Projects,
  // because of a question about one of them.
  //
  // PATH is emptied around the one fetch and restored in a `finally`: the same ENOENT on the child
  // that a machine without the executable produces, without breaking `git` for anything else.
  it("lists Projects on a machine where git cannot be spawned, reporting them as unusable", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail projects without git "));
    temporaryDirectories.push(temporaryDirectory);
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false, demoProjectsRoot });
    const session = await authenticate(daemon, token);
    const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-demo-before-git-goes-missing",
        fixtureId: "web-app-a",
      }),
    });
    expect(registration.status).toBe(200);

    const realPath = process.env["PATH"];
    let response: Response;
    try {
      process.env["PATH"] = "";
      response = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
        headers: { cookie: session.cookie },
      });
    } finally {
      process.env["PATH"] = realPath;
    }

    // The whole of it: an answer, not a 500. Asserted before the body is parsed, so a regression
    // reads as "the route failed" rather than as a schema error about an error envelope.
    expect(response.status).toBe(200);
    const listed = projectsResponseSchema.parse(await response.json());
    // The Project is still listed -- the owner can see their work -- and it is reported as what it
    // is right now: nothing can be cut from it while this machine cannot run `git`.
    expect(listed.projects.map(({ id, repositoryStatus }) => ({ id, repositoryStatus }))).toEqual([
      { id: "project-fixture-web-app-a", repositoryStatus: "UNUSABLE" },
    ]);
  }, 30_000);

  // A second daemon process, its own data directory, pointed at the same state database -- what two
  // daemons on one machine's shared state look like, and the shape the refused registration used to
  // get wrong: it does not share the first daemon's demo root, so nothing there names the same
  // fixture already registered, and the fixture used to be materialised under the second daemon's own
  // data directory before the id collision was even checked. That repository was never recorded --
  // the Project row still names the first daemon's path -- so it sat on disk as a fully built,
  // completely orphaned repository forever. The repoint repair (commit 8a76b4b) removed this same
  // symptom from the other branch of this route by reading before writing; this proves the fresh-
  // registration branch now does the same.
  it("does not materialise a repository for a fixture registration a second daemon cannot land", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail demo second daemon "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "shared.sqlite");
    const firstDemoRoot = join(temporaryDirectory, "first-demo-projects");
    const firstToken = bootstrapToken();
    const first = await startDaemon({
      bootstrapToken: firstToken,
      logger: false,
      stateDatabasePath,
      demoProjectsRoot: firstDemoRoot,
    });
    daemon = first;
    const firstSession = await authenticate(first, firstToken);
    const firstRegistration = await fetch(`${first.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(first, firstSession),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-first-daemon", fixtureId: "web-app-a" }),
    });
    expect(firstRegistration.status).toBe(200);
    // Closed before the second daemon opens the same database file, as every other pairing in this
    // suite does: the two never touch it at once.
    await daemon.close();
    daemon = undefined;

    const secondDemoRoot = join(temporaryDirectory, "second-demo-projects");
    const secondToken = bootstrapToken();
    const second = await startDaemon({
      bootstrapToken: secondToken,
      logger: false,
      stateDatabasePath,
      demoProjectsRoot: secondDemoRoot,
    });
    daemon = second;
    const secondSession = await authenticate(second, secondToken);
    const secondRegistration = await fetch(`${second.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(second, secondSession),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-second-daemon", fixtureId: "web-app-a" }),
    });

    expect(secondRegistration.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await secondRegistration.json()).error.code).toBe(
      "PROJECT_ALREADY_REGISTERED",
    );
    // Nothing was built under the second daemon's own data directory on the way to that refusal.
    await expect(access(join(secondDemoRoot, "web-app-a"))).rejects.toThrow();
  }, 30_000);

  // Typing `.` into the Settings field used to answer 200 and register the directory the daemon was
  // started from -- a path the owner never chose, and not the same one on the next start.
  it("refuses a relative repository path, saying that is what is wrong with it", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-relative-path",
        repositoryPath: ".",
      }),
    });

    expect(response.status).toBe(400);
    const failure = apiErrorResponseSchema.parse(await response.json());
    expect(failure.error.code).toBe("REPOSITORY_PATH_NOT_ABSOLUTE");
    // The owner has to be told which of the possible problems this is: `.` is a perfectly good
    // directory, and a "this is not a Git repository" answer would send them after the wrong thing.
    expect(failure.error.message).toContain("must be absolute");
    // Nothing was registered on the way to the refusal.
    const projects = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    expect(projectsResponseSchema.parse(await projects.json()).projects).toEqual([]);
  });

  it("refuses to register a Project at a path that is not a Git repository, naming the path", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail demo not a repo "));
    temporaryDirectories.push(temporaryDirectory);
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    // A directory already sitting where the fixture materialises, holding something that is not a
    // repository. Materialisation leaves it alone (that is what makes it idempotent), so this is
    // the registration reaching a path that is not a Git repository -- the same answer an owner
    // registering their own directory by path gets.
    const occupied = join(demoProjectsRoot, "web-app-a");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "notes.txt"), "not a repository\n", "utf8");
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false, demoProjectsRoot });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-not-a-repo", fixtureId: "web-app-a" }),
    });

    expect(response.status).toBe(400);
    const failure = apiErrorResponseSchema.parse(await response.json());
    expect(failure.error.code).toBe("REPOSITORY_PATH_NOT_A_REPOSITORY");
    // Named as the owner would see its physical location on disk. Windows may spell `tmpdir()` with
    // an 8.3 alias such as RUNNER~1 even though `realpath` and Git report the ordinary long path;
    // fixture materialisation intentionally records that canonical form on every platform.
    expect(failure.error.message).toContain(await realpath(occupied));
    // Nothing was registered on the way to the refusal.
    const projects = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    expect(await projects.json()).toMatchObject({ projects: [] });
  });

  it("registers the owner's own repository by path, under its directory's name and with no fixture", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail own repo "));
    temporaryDirectories.push(temporaryDirectory);
    // The directory name is the Project's name, so it is chosen here to be one no other part of
    // this suite could have produced.
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "acme-invoicing"));
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-own-repository",
        repositoryPath,
      }),
    });

    expect(response.status).toBe(200);
    const registered = stateCommandResultSchema.parse(await response.json());
    if (registered.type !== "PROJECT_REGISTERED") throw new Error("Expected the Project to register");
    // Null rather than absent: this Project has no bundled fixture behind it, and the schema records
    // that instead of leaving the field out (migration 0012, projectSchema.fixtureId).
    expect(registered.project.fixtureId).toBeNull();
    expect(registered.project.name).toBe("acme-invoicing");
    expect(await realpath(registered.project.repositoryPath)).toBe(await realpath(repositoryPath));

    // And it is a Project like any other from the list the workbench reads.
    const listed = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await listed.json());
    expect(projects.projects).toMatchObject([{ fixtureId: null, name: "acme-invoicing" }]);
  });

  it("refuses to register a Project at a directory inside another repository", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail nested path "));
    temporaryDirectories.push(temporaryDirectory);
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "enclosing"));
    // The shape of the mistake this guard exists for: the owner points Loomrail at a subdirectory of
    // a repository -- a package, a module, the `src` they happen to be looking at. Cutting a
    // workspace there would branch the enclosing repository, which for a Loomrail developer is
    // Loomrail's own checkout. Registering by path must not be the way around that.
    const inside = join(repositoryPath, "packages", "billing");
    await mkdir(inside, { recursive: true });
    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-inside-repo", repositoryPath: inside }),
    });

    expect(response.status).toBe(400);
    const failure = apiErrorResponseSchema.parse(await response.json());
    expect(failure.error.code).toBe("REPOSITORY_PATH_INSIDE_REPOSITORY");
    // The honest message, not the generic one: it names which repository the path is inside, which
    // is the only thing that tells the owner what to register instead.
    expect(failure.error.message).toContain(await realpath(repositoryPath));

    // Nothing was registered on the way to the refusal.
    const listed = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    expect(await listed.json()).toMatchObject({ projects: [] });
  });

  it("keeps a materialised fixture and the work already done in it when the demo is initialised again", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail demo twice "));
    temporaryDirectories.push(temporaryDirectory);
    const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
    const firstToken = bootstrapToken();
    const first = await startDaemon({
      bootstrapToken: firstToken,
      logger: false,
      demoProjectsRoot,
      stateDatabasePath: join(temporaryDirectory, "first.sqlite"),
    });
    daemon = first;
    const firstSession = await authenticate(first, firstToken);
    const firstRegistration = await fetch(`${first.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(first, firstSession),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-first", fixtureId: "web-app-a" }),
    });
    expect(firstRegistration.status).toBe(200);
    const materialised = join(demoProjectsRoot, "web-app-a");
    const firstCommit = (await inspectRepository(materialised))?.headCommit;
    // Work in the demo repository, of the kind that only ever exists there: uncommitted.
    await writeFile(join(materialised, "owners-note.txt"), "work in progress\n", "utf8");
    await daemon.close();
    daemon = undefined;

    // A second initialisation: a fresh database (so nothing is remembered) pointed at the same demo
    // root, which is what "someone pressed the button again" looks like from the materialiser.
    const secondToken = bootstrapToken();
    const second = await startDaemon({
      bootstrapToken: secondToken,
      logger: false,
      demoProjectsRoot,
      stateDatabasePath: join(temporaryDirectory, "second.sqlite"),
    });
    daemon = second;
    const secondSession = await authenticate(second, secondToken);
    const secondRegistration = await fetch(`${second.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(second, secondSession),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-second", fixtureId: "web-app-a" }),
    });

    expect(secondRegistration.status).toBe(200);
    expect((await inspectRepository(materialised))?.headCommit).toBe(firstCommit);
    expect(await readFile(join(materialised, "owners-note.txt"), "utf8")).toBe("work in progress\n");
  });

  it("registers one Project when the same fixture is registered twice", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail demo double click "));
    temporaryDirectories.push(temporaryDirectory);
    const token = bootstrapToken();
    const started = await startDaemon({
      bootstrapToken: token,
      logger: false,
      demoProjectsRoot: join(temporaryDirectory, "demo-projects"),
    });
    daemon = started;
    const session = await authenticate(started, token);
    const register = (commandId: string) =>
      fetch(`${started.baseUrl}/api/v1/projects/fixtures/register`, {
        method: "POST",
        headers: mutationHeaders(started, session),
        body: JSON.stringify({ schemaVersion: 1, commandId, fixtureId: "web-app-a" }),
      });

    expect((await register("register-click-one")).status).toBe(200);
    // The same command id: the idempotency receipt has to replay it. It only can if the command
    // this registration builds is byte-for-byte the one already recorded -- which it stops being
    // the moment the materialised path is spelled one way when the repository is created and
    // another way when it is adopted, and the owner gets a conflict for pressing the button twice.
    expect((await register("register-click-one")).status).toBe(200);
    // A different command id: not the receipt replaying, a genuine second registration.
    expect((await register("register-click-two")).status).toBe(409);

    const listed = await fetch(`${started.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } });
    const projects = projectsResponseSchema.parse(await listed.json());
    expect(projects.projects).toHaveLength(1);
  });

  it("persists Project, WorkItem, idempotency receipt and Events across daemon restart", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon state "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const firstToken = bootstrapToken();
    const firstDaemon = await startDaemon({ bootstrapToken: firstToken, logger: false, stateDatabasePath });
    daemon = firstDaemon;
    expect((await fetch(`${firstDaemon.baseUrl}/api/v1/attention`)).status).toBe(401);
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
    // This run goes all the way to IMPLEMENT's budget wall, which cuts a worktree, so its Project
    // has to name a real repository. Registration is what provides one: it materialises the bundled
    // fixture outside this checkout and `createReadyWorkItem` asserts as much.
    const workItemId = await createReadyWorkItem(firstDaemon, firstSession, "workflow-item");
    const startResponse = await fetch(
      `${firstDaemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`,
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
    expect(startResponse.status).toBe(200);
    // The handler answers as of immediately after its own command now (spec D6), before the
    // background worker has necessarily run a single pass -- wait for it to drain, then re-read.
    await firstDaemon.whenIdle();
    const waiting = await fetchWorkflowSnapshot(firstDaemon, firstSession.cookie, workItemId);
    expect(waiting).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      humanRequests: [{ status: "OPEN", kind: "SINGLE_CHOICE", blocking: true }],
    });
    const request = waiting.humanRequests[0];
    if (!request) throw new Error("Expected an open HumanRequest");
    const firstAttention = attentionInboxResponseSchema.parse(
      await (
        await fetch(`${firstDaemon.baseUrl}/api/v1/attention`, {
          headers: { cookie: firstSession.cookie },
        })
      ).json(),
    );
    expect(firstAttention).toMatchObject({
      items: [
        {
          id: request.id,
          workItem: { id: workItemId },
          section: "BLOCKING_NOW",
          category: "QUESTION",
          action: "ANSWER_REQUEST",
        },
      ],
      hasMore: false,
    });

    await firstDaemon.close();
    daemon = undefined;
    const secondToken = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: secondToken, logger: false, stateDatabasePath });
    const secondSession = await authenticate(daemon, secondToken);
    const restoredResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/workflow`, {
      headers: { cookie: secondSession.cookie },
    });
    const restored = workflowSnapshotSchema.parse(await restoredResponse.json());
    expect(restored.humanRequests[0]).toMatchObject({ id: request.id, status: "OPEN", version: 1 });
    expect(
      attentionInboxResponseSchema.parse(
        await (
          await fetch(`${daemon.baseUrl}/api/v1/attention`, {
            headers: { cookie: secondSession.cookie },
          })
        ).json(),
      ),
    ).toMatchObject({ items: [{ id: request.id }], hasMore: false });

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
    expect(answerResponse.status).toBe(200);
    await daemon.whenIdle();
    const hardPaused = await fetchWorkflowSnapshot(daemon, secondSession.cookie, workItemId);
    expect(hardPaused.run?.status).toBe("HARD_PAUSED");
    expect(hardPaused.stageAttempts.map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "DISCOVERY", status: "SUCCEEDED" },
      { stage: "PLAN", status: "SUCCEEDED" },
      { stage: "IMPLEMENT", status: "HARD_PAUSED" },
    ]);
    expect(hardPaused.usageRecords.map(({ amount }) => amount)).toEqual([50, 30, 15, 5]);
    expect(hardPaused.humanRequests[0]).toMatchObject({ status: "RESOLVED", version: 2 });
    expect(hardPaused.decisions).toHaveLength(1);
    expect(
      attentionInboxResponseSchema.parse(
        await (
          await fetch(`${daemon.baseUrl}/api/v1/attention`, {
            headers: { cookie: secondSession.cookie },
          })
        ).json(),
      ),
    ).toMatchObject({ items: [], hasMore: false });

    const overrideResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/budget-override`,
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
    expect(overrideResponse.status).toBe(200);
    await daemon.whenIdle();
    const awaitingAcceptance = await fetchWorkflowSnapshot(daemon, secondSession.cookie, workItemId);
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
    expect(
      attentionInboxResponseSchema.parse(
        await (
          await fetch(`${daemon.baseUrl}/api/v1/attention`, {
            headers: { cookie: secondSession.cookie },
          })
        ).json(),
      ),
    ).toMatchObject({
      items: [
        {
          workItem: { id: workItemId },
          section: "BLOCKING_NOW",
          category: "APPROVAL",
          action: "REVIEW_ACCEPTANCE",
          acceptancePackageId: acceptancePackage.id,
        },
      ],
      hasMore: false,
    });
    const acceptanceResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${workItemId}/acceptance/${acceptancePackage.id}/resolve`,
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
    const acceptedWorkItemResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}`, {
      headers: { cookie: secondSession.cookie },
    });
    expect(await acceptedWorkItemResponse.json()).toMatchObject({ workItem: { state: "DONE" } });
    expect(
      attentionInboxResponseSchema.parse(
        await (
          await fetch(`${daemon.baseUrl}/api/v1/attention`, {
            headers: { cookie: secondSession.cookie },
          })
        ).json(),
      ),
    ).toMatchObject({ items: [], hasMore: false });

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
    // This run reaches IMPLEMENT, which cuts a real worktree: a couple of dozen `git` subprocesses
    // on top of two daemons, which outlives vitest's 5s default under a loaded `pnpm test`.
  }, 30_000);

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
        type: "REGISTER_PROJECT",
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
              { stage: "DISCOVERY", ordinal: 0, contextPack: legacyContextPack },
              { stage: "PLAN", ordinal: 1, contextPack: legacyContextPack },
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
          resultTree: null,
          dispatchId: started.dispatch.id,
          template: {
            schemaVersion: 1,
            id: "mock-delivery-v1",
            version: 1,
            name: "Mock delivery",
            stages: [
              { stage: "DISCOVERY", ordinal: 0, contextPack: legacyContextPack },
              { stage: "PLAN", ordinal: 1, contextPack: legacyContextPack },
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
    await daemon.whenIdle();
    const started = await fetchWorkflowSnapshot(daemon, session.cookie, created.workItem.id);
    expect(started).toMatchObject({
      run: { workflowVersion: mockDeliveryTemplate.version, status: "WAITING_HUMAN" },
    });
  });

  // Task 10 gave startup reconciliation the ability to move a READY workspace to ORPHANED when its
  // worktree is gone. Nothing said so anywhere: the daemon threw the reconciliation result away and
  // never wired the callback, so the one decision Loomrail makes about the owner's disk without
  // being asked was invisible -- and it is the reason their next stage stops with a question.
  it("says in the log when startup reconciliation orphans a workspace", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon orphan log "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "repo"));
    const worktreePath = join(temporaryDirectory, "workspaces", "gone");
    let workspaceId = "";
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-orphan-log-project",
        correlationId: "correlation-register-orphan-log",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: "project-orphan-log",
          fixtureId: "web-app-a",
          name: "Orphan log fixture",
          repositoryPath,
        },
      });
      const created = localState.execute({
        schemaVersion: 1,
        commandId: "create-orphan-log-task",
        correlationId: "correlation-create-orphan-log",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-orphan-log",
          parentId: null,
          type: "TASK",
          title: "A work item whose workspace went away",
          description: "Synthetic orphaned-workspace fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: [],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      // Recorded as READY at a path that was never cut -- which is what the owner's disk looks like
      // after a worktree is deleted while Loomrail is not running.
      const workspace = localState.execute({
        schemaVersion: 1,
        commandId: "record-orphan-log-workspace",
        correlationId: "correlation-record-orphan-log",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          workItemId: created.workItem.id,
          projectId: "project-orphan-log",
          branch: "loomrail/orphan-log",
          worktreePath,
          baseCommit: null,
          snapshotCommit: null,
          carriedPaths: [],
        },
      });
      if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected a workspace");
      workspaceId = workspace.workspace.id;
    } finally {
      localState.close();
    }

    const logLines: string[] = [];
    daemon = await startDaemon({
      bootstrapToken: bootstrapToken(),
      stateDatabasePath,
      loggerStream: {
        write: (line) => {
          logLines.push(line);
        },
      },
    });

    const logs = logLines.join("");
    expect(logs).toContain("Marked a work item's workspace orphaned");
    expect(logs).toContain(workspaceId);
    expect(logs).toContain("MISSING_FROM_WORKTREE_LIST");
  });

  // The other half of the same wiring, and the half nothing pinned: reconciliation reports a check
  // it COULD NOT RUN as loudly as one that found something, and for a better reason -- a workspace
  // that should have been orphaned and was not is invisible otherwise. FAIL SAFE is the behaviour
  // under test as much as the log line is: an inconclusive check must never orphan a workspace that
  // may be perfectly healthy, so the ORPHANED message must be absent here.
  it("says in the log when startup reconciliation could not check a workspace at all", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon skip log "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "repo"));
    const worktreePath = join(temporaryDirectory, "workspaces", "unknown");
    let workspaceId = "";
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-skip-log-project",
        correlationId: "correlation-register-skip-log",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: "project-skip-log",
          fixtureId: "web-app-a",
          name: "Skip log fixture",
          repositoryPath,
        },
      });
      const created = localState.execute({
        schemaVersion: 1,
        commandId: "create-skip-log-task",
        correlationId: "correlation-create-skip-log",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-skip-log",
          parentId: null,
          type: "TASK",
          title: "A work item whose workspace cannot be checked",
          description: "Synthetic unreachable-repository fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: [],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      const workspace = localState.execute({
        schemaVersion: 1,
        commandId: "record-skip-log-workspace",
        correlationId: "correlation-record-skip-log",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          workItemId: created.workItem.id,
          projectId: "project-skip-log",
          branch: "loomrail/skip-log",
          worktreePath,
          baseCommit: null,
          snapshotCommit: null,
          carriedPaths: [],
        },
      });
      if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected a workspace");
      workspaceId = workspace.workspace.id;
    } finally {
      localState.close();
    }
    // Removed only after the row is recorded, and before the daemon opens the database: with no
    // repository to run `git worktree list` in, the check cannot reach an answer either way -- which
    // is exactly the "a missing git, a repository path that no longer resolves" case the reconciler
    // contains rather than throws.
    await rm(repositoryPath, { recursive: true, force: true });

    const logLines: string[] = [];
    daemon = await startDaemon({
      bootstrapToken: bootstrapToken(),
      stateDatabasePath,
      loggerStream: {
        write: (line) => {
          logLines.push(line);
        },
      },
    });

    const logs = logLines.join("");
    expect(logs).toContain("Could not check a work item's workspace");
    expect(logs).toContain(workspaceId);
    expect(logs).toContain("WORKTREE_LIST_FAILED");
    expect(logs).not.toContain("Marked a work item's workspace orphaned");
  });

  // Task 11 passed a workspace's branch and baseCommit into the provider adapter and nothing ever
  // read them back out; the owner could not see where their agent had written at all. This route is
  // what makes those fields reachable, and the card that reads it is the reason it exists.
  it("answers with the workspace a work item writes in, and with null for one that has none", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon workspace route "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "repo"));
    const worktreePath = join(temporaryDirectory, "workspaces", "задача с пробелом");
    const baseCommit = "a".repeat(40);
    let withWorkspaceId = "";
    let withoutWorkspaceId = "";
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-workspace-route-project",
        correlationId: "correlation-register-workspace-route",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: "project-workspace-route",
          fixtureId: "web-app-a",
          name: "Workspace route fixture",
          repositoryPath,
        },
      });
      const createTask = (slug: string, title: string): string => {
        const created = localState.execute({
          schemaVersion: 1,
          commandId: `create-${slug}`,
          correlationId: `correlation-create-${slug}`,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CREATE_WORK_ITEM",
          payload: {
            projectId: "project-workspace-route",
            parentId: null,
            type: "TASK",
            title,
            description: "Synthetic workspace-route fixture",
            priority: "MEDIUM",
            risk: "LOW",
            acceptanceCriteria: [],
          },
        });
        if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
        return created.workItem.id;
      };
      withWorkspaceId = createTask("with-workspace", "A work item with a workspace");
      withoutWorkspaceId = createTask("without-workspace", "A work item with no workspace");
      const workspace = localState.execute({
        schemaVersion: 1,
        commandId: "record-workspace-route-workspace",
        correlationId: "correlation-record-workspace-route",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          workItemId: withWorkspaceId,
          projectId: "project-workspace-route",
          branch: "loomrail/route-fixture",
          worktreePath,
          baseCommit,
          snapshotCommit: null,
          carriedPaths: [],
        },
      });
      if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected a workspace");
    } finally {
      localState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, stateDatabasePath, logger: false });
    const session = await authenticate(daemon, token);

    const present = await fetch(`${daemon.baseUrl}/api/v1/work-items/${withWorkspaceId}/workspace`, {
      headers: { cookie: session.cookie },
    });
    expect(present.status).toBe(200);
    const raw: unknown = await present.json();
    // Asserted on the wire, before the schema gets a chance to strip anything. The stored workspace
    // carries all six of these -- `leaseHolder` is how two StageAttempts are kept out of one
    // worktree, `id`/`projectId`/`workItemId` are identity the caller already holds, `createdAt` and
    // `version` back commands only the session loop issues -- and this response deliberately carries
    // none of them: nothing here reads them, and a field on a response with no consumer is a defect
    // rather than a convenience (workspace.ts, `publishedWorkItemWorkspaceSchema`).
    const wireWorkspace = (raw as { workspace: Record<string, unknown> }).workspace;
    for (const field of ["leaseHolder", "id", "projectId", "workItemId", "createdAt", "version"]) {
      expect(wireWorkspace).not.toHaveProperty(field);
    }
    const body = workItemWorkspaceResponseSchema.parse(raw);
    // Every field the card renders, named individually: a response that merely parsed would also
    // have passed with the branch or the path silently absent, and those are the two values the
    // owner acts on.
    expect(body.workspace?.branch).toBe("loomrail/route-fixture");
    expect(body.workspace?.worktreePath).toBe(worktreePath);
    expect(body.workspace?.baseCommit).toBe(baseCommit);
    // Reconciliation ran at startup and found no worktree at that path, so this is the state the
    // owner is genuinely in -- reported as it is, not smoothed over.
    expect(body.workspace?.status).toBe("ORPHANED");

    // A work item that has never needed a repository is not an error and not a 404: it is the
    // ordinary state of every prose-only stage, and the card has to be able to tell the two apart.
    const absent = await fetch(`${daemon.baseUrl}/api/v1/work-items/${withoutWorkspaceId}/workspace`, {
      headers: { cookie: session.cookie },
    });
    expect(absent.status).toBe(200);
    expect(workItemWorkspaceResponseSchema.parse(await absent.json()).workspace).toBeNull();

    const unknown = await fetch(`${daemon.baseUrl}/api/v1/work-items/work-item-nowhere/workspace`, {
      headers: { cookie: session.cookie },
    });
    expect(unknown.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await unknown.json()).error.code).toBe("WORK_ITEM_NOT_FOUND");

    // The same session boundary as the rest of /api/v1: an unauthenticated read of where an agent
    // is writing on this machine is exactly what the session exists to refuse.
    const anonymous = await fetch(`${daemon.baseUrl}/api/v1/work-items/${withWorkspaceId}/workspace`);
    expect(anonymous.status).toBe(401);
  });

  it("marks an orphaned running attempt interrupted before serving startup traffic", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon recovery "));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const recoveryRepositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "repo"));
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "register-recovery-project",
        correlationId: "correlation-register-recovery",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: "project-recovery",
          fixtureId: "web-app-a",
          name: "Recovery fixture",
          // A real repository, not the bare temporary directory: the resumed run reaches IMPLEMENT,
          // and that stage's workspace can only be cut from a repository's own top level.
          repositoryPath: recoveryRepositoryPath,
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
    expect(resumeResponse.status).toBe(200);
    await daemon.whenIdle();
    const resumed = await fetchWorkflowSnapshot(daemon, session.cookie, listed.workItems[0]?.id ?? "missing");
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
    // Same reason as the restart test above: the resumed run reaches IMPLEMENT and cuts a worktree.
  }, 30_000);

  // E1.5's two GET handles (spec §5). Every fixture below is a real repository with a real
  // worktree cut from it, because the whole milestone is about whether what git reports matches
  // what the owner is shown -- an invented fixture could only ever confirm what it was built to
  // assert.
  //
  // The owner's uncommitted work is carried into the worktree in every one of them, exactly the
  // way `provisionWorkspace` does it: that is the state in which a summary computed from the wrong
  // commit looks entirely plausible and is a lie.
  type ChangesFixture = {
    session: AuthenticatedSession;
    workItemId: string;
    workItemWithoutWorkspaceId: string;
    worktreePath: string;
    baseCommit: string;
    snapshotCommit: string;
  };

  const startDaemonWithChangedWorkspace = async (
    slug: string,
    options: { recordedBase?: "REAL" | "UNRESOLVABLE" | "NONE" | "SNAPSHOTLESS" } = {},
  ): Promise<ChangesFixture> => {
    const recordedBase = options.recordedBase ?? "REAL";
    const temporaryDirectory = await mkdtemp(join(tmpdir(), `loomrail daemon changes ${slug} `));
    temporaryDirectories.push(temporaryDirectory);
    const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
    const repositoryPath = await makeThrowawayRepo(join(temporaryDirectory, "repo"));

    // The owner is mid-edit when the stage starts: one file they never committed.
    await writeFile(join(repositoryPath, "owner-was-editing.txt"), "the owner's own draft\n");
    const inspected = await inspectRepository(repositoryPath);
    if (inspected === null) throw new Error("Expected the fixture path to be a repository");
    if (inspected.headCommit === null) throw new Error("Expected the fixture repository to have a HEAD");
    const snapshot = await createCarryInSnapshot({
      topLevel: inspected.topLevel,
      headCommit: inspected.headCommit,
      message: `Loomrail carry-in for ${slug}`,
    });
    if (snapshot === null) throw new Error("Expected the owner's uncommitted work to be carried in");

    const worktreePath = join(temporaryDirectory, "workspaces", slug);
    await mkdir(dirname(worktreePath), { recursive: true });
    const added = await addWorktree({
      topLevel: inspected.topLevel,
      branch: `loomrail/${slug}`,
      path: worktreePath,
      startPoint: snapshot.commit,
    });
    if (added.type !== "ADDED") throw new Error("Expected a worktree");
    // The carry-in landed, so the owner's draft is on disk in the worktree. Asserted rather than
    // assumed: every "the owner's work is not reported" check below is a negative, and a negative
    // over a file that was never carried in would pass while proving nothing.
    expect(await readFile(join(worktreePath, "owner-was-editing.txt"), "utf8")).toBe(
      "the owner's own draft\n",
    );

    // What the agent then did in it.
    await writeFile(join(worktreePath, "agent-made-this.txt"), "written by the stage\n");
    await writeFile(join(worktreePath, "committed.txt"), "committed\nagent line\n");

    let workItemId = "";
    let workItemWithoutWorkspaceId = "";
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: `register-${slug}`,
        correlationId: `correlation-register-${slug}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: { id: `project-${slug}`, fixtureId: "web-app-a", name: `Changes ${slug}`, repositoryPath },
      });
      const createTask = (suffix: string, title: string): string => {
        const created = localState.execute({
          schemaVersion: 1,
          commandId: `create-${slug}-${suffix}`,
          correlationId: `correlation-create-${slug}-${suffix}`,
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CREATE_WORK_ITEM",
          payload: {
            projectId: `project-${slug}`,
            parentId: null,
            type: "TASK",
            title,
            description: "Synthetic change-visibility fixture",
            priority: "MEDIUM",
            risk: "LOW",
            acceptanceCriteria: [],
          },
        });
        if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
        return created.workItem.id;
      };
      workItemId = createTask("with", "A work item whose stage changed files");
      workItemWithoutWorkspaceId = createTask("without", "A work item that never needed a repository");
      const workspace = localState.execute({
        schemaVersion: 1,
        commandId: `record-workspace-${slug}`,
        correlationId: `correlation-record-workspace-${slug}`,
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          workItemId,
          projectId: `project-${slug}`,
          branch: `loomrail/${slug}`,
          worktreePath,
          // "a" * 40 is a well-formed object id that resolves to nothing -- a base whose history
          // was rewritten under the workspace, which spec §7 requires be refused by name rather
          // than answered from whatever git falls back to.
          baseCommit: recordedBase === "NONE" ? null : inspected.headCommit,
          // "SNAPSHOTLESS" is the other arm of spec D1: a workspace cut from a repository with
          // nothing uncommitted to carry in records no snapshot at all, and the base is then the
          // repository's HEAD. Every other fixture here records a snapshot, which left that arm
          // unexecuted by the whole suite.
          snapshotCommit:
            recordedBase === "NONE" || recordedBase === "SNAPSHOTLESS"
              ? null
              : recordedBase === "UNRESOLVABLE"
                ? "a".repeat(40)
                : snapshot.commit,
          carriedPaths: snapshot.carriedPaths.slice(),
        },
      });
      if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected a workspace");
    } finally {
      localState.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({ bootstrapToken: token, stateDatabasePath, logger: false });
    return {
      session: await authenticate(daemon, token),
      workItemId,
      workItemWithoutWorkspaceId,
      worktreePath,
      baseCommit: inspected.headCommit,
      snapshotCommit: snapshot.commit,
    };
  };

  const changesUrl = (running: RunningDaemon, workItemId: string): string =>
    `${running.baseUrl}/api/v1/work-items/${workItemId}/changes`;
  const diffUrl = (running: RunningDaemon, workItemId: string, path: string): string =>
    `${changesUrl(running, workItemId)}/diff?path=${encodeURIComponent(path)}`;

  // Spec D1, and acceptance criterion 3. The most valuable test of the four handles' behaviours,
  // because the defect it names does not look like one: computing from `baseCommit` answers 200
  // with a full, well-formed file list in which the owner's own half-finished work is presented as
  // something the agent did.
  it("does not report the owner's carried-in work as something the task changed", async () => {
    const fixture = await startDaemonWithChangedWorkspace("carry-in");
    if (!daemon) throw new Error("Expected a daemon");

    const response = await fetch(changesUrl(daemon, fixture.workItemId), {
      headers: { cookie: fixture.session.cookie },
    });

    expect(response.status).toBe(200);
    const body = workItemChangesResponseSchema.parse(await response.json());
    const paths = (body.changes?.files ?? []).map((file) => file.path);
    // The positives come first and are not decoration: without them the negative below passes on
    // any answer at all, including an empty list from a read that never happened.
    expect(paths).toContain("agent-made-this.txt");
    expect(paths).toContain("committed.txt");
    expect(paths).not.toContain("owner-was-editing.txt");
    expect(body.changes?.baseline).toBe(fixture.snapshotCommit);
    expect(body.changes?.files.find((file) => file.path === "agent-made-this.txt")).toMatchObject({
      status: "ADDED",
      insertions: 1,
      deletions: 0,
      binary: false,
    });
    expect(body.changes?.truncated).toBe(false);
  });

  it("hands back one file's diff, and refuses every path that does not name one file inside the workspace", async () => {
    const fixture = await startDaemonWithChangedWorkspace("diff");
    if (!daemon) throw new Error("Expected a daemon");
    const running = daemon;
    const cookie = { cookie: fixture.session.cookie };
    // A symlink that points at itself: spec §7's "петля симлинков", one of the three filesystem
    // conditions that used to leave the boundary as three different internal errors.
    await symlink("loop", join(fixture.worktreePath, "loop"));

    const body = await fetch(diffUrl(running, fixture.workItemId, "committed.txt"), { headers: cookie });
    expect(body.status).toBe(200);
    const diff = workItemFileDiffResponseSchema.parse(await body.json()).diff;
    expect(diff?.path).toBe("committed.txt");
    expect(diff?.baseline).toBe(fixture.snapshotCommit);
    expect(diff?.binary).toBe(false);
    expect(diff?.patch).toContain("+agent line");
    expect(diff?.truncated).toBe(false);
    expect(diff?.omittedBytes).toBe(0);

    // Each refusal names the path the client sent, and each is told apart from the others by its
    // code: an owner whose client sent a typo must not be shown the same answer as one whose
    // client tried to read outside the workspace.
    const refusals: readonly { path: string; code: string }[] = [
      { path: "../../etc/passwd", code: "PATH_OUTSIDE_WORKSPACE" },
      { path: "no-such-file.txt", code: "PATH_NOT_A_FILE" },
      // A directory is not a file, and answering for it would answer for the files inside it.
      { path: ".", code: "PATH_OUTSIDE_WORKSPACE" },
      { path: "loop", code: "PATH_UNRESOLVABLE" },
      // Pathspec magic, which is not a path: `:/` answered with every changed file's diff before
      // the last fix round, and `path=":"` had the whole repository's diff in memory. This handle
      // passes the client's string to the reading that defends against both, and adds no check of
      // its own that could drift from it.
      { path: ":/", code: "PATH_NOT_A_FILE" },
      { path: ":(top)committed.txt", code: "PATH_NOT_A_FILE" },
      { path: "*", code: "PATH_NOT_A_FILE" },
    ];
    for (const { path, code } of refusals) {
      const refused = await fetch(diffUrl(running, fixture.workItemId, path), { headers: cookie });
      expect(refused.status, `path ${path}`).toBe(400);
      const error = apiErrorResponseSchema.parse(await refused.json()).error;
      expect(error.code, `path ${path}`).toBe(code);
      expect(error.message, `path ${path}`).toContain(path);
    }

    // A body request with no path at all is a malformed request, not a refusal about a path.
    const missing = await fetch(`${changesUrl(running, fixture.workItemId)}/diff`, { headers: cookie });
    expect(missing.status).toBe(400);
    expect(apiErrorResponseSchema.parse(await missing.json()).error.code).toBe("INVALID_REQUEST");
  });

  // Spec D7 and acceptance criterion 8. Reconciliation revisits a workspace's status at startup
  // and never again, so a directory deleted while the daemon runs leaves a READY row pointing at
  // nothing -- and the wrong answer here is not an error page, it is a cheerful 200 saying the
  // stage changed nothing.
  it("refuses both reads, naming the worktree, when the worktree is gone from disk", async () => {
    const fixture = await startDaemonWithChangedWorkspace("gone");
    if (!daemon) throw new Error("Expected a daemon");
    const running = daemon;
    const cookie = { cookie: fixture.session.cookie };
    await rm(fixture.worktreePath, { recursive: true, force: true });

    const summary = await fetch(changesUrl(running, fixture.workItemId), { headers: cookie });
    const body = await fetch(diffUrl(running, fixture.workItemId, "committed.txt"), { headers: cookie });

    expect(summary.status).toBe(409);
    const summaryError = apiErrorResponseSchema.parse(await summary.json()).error;
    expect(summaryError.code).toBe("WORKSPACE_WORKTREE_MISSING");
    expect(summaryError.message).toContain(fixture.worktreePath);
    // The same fact answered the same way on both handles: one condition, one convention.
    expect(body.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await body.json()).error.code).toBe("WORKSPACE_WORKTREE_MISSING");
  });

  // The one filesystem condition on the WORKSPACE's own side that @loomrail/workspace deliberately
  // leaves unnamed: canonicalising the worktree can throw EACCES, and that is a statement about the
  // workspace rather than about the client's path, so it is refused here -- and told apart from a
  // worktree that is simply gone, because "your directory was deleted" is the wrong thing to tell
  // an owner whose work is still on disk behind a permission change.
  //
  // Skipped on Windows, where a 0-mode directory does not deny entry, and meaningless as root,
  // where nothing does.
  it.skipIf(platform() === "win32")(
    "refuses, without calling it deleted, when the worktree cannot be reached at all",
    async () => {
      const fixture = await startDaemonWithChangedWorkspace("unreadable");
      if (!daemon) throw new Error("Expected a daemon");
      const running = daemon;
      const enclosing = dirname(fixture.worktreePath);
      await chmod(enclosing, 0o000);

      try {
        const response = await fetch(changesUrl(running, fixture.workItemId), {
          headers: { cookie: fixture.session.cookie },
        });

        expect(response.status).toBe(409);
        const error = apiErrorResponseSchema.parse(await response.json()).error;
        expect(error.code).toBe("WORKSPACE_WORKTREE_UNREADABLE");
        expect(error.message).toContain(fixture.worktreePath);
      } finally {
        // Restored before the suite's own cleanup, which cannot delete a directory it may not enter.
        await chmod(enclosing, 0o755);
      }
    },
  );

  // Spec §7's last row. The worktree is there and readable; it is the base that no longer resolves,
  // which is what a rewritten history under a running workspace looks like.
  it("refuses, naming the base, when the base the summary would be computed from does not resolve", async () => {
    const fixture = await startDaemonWithChangedWorkspace("rewritten", { recordedBase: "UNRESOLVABLE" });
    if (!daemon) throw new Error("Expected a daemon");

    const response = await fetch(changesUrl(daemon, fixture.workItemId), {
      headers: { cookie: fixture.session.cookie },
    });

    expect(response.status).toBe(500);
    const error = apiErrorResponseSchema.parse(await response.json()).error;
    expect(error.code).toBe("CHANGES_UNREADABLE");
    expect(error.message).toContain("a".repeat(40));
  });

  // The same condition as the test above, on the directory the check is actually ABOUT. The one
  // above breaks the ENCLOSING directory, which a bare `access` (F_OK) does catch because
  // resolving a name needs traverse permission on the parents -- so it is the configuration in
  // which the defect cannot show. Breaking the worktree itself is the configuration in which it
  // does: measured before the fix, this answered 500 CHANGES_UNREADABLE on the summary and 400
  // PATH_UNRESOLVABLE on the diff -- two different answers, one of them blaming the client's path,
  // for one workspace whose work is intact behind a permission change.
  it.skipIf(platform() === "win32")(
    "refuses both handles the same way when the worktree itself cannot be entered",
    async () => {
      const fixture = await startDaemonWithChangedWorkspace("locked-worktree");
      if (!daemon) throw new Error("Expected a daemon");
      const running = daemon;
      const cookie = { cookie: fixture.session.cookie };
      await chmod(fixture.worktreePath, 0o000);

      try {
        const summary = await fetch(changesUrl(running, fixture.workItemId), { headers: cookie });
        expect(summary.status).toBe(409);
        const summaryError = apiErrorResponseSchema.parse(await summary.json()).error;
        expect(summaryError.code).toBe("WORKSPACE_WORKTREE_UNREADABLE");
        expect(summaryError.message).toContain(fixture.worktreePath);

        const diff = await fetch(diffUrl(running, fixture.workItemId, "committed.txt"), { headers: cookie });
        expect(diff.status).toBe(409);
        expect(apiErrorResponseSchema.parse(await diff.json()).error.code).toBe(
          "WORKSPACE_WORKTREE_UNREADABLE",
        );
      } finally {
        // Restored before the suite's own cleanup, which cannot delete a directory it may not enter.
        await chmod(fixture.worktreePath, 0o755);
      }
    },
  );

  // The other arm of spec D1's `snapshotCommit ?? baseCommit`, and the one no fixture reached: a
  // workspace recorded with no carry-in snapshot is an ordinary, healthy workspace -- it is what a
  // stage started from a clean repository looks like -- and its base is the repository's HEAD.
  // Read from `snapshotCommit` alone it has no base at all, and the owner is told 409
  // WORKSPACE_HAS_NO_BASELINE about a work item with nothing wrong with it.
  it("computes from the recorded base when there was no carry-in snapshot to compute from", async () => {
    const fixture = await startDaemonWithChangedWorkspace("snapshotless", { recordedBase: "SNAPSHOTLESS" });
    if (!daemon) throw new Error("Expected a daemon");
    const running = daemon;
    const cookie = { cookie: fixture.session.cookie };

    const summary = await fetch(changesUrl(running, fixture.workItemId), { headers: cookie });
    expect(summary.status).toBe(200);
    expect(workItemChangesResponseSchema.parse(await summary.json()).changes?.baseline).toBe(
      fixture.baseCommit,
    );

    // Both handles, because they resolve the base through the same helper and a fix applied to one
    // of them would leave the other answering about a different commit.
    const diff = await fetch(diffUrl(running, fixture.workItemId, "committed.txt"), { headers: cookie });
    expect(diff.status).toBe(200);
    expect(workItemFileDiffResponseSchema.parse(await diff.json()).diff?.baseline).toBe(fixture.baseCommit);
  });

  // The row ABOVE that one in spec §7 ("`git` не запустился"), and the reason it needs a code of
  // its own: a machine with no usable git and a baseline that no longer resolves are different
  // problems with different fixes, and answering both with CHANGES_UNREADABLE named this owner's
  // worktree and base at them when both are fine.
  it("refuses with its own code, not the base's, when git cannot be started at all", async () => {
    const fixture = await startDaemonWithChangedWorkspace("no-git");
    if (!daemon) throw new Error("Expected a daemon");
    const running = daemon;

    // `runGit` resolves "git" through PATH and rejects with GitMissingError when spawn cannot find
    // it, which is the one failure this branch exists for. Put back in `finally` before anything
    // else in this file runs; the daemon itself is already up, so nothing but this request looks
    // for git while it is unset.
    const realPath = process.env["PATH"];
    process.env["PATH"] = join(tmpdir(), "loomrail-there-is-no-git-here");

    try {
      const response = await fetch(changesUrl(running, fixture.workItemId), {
        headers: { cookie: fixture.session.cookie },
      });

      expect(response.status).toBe(500);
      const error = apiErrorResponseSchema.parse(await response.json()).error;
      expect(error.code).toBe("GIT_UNAVAILABLE");
      // And it does not send the owner to look at a worktree and a base that are both intact.
      expect(error.message).not.toContain(fixture.worktreePath);
    } finally {
      process.env["PATH"] = realPath;
    }
  });

  it("refuses a workspace that records no commit to compare against", async () => {
    const fixture = await startDaemonWithChangedWorkspace("baseless", { recordedBase: "NONE" });
    if (!daemon) throw new Error("Expected a daemon");

    const response = await fetch(changesUrl(daemon, fixture.workItemId), {
      headers: { cookie: fixture.session.cookie },
    });

    expect(response.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe("WORKSPACE_HAS_NO_BASELINE");
  });

  it("answers null for a work item with no workspace, 404 for one that does not exist, and 401 without a session", async () => {
    const fixture = await startDaemonWithChangedWorkspace("boundaries");
    if (!daemon) throw new Error("Expected a daemon");
    const running = daemon;
    const cookie = { cookie: fixture.session.cookie };

    // A work item that never needed a repository is the ordinary state of every prose-only stage,
    // and the card has to be able to tell it apart from a work item that does not exist -- the
    // same distinction, and the same 200/null answer, that GET .../workspace already makes.
    const absentSummary = await fetch(changesUrl(running, fixture.workItemWithoutWorkspaceId), {
      headers: cookie,
    });
    expect(absentSummary.status).toBe(200);
    expect(workItemChangesResponseSchema.parse(await absentSummary.json()).changes).toBeNull();
    const absentDiff = await fetch(diffUrl(running, fixture.workItemWithoutWorkspaceId, "committed.txt"), {
      headers: cookie,
    });
    expect(absentDiff.status).toBe(200);
    expect(workItemFileDiffResponseSchema.parse(await absentDiff.json()).diff).toBeNull();

    const unknownSummary = await fetch(changesUrl(running, "work-item-nowhere"), { headers: cookie });
    expect(unknownSummary.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await unknownSummary.json()).error.code).toBe("WORK_ITEM_NOT_FOUND");
    const unknownDiff = await fetch(diffUrl(running, "work-item-nowhere", "committed.txt"), {
      headers: cookie,
    });
    expect(unknownDiff.status).toBe(404);

    // The same session boundary as the rest of /api/v1. What an agent wrote in the owner's own
    // files is exactly what the session exists to keep off an unauthenticated read.
    expect((await fetch(changesUrl(running, fixture.workItemId))).status).toBe(401);
    expect((await fetch(diffUrl(running, fixture.workItemId, "committed.txt"))).status).toBe(401);
  });
});

// Bounds every "the answer must arrive before the gate opens" race below. This machine periodically
// runs at load average 60-90 (session-worker.integration.test.ts:97 measures the same class of
// concern), where vitest's own blanket per-test timeout firing first would report the exact same
// message a real defect produces -- the ambiguity this project cannot afford. A bound this generous
// costs nothing in the passing case, since a correct answer arrives near-instantly; only a genuinely
// regressed handler ever waits it out.
const BOOT_ANSWER_BUDGET_MS = 15_000;

// Task 8 (A1.5 spec D4-D6): the dispatch queue moved off the startup path and the four mutation
// handlers onto a background `SessionWorker`. Every test here uses `gatedAdapter` (test/gated-
// adapter.ts) to hold a provider session open on purpose, so a handler or startup pass that
// regressed back to awaiting the drain in-line would leave its test hanging on the same gate the
// adapter is held by, rather than answering early -- the whole point of this milestone.
//
// The describe-level timeout (well above BOOT_ANSWER_BUDGET_MS) exists so a regression is reported
// by the race's own assertion, not by vitest's blanket per-test timeout winning the tie against it.
describe("background session worker wiring", { timeout: 20_000 }, () => {
  const temporaryDirectories: string[] = [];
  let databasePath = "";
  let token = "";

  beforeEach(async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail worker wiring "));
    temporaryDirectories.push(temporaryDirectory);
    databasePath = join(temporaryDirectory, "state.sqlite");
    token = bootstrapToken();
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  // Seeds a queued dispatch directly on disk, the way a real restart finds one: through a plain
  // `LocalState` connection that is fully closed again before the daemon under test ever opens the
  // same file, never concurrently with it.
  const seedQueuedAttemptOnDisk = async (stateDatabasePath: string): Promise<SeededAttempt> => {
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      let nextCommandId = 0;
      return seedQueuedAttempt(
        localState,
        () => `seed-command-${(nextCommandId += 1).toString()}`,
        dirname(stateDatabasePath),
      );
    } finally {
      localState.close();
    }
  };

  // A second, independent connection onto the daemon's own database file. WAL mode (set at open,
  // packages/persistence-sqlite/src/index.ts) lets a fresh reader see everything the daemon's own
  // connection has already committed without contending with it -- exactly what's needed to prove a
  // session row exists while that same session is still gated open on the daemon side.
  const sessionRows = async (
    stateDatabasePath: string,
    stageAttemptId: string,
  ): Promise<{ sessions: ProviderSession[] }> => {
    const localState = await openLocalState({ databasePath: stateDatabasePath });
    try {
      const result = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
      if (result.type !== "PROVIDER_SESSIONS") throw new Error("Expected provider sessions");
      return { sessions: result.sessions };
    } finally {
      localState.close();
    }
  };

  it("listens while a resumed attempt is still running", async () => {
    // The point of the whole task, asserted by racing the boot pass against a generous budget
    // instead of a bare timer: under the regression this proves against (an `await` restored on the
    // boot pass before `app.listen`), `startup` never resolves, and the race's own assertion reports
    // that -- not vitest's blanket per-test timeout, which would print the identical message for an
    // unrelated slow machine.
    const adapter = gatedAdapter();
    const seeded = await seedQueuedAttemptOnDisk(databasePath);

    const startup = startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    let daemon: RunningDaemon | undefined;
    try {
      await adapter.started; // the boot pass really opened a session
      const outcome = await Promise.race([
        startup.then(() => "listening" as const),
        delay(BOOT_ANSWER_BUDGET_MS).then(() => "held on the boot pass" as const),
      ]);
      expect(outcome).toBe("listening");
      daemon = await startup;

      const health = await fetch(`${daemon.baseUrl}/health/ready`);
      expect(health.status).toBe(200);
      expect((await sessionRows(databasePath, seeded.stageAttemptId)).sessions).toHaveLength(1);
    } finally {
      adapter.release();
      if (daemon) {
        await daemon.whenIdle();
        await daemon.close();
      }
    }
  });

  // The other half: a request that starts a stage must answer before the stage ends, or "answer a
  // Human Request" would hold the response open for the whole stage once the provider is live.
  // Raced against the same generous budget as the boot pass above, for the same reason: under the
  // regression this proves against (an `await` restored in the handler after `worker.wake()`), the
  // response never arrives, and the race's own assertion has to be the one that reports that.
  it("answers a pipeline start before the stage has finished", async () => {
    const adapter = gatedAdapter();
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    try {
      const session = await authenticate(daemon, token);
      // Releasing the gate in this test's `finally` lets the drain carry the run on past DISCOVERY
      // to IMPLEMENT, which cuts a worktree from whatever repository the WorkItem's Project names.
      // `createReadyWorkItem` is what makes that a materialised fixture rather than this checkout,
      // and asserts as much before handing the WorkItem back.
      const workItemId = await createReadyWorkItem(daemon, session, "pipeline-start-under-test");
      const response = fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({ schemaVersion: 1, commandId: "start-under-test", expectedVersion: 2 }),
      });
      await adapter.started; // the handler's own wake() really opened a session
      const outcome = await Promise.race([
        response.then(() => "answered" as const),
        delay(BOOT_ANSWER_BUDGET_MS).then(() => "held on the stage" as const),
      ]);
      expect(outcome).toBe("answered");
      const settled = await response;
      expect(settled.status).toBe(200);
      const snapshot = workflowSnapshotSchema.parse(await settled.json());
      expect(snapshot.run?.status).toBe("RUNNING");
      // Proves a session was actually opened, not merely that the test hasn't released it yet
      // (`releasedCount` only ever changes because the test itself calls `adapter.release()` below).
      expect(adapter.startCallCount).toBe(1);
    } finally {
      adapter.release();
      await daemon.whenIdle();
      await daemon.close();
    }
  });

  // State a case's `act` needs, prepared before the gated daemon under test ever opens the database
  // (`prepare`), and handed to `act` once that daemon is up. `workItemId` is set for every case;
  // `humanRequestId`/`humanRequestVersion` only for the case that needs one.
  type PreparedFixture = {
    workItemId: string;
    humanRequestId?: string;
    humanRequestVersion?: number;
  };
  type Prepare = (stateDatabasePath: string) => Promise<PreparedFixture>;
  type Act = (
    daemon: RunningDaemon,
    session: AuthenticatedSession,
    fixture: PreparedFixture,
  ) => Promise<Response>;

  // The two rows whose `act` creates its own WorkItem need nothing prepared: `createReadyWorkItem`
  // registers the fixture against the daemon under test, and registration is what turns it into a
  // repository those rows can safely reach IMPLEMENT in.
  const noPreparation: Prepare = () => Promise.resolve({ workItemId: "" });

  // Drives a fresh WorkItem through a throwaway, unblocked daemon until the workflow's kickoff stage
  // raises its SINGLE_CHOICE HumanRequest -- reaching that needs a real (if fast) session, which the
  // gated adapter under test can never let finish, so it has to happen on a different daemon
  // instance entirely. That daemon is fully closed before the one under test ever opens the same
  // database file; the two never touch it at once.
  const seedOpenHumanRequest: Prepare = async (stateDatabasePath) => {
    const prelimToken = bootstrapToken();
    const prelim = await startDaemon({ bootstrapToken: prelimToken, logger: false, stateDatabasePath });
    try {
      const session = await authenticate(prelim, prelimToken);
      // The prelim daemon and the one under test open the same database file and default their
      // demo root to the same directory beside it, so the Project this registers stays valid -- and
      // stays a repository -- for the daemon that reads it back.
      const workItemId = await createReadyWorkItem(prelim, session, "kickoff-request-fixture");
      await fetch(`${prelim.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
        method: "POST",
        headers: mutationHeaders(prelim, session),
        body: JSON.stringify({ schemaVersion: 1, commandId: "start-kickoff-fixture", expectedVersion: 2 }),
      });
      await prelim.whenIdle();
      const opened = await fetchWorkflowSnapshot(prelim, session.cookie, workItemId);
      const request = opened.humanRequests.find(({ status }) => status === "OPEN");
      if (!request) throw new Error("Expected the kickoff HumanRequest to be open");
      return { workItemId, humanRequestId: request.id, humanRequestVersion: request.version };
    } finally {
      await prelim.close();
    }
  };

  // Builds on the same kickoff fixture, then answers it and lets the (still unblocked) daemon run
  // IMPLEMENT far enough to hit the default budget -- the same path
  // "restores a blocking HumanRequest after restart and answers it exactly once" proves reaches a
  // budget HARD_PAUSED, not a session-pause one, which is the only kind `APPROVE_BUDGET_OVERRIDE`
  // accepts (packages/domain/src/session-pause.ts).
  const seedBudgetHardPause: Prepare = async (stateDatabasePath) => {
    const seeded = await seedOpenHumanRequest(stateDatabasePath);
    if (!seeded.humanRequestId || seeded.humanRequestVersion === undefined) {
      throw new Error("Expected a seeded HumanRequest");
    }
    const prelimToken = bootstrapToken();
    const prelim = await startDaemon({ bootstrapToken: prelimToken, logger: false, stateDatabasePath });
    try {
      const session = await authenticate(prelim, prelimToken);
      await fetch(`${prelim.baseUrl}/api/v1/human-requests/${seeded.humanRequestId}/answer`, {
        method: "POST",
        headers: mutationHeaders(prelim, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "answer-kickoff-fixture",
          expectedVersion: seeded.humanRequestVersion,
          answer: { type: "OPTION", optionIds: ["focused-pass"] },
        }),
      });
      await prelim.whenIdle();
      const paused = await fetchWorkflowSnapshot(prelim, session.cookie, seeded.workItemId);
      if (paused.run?.status !== "HARD_PAUSED") {
        throw new Error(`Expected a budget hard pause, got ${paused.run?.status ?? "no run"}`);
      }
      return { workItemId: seeded.workItemId };
    } finally {
      await prelim.close();
    }
  };

  const startPipeline: Act = async (daemon, session) => {
    const workItemId = await createReadyWorkItem(daemon, session, "pipeline-start-each");
    return fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "start-under-test-each", expectedVersion: 2 }),
    });
  };

  // SOFT_PAUSED is reachable without any session ever running: `PAUSE_PIPELINE` only requires the
  // current StageAttempt to be QUEUED/RUNNING/RECOVERING (packages/domain/src/workflow.ts), which it
  // already is the instant `START_MOCK_PIPELINE` returns. So this drives start-then-pause live
  // against the very daemon under test -- both are synchronous domain commands the gated adapter
  // never sees -- and only the final `resume` call is the one being tested.
  const resumePipeline: Act = async (daemon, session) => {
    const workItemId = await createReadyWorkItem(daemon, session, "pipeline-resume-each");
    const startResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "start-for-resume-each", expectedVersion: 2 }),
    });
    const started = workflowSnapshotSchema.parse(await startResponse.json());
    if (!started.run) throw new Error("Expected a PipelineRun");
    const pauseResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/pause`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "pause-for-resume-each",
        expectedVersion: started.run.version,
      }),
    });
    const paused = workflowSnapshotSchema.parse(await pauseResponse.json());
    if (!paused.run) throw new Error("Expected a paused PipelineRun");
    return fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/resume`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "resume-under-test-each",
        expectedVersion: paused.run.version,
      }),
    });
  };

  const approveBudgetOverride: Act = async (daemon, session, fixture) => {
    const snapshot = await fetchWorkflowSnapshot(daemon, session.cookie, fixture.workItemId);
    if (!snapshot.run) throw new Error("Expected a PipelineRun");
    return fetch(`${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/pipeline/budget-override`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "budget-override-under-test-each",
        expectedVersion: snapshot.run.version,
        maxEstimatedTokens: 200,
      }),
    });
  };

  const answerOpenRequest: Act = async (daemon, session, fixture) => {
    if (!fixture.humanRequestId || fixture.humanRequestVersion === undefined) {
      throw new Error("Expected a seeded HumanRequest");
    }
    return fetch(`${daemon.baseUrl}/api/v1/human-requests/${fixture.humanRequestId}/answer`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "answer-under-test-each",
        expectedVersion: fixture.humanRequestVersion,
        answer: { type: "OPTION", optionIds: ["focused-pass"] },
      }),
    });
  };

  // Spec §9 names all four handlers, not one. They receive the identical one-line change, so the
  // cheap mistake is changing three and missing the fourth -- which no other test would notice,
  // because a handler that still awaits the drain simply answers later and answers correctly.
  // Each row races its own `act` against the same generous budget as the two tests above, for the
  // same reason: a handler that regressed back to awaiting the drain must fail this by assertion,
  // not by vitest's blanket per-test timeout.
  it.each<[string, Prepare, Act]>([
    ["pipeline start", noPreparation, startPipeline],
    ["pipeline resume", noPreparation, resumePipeline],
    ["budget override", seedBudgetHardPause, approveBudgetOverride],
    ["human request answer", seedOpenHumanRequest, answerOpenRequest],
  ])(
    "answers %s before the stage it triggers has finished",
    async (_name, prepare, act) => {
      const fixture = await prepare(databasePath);
      const adapter = gatedAdapter();
      const daemon = await startDaemon({
        bootstrapToken: token,
        stateDatabasePath: databasePath,
        logger: false,
        providerAdapter: adapter,
      });
      try {
        const session = await authenticate(daemon, token);
        const response = act(daemon, session, fixture);
        await adapter.started; // the handler's own wake() really opened a session
        const outcome = await Promise.race([
          response.then(() => "answered" as const),
          delay(BOOT_ANSWER_BUDGET_MS).then(() => "held on the stage" as const),
        ]);
        expect(outcome).toBe("answered");
        const settled = await response;
        expect(settled.status).toBe(200);
        // Proves a session was actually opened, not merely that the test hasn't released it yet
        // (`releasedCount` only ever changes because the test itself calls `adapter.release()` below).
        expect(adapter.startCallCount).toBe(1);
      } finally {
        adapter.release();
        await daemon.whenIdle();
        await daemon.close();
      }
      // The budget-override row's own preparation runs a pipeline as far as IMPLEMENT, which cuts a
      // real worktree; that is `git` subprocesses on top of two daemons, and outlives vitest's 5s
      // default under a loaded `pnpm test`. The race above still bounds the behaviour under test.
    },
    30_000,
  );

  it("closes while an attempt is still in flight and asks it to abort", async () => {
    const adapter = gatedAdapter();
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    const session = await authenticate(daemon, token);
    const workItemId = await createReadyWorkItem(daemon, session, "close-while-in-flight");
    await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "start-close-while-in-flight",
        expectedVersion: 2,
      }),
    });
    await adapter.started;

    const closed = daemon.close().then(() => "closed" as const);
    const timedOut = delay(5_000, "hung" as const);
    await expect(Promise.race([closed, timedOut])).resolves.toBe("closed");
    expect(adapter.abortedSessions).toHaveLength(1);
    // Deliberately never released: `close()` does not wait for the live session (spec D5), so it is
    // still gated on `await gate` inside `runStageAttempt` at this point. Releasing it here would let
    // that call resume and try to write through `localState` -- which `close()`'s `finally` has
    // already closed -- and the only thing standing between that and a stray error escaping this
    // test is the worker pump's own catch-and-log (muted here by `logger: false`). Leaving the gate
    // shut is simpler than proving the write is harmless: nothing awaits the gated promise, so it
    // is inert, and there is nothing left in this test that needs the session to finish.
  });

  // IMPORTANT (fix round): the ordering `close()` depends on -- `worker.stop()` asking the live
  // session to abort *before* `app.close()` starts dropping connections -- had no test that could
  // observe the order, only that both eventually happened. This makes the order observable with two
  // independently timestamped markers: the abort request (recorded by wrapping the adapter) and the
  // SSE stream actually dropping (recorded by reading it to its end, which only happens once
  // `preClose`'s `closeAll()` runs `response.end()` on it -- see event-stream.ts). Both markers are
  // pushed onto one array in the order they're observed, so the array itself is the assertion: if
  // `close()` ever reordered the two lines, `closeAll()` would run first and the stream would drop
  // before the abort request was ever recorded.
  it("stops the live session before it starts dropping open connections", async () => {
    const adapter = gatedAdapter();
    const events: string[] = [];
    const originalAbortSession = adapter.abortSession;
    adapter.abortSession = (sessionId: string): Promise<void> => {
      events.push("session asked to abort");
      return originalAbortSession(sessionId);
    };

    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    // Fastify refuses `addHook` once the instance is already listening
    // (FST_ERR_INSTANCE_ALREADY_LISTENING), and `startDaemon` only ever hands back an instance past
    // that point, so the only seam left is the call itself: `close()` (server.ts) is literally
    // `await worker.stop(); await app.close();`, and intercepting `app.close` records the exact
    // in-process moment that second statement runs, with none of the network round-trip latency a
    // client-observed effect would add. Two earlier versions of this test tried exactly that -- an
    // SSE stream read to `done`, then a raw socket's `close` event -- and both were consistently
    // *slower* than the rest of `close()` finishing, which made the test pass regardless of which
    // line in `close()` actually ran first. That gap is the false confidence this test exists to
    // rule out; only an in-process interception closes it.
    const originalAppClose = daemon.app.close.bind(daemon.app) as () => Promise<undefined>;
    daemon.app.close = ((): Promise<undefined> => {
      events.push("connections started closing");
      return originalAppClose();
    }) as unknown as typeof daemon.app.close;

    const session = await authenticate(daemon, token);
    const workItemId = await createReadyWorkItem(daemon, session, "close-ordering-under-test");
    await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/pipeline/start`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "start-close-ordering", expectedVersion: 2 }),
    });
    await adapter.started;

    await daemon.close();

    expect(events).toEqual(["session asked to abort", "connections started closing"]);
    // Left gated, same as the test above and for the same reason.
  });
});

// Task 9 (milestone A2): before E1 a live adapter has no filesystem access and cannot serve
// IMPLEMENT (packages/domain/src/workflow.ts's `decideDispatchStage`). Without this gate the
// dispatcher would hand IMPLEMENT to the adapter anyway, the adapter would return prose, and the
// stage would look done with no work behind it.
describe("stage capability gate", () => {
  const temporaryDirectories: string[] = [];
  let databasePath = "";
  let token = "";

  beforeEach(async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail stage gate "));
    temporaryDirectories.push(temporaryDirectory);
    databasePath = join(temporaryDirectory, "state.sqlite");
    token = bootstrapToken();
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("refuses to dispatch IMPLEMENT to an adapter that does not declare it, and asks the owner", async () => {
    // DISCOVERY and PLAN are declared and must run to completion through this same adapter; only
    // IMPLEMENT is missing. Released immediately: nothing in this test wants to hold a session open,
    // and an ungated adapter would leave a mutated "always DISPATCH" gate hanging on `await gate`
    // inside `runStageAttempt` forever, turning a defect this test exists to catch into a timeout
    // instead of the assertion failures below.
    const adapter = gatedAdapter(200_000, { provider: "CODEX", stages: ["DISCOVERY", "PLAN"] });
    adapter.release();
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    try {
      const session = await authenticate(daemon, token);
      const headers = mutationHeaders(daemon, session);
      await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "register-gate-fixture",
          fixtureId: "web-app-a",
        }),
      });
      const createResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "create-gate-item",
          projectId: "project-fixture-web-app-a",
          type: "TASK",
          title: "Stage gate under test",
        }),
      });
      const created = stateCommandResultSchema.parse(await createResponse.json());
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "ready-gate-item",
          expectedVersion: 1,
          targetState: "READY",
        }),
      });
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ schemaVersion: 1, commandId: "start-gate-item", expectedVersion: 2 }),
      });
      await daemon.whenIdle();

      const snapshot = await fetchWorkflowSnapshot(daemon, session.cookie, created.workItem.id);
      expect(snapshot.run?.status).toBe("WAITING_HUMAN");
      expect(snapshot.stageAttempts.map(({ stage, status }) => ({ stage, status }))).toEqual([
        { stage: "DISCOVERY", status: "SUCCEEDED" },
        { stage: "PLAN", status: "SUCCEEDED" },
        { stage: "IMPLEMENT", status: "WAITING_HUMAN" },
      ]);
      // Proves the adapter was never asked to run the stage it does not declare -- not merely that
      // the daemon recovered after trying. Under the mutation that always dispatches, this call
      // count climbs past 2 (IMPLEMENT, and whatever the mock-shaped COMPLETED outcome lets run
      // after it), which is what actually catches the defect; the stageAttempts assertion above
      // would already have failed by then too.
      expect(adapter.startCallCount).toBe(2);
      expect(snapshot.humanRequests).toHaveLength(1);
      const request = snapshot.humanRequests[0];
      expect(request).toMatchObject({ status: "OPEN", kind: "FREE_TEXT", blocking: true });
      const wording = `${request?.title ?? ""} ${request?.context ?? ""}`;
      expect(wording).toContain("IMPLEMENT");
      expect(wording).toContain("CODEX");
    } finally {
      await daemon.whenIdle();
      await daemon.close();
    }
  });

  // Task 10.5's own half of this gate: `capabilities().start` is `false` when the adapter's CLI is
  // not installed on this machine at all, and `decideDispatchStage` (packages/domain/src/workflow.ts)
  // must refuse on that alone, before it ever looks at `declaredStages`. Every prior test of that
  // check (packages/domain/test/workflow.unit.test.ts) exercises the pure decision function
  // directly -- nothing before this test drove the actual wiring at the `session-loop.ts` call site
  // that reads `capabilities.start` and passes it through as `canStart`. Hardcoding `canStart: true`
  // there (or wiring a different field) would make this refusal vanish silently, and nothing else in
  // this suite would notice.
  it("refuses to dispatch to an adapter that cannot start at all, and asks the owner", async () => {
    // Deliberately left at the default `stages` (every stage, like the mock) -- unlike the sibling
    // test above, this adapter declares everything. A decision to refuse here can therefore only be
    // explained by the gate reading `start`, not by any stage being undeclared. DISCOVERY is the
    // very first stage the workflow would dispatch, so a mutation that skipped this check would let
    // the run proceed past it instead of stopping before the first session ever opens.
    const adapter = gatedAdapter(200_000, { provider: "CODEX", start: false });
    adapter.release();
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    try {
      const session = await authenticate(daemon, token);
      const headers = mutationHeaders(daemon, session);
      await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "register-start-gate-fixture",
          fixtureId: "web-app-a",
        }),
      });
      const createResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "create-start-gate-item",
          projectId: "project-fixture-web-app-a",
          type: "TASK",
          title: "Start-capability gate under test",
        }),
      });
      const created = stateCommandResultSchema.parse(await createResponse.json());
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "ready-start-gate-item",
          expectedVersion: 1,
          targetState: "READY",
        }),
      });
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ schemaVersion: 1, commandId: "start-start-gate-item", expectedVersion: 2 }),
      });
      await daemon.whenIdle();

      const snapshot = await fetchWorkflowSnapshot(daemon, session.cookie, created.workItem.id);
      expect(snapshot.run?.status).toBe("WAITING_HUMAN");
      expect(snapshot.stageAttempts.map(({ stage, status }) => ({ stage, status }))).toEqual([
        { stage: "DISCOVERY", status: "WAITING_HUMAN" },
      ]);
      // The strongest form of this proof: not merely that the adapter was not asked to run a stage
      // it does not declare (it declares all of them), but that `start()` was never called at all --
      // the refusal happens before a session ever opens.
      expect(adapter.startCallCount).toBe(0);
      expect(snapshot.humanRequests).toHaveLength(1);
      const request = snapshot.humanRequests[0];
      expect(request).toMatchObject({ status: "OPEN", kind: "FREE_TEXT", blocking: true });
      const wording = `${request?.title ?? ""} ${request?.context ?? ""}`;
      expect(wording).toContain("CODEX");
      expect(wording).toContain("not installed");
      // Distinguishes this from the sibling "stage not declared" refusal above -- reusing that
      // branch's wording here would point the owner at the wrong fix (reassign the stage, when the
      // actual fix is installing the CLI).
      expect(wording).not.toContain("cannot serve");
    } finally {
      await daemon.whenIdle();
      await daemon.close();
    }
  });

  // The sibling test above proves the gate reads `start`, but it proves it against `gatedAdapter`,
  // a test double that has `start: false` hardcoded -- it never exercises the real adapter's own
  // missing-executable check. This is the other half: `createCodexProvider` from the actual
  // production package, pointed at a command that does not exist, so its own `isExecutableOnDisk`
  // (packages/provider-codex/src/index.ts) is what decides `capabilities().start`, not a test
  // fixture pretending to. This is the path an owner actually takes: set `LOOMRAIL_PROVIDER=CODEX`
  // (see `resolveDefaultProviderAdapter`, apps/daemon/src/provider-selection.ts) without having
  // installed the CLI, and confirm the daemon produces the same clean refusal `decideDispatchStage`
  // always has, rather than something worse -- a hang, a crash, or a session that starts anyway and
  // fails mid-flight.
  it("refuses to dispatch to a real adapter whose CLI genuinely is not on this machine", async () => {
    const adapter = createCodexProvider({ command: "/nonexistent/loomrail-test-fixture/codex" });
    const daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: databasePath,
      logger: false,
      providerAdapter: adapter,
    });
    try {
      const session = await authenticate(daemon, token);
      const headers = mutationHeaders(daemon, session);
      await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "register-real-start-gate-fixture",
          fixtureId: "web-app-a",
        }),
      });
      const createResponse = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "create-real-start-gate-item",
          projectId: "project-fixture-web-app-a",
          type: "TASK",
          title: "Real adapter start-capability gate under test",
        }),
      });
      const created = stateCommandResultSchema.parse(await createResponse.json());
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/move`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "ready-real-start-gate-item",
          expectedVersion: 1,
          targetState: "READY",
        }),
      });
      await fetch(`${daemon.baseUrl}/api/v1/work-items/${created.workItem.id}/pipeline/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "start-real-start-gate-item",
          expectedVersion: 2,
        }),
      });
      await daemon.whenIdle();

      const snapshot = await fetchWorkflowSnapshot(daemon, session.cookie, created.workItem.id);
      expect(snapshot.run?.status).toBe("WAITING_HUMAN");
      expect(snapshot.stageAttempts.map(({ stage, status }) => ({ stage, status }))).toEqual([
        { stage: "DISCOVERY", status: "WAITING_HUMAN" },
      ]);
      expect(snapshot.humanRequests).toHaveLength(1);
      const request = snapshot.humanRequests[0];
      expect(request).toMatchObject({ status: "OPEN", kind: "FREE_TEXT", blocking: true });
      const wording = `${request?.title ?? ""} ${request?.context ?? ""}`;
      expect(wording).toContain("CODEX");
      expect(wording).toContain("not installed");
    } finally {
      await daemon.whenIdle();
      await daemon.close();
    }
  });
});
