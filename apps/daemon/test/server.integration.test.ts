import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  apiErrorResponseSchema,
  correlationIdSchema,
  eventsResponseSchema,
  projectsResponseSchema,
  stateCommandResultSchema,
  workItemsResponseSchema,
  workflowSnapshotSchema,
  type ContextPackSpec,
  type ProviderSession,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { createCodexProvider } from "@loomrail/provider-codex";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { inspectRepository } from "@loomrail/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    // Named as the owner would see it on disk: the message has to point at a path they can go look
    // at, not at a canonicalised form of it they never typed.
    expect(failure.error.message).toContain(occupied);
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
