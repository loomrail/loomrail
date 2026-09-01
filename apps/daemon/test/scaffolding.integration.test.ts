import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectsResponseSchema,
  proposeProjectScaffoldResponseSchema,
  scaffoldOperationResponseSchema,
  scaffoldOperationsResponseSchema,
  stateCommandResultSchema,
  type ScaffoldProposal,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { inspectRepository, runGit } from "@loomrail/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";

describe("Project Scaffold HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  let root = "";

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });

  const propose = async (
    running: RunningDaemon,
    cookie: string,
    targetPath: string,
  ): Promise<ScaffoldProposal> => {
    const response = await fetch(`${running.baseUrl}/api/v1/scaffolds/propose`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ schemaVersion: 1, recipeId: "typescript-node", targetPath }),
    });
    expect(response.status).toBe(200);
    return proposeProjectScaffoldResponseSchema.parse(await response.json()).proposal;
  };

  it("previews without writes, enforces mutation security and publishes an active Git Project", async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail scaffold api "));
    const targetPath = join(root, "new-project");
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "state.sqlite"),
    });

    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, recipeId: "typescript-node", targetPath }),
    });
    expect(unauthenticated.status).toBe(401);

    const session = await authenticate(daemon, token);
    const proposal = await propose(daemon, session.cookie, targetPath);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const noCsrf = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: daemon.baseUrl,
      },
      body: JSON.stringify({ schemaVersion: 1, commandId: "publish-without-csrf", proposal }),
    });
    expect(noCsrf.status).toBe(403);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const publishedResponse = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "publish-scaffold", proposal }),
    });
    expect(publishedResponse.status).toBe(200);
    const published = scaffoldOperationResponseSchema.parse(await publishedResponse.json());
    expect(published.operation).toMatchObject({
      status: "COMPLETED",
      attempts: 1,
      proposal: { proposalDigest: proposal.proposalDigest },
    });
    if (published.operation === null) throw new Error("Scaffold operation was not returned");

    const repository = await inspectRepository(proposal.targetPath);
    expect(repository).toMatchObject({ topLevel: proposal.targetPath, headCommit: null, inProgress: null });
    expect(await readFile(join(proposal.targetPath, "README.md"), "utf8")).toContain(
      "did not install dependencies",
    );
    await expect(readFile(join(proposal.targetPath, "node_modules"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const remotes = await runGit(["remote"], { cwd: proposal.targetPath });
    expect(remotes).toMatchObject({ exitCode: 0, stdout: "" });

    const projectsResponse = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await projectsResponse.json());
    expect(projects.projects).toEqual([
      expect.objectContaining({
        id: published.operation.projectId,
        repositoryPath: proposal.targetPath,
        status: "ACTIVE",
      }),
    ]);

    const duplicate = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "publish-scaffold-again", proposal }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("PROJECT_ALREADY_EXISTS");
  });

  // REQUEST_PROJECT_SCAFFOLD writes a Project whose `repository_path` is UNIQUE and which nothing
  // ever deletes, so a publish that cannot succeed must not reach it: otherwise a single failed
  // attempt takes the path with it, permanently, and neither retry nor a later manual registration
  // can recover it. Both halves of the preview are therefore re-established before the durable write.
  it("refuses an unpublishable or edited proposal before any Project claims the path", async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail scaffold preflight "));
    const targetPath = join(root, "taken-project");
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "state.sqlite"),
    });
    const session = await authenticate(daemon, token);
    const proposal = await propose(daemon, session.cookie, targetPath);

    const edited = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "publish-edited-scaffold",
        proposal: { ...proposal, packageName: "somebody-elses-name" },
      }),
    });
    expect(edited.status).toBe(409);
    expect(await edited.text()).toContain("PROPOSAL_CHANGED");

    // Something else claimed the directory between preview and publish -- the ordinary race, not an
    // attack. The publisher would fail on the missing marker; the point is that it never gets there.
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(targetPath, "README.md"), "Someone else got here first.\n", "utf8");
    const raced = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "publish-raced-scaffold", proposal }),
    });
    expect(raced.status).toBe(409);
    expect(await raced.text()).toContain("TARGET_EXISTS");

    const openOperations = await fetch(`${daemon.baseUrl}/api/v1/scaffolds`, {
      headers: { cookie: session.cookie },
    });
    expect(scaffoldOperationsResponseSchema.parse(await openOperations.json()).operations).toEqual([]);

    // The decisive part: no Project row was created, so the owner can still adopt that directory as
    // an ordinary repository once they have made it one.
    await runGit(["init", "--initial-branch=main"], { cwd: targetPath });
    const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-raced-target",
        repositoryPath: targetPath,
      }),
    });
    const registrationBody: unknown = await registration.json();
    expect(registration.status, JSON.stringify(registrationBody)).toBe(200);
    expect(stateCommandResultSchema.parse(registrationBody).type).toBe("PROJECT_REGISTERED");
  });

  it("records a redacted failure and resumes the exact marker-bound target after explicit retry", async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail scaffold retry "));
    const databasePath = join(root, "state.sqlite");
    const targetPath = join(root, "retry-project");
    const token = bootstrapToken();
    let logs = "";
    daemon = await startDaemon({
      bootstrapToken: token,
      loggerStream: { write: (message) => (logs += message) },
      stateDatabasePath: databasePath,
      scaffoldPublisher: () =>
        Promise.reject(new Error(`publisher canary must stay redacted: ${targetPath}`)),
    });
    const session = await authenticate(daemon, token);
    const proposal = await propose(daemon, session.cookie, targetPath);
    const failedResponse = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/publish`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "publish-failing-scaffold", proposal }),
    });
    const failed = scaffoldOperationResponseSchema.parse(await failedResponse.json()).operation;
    expect(failed).toMatchObject({ status: "FAILED", lastErrorCode: "SCAFFOLD_WRITE_FAILED", version: 2 });
    expect(logs).not.toContain(targetPath);
    expect(logs).not.toContain("publisher canary");
    if (failed === null) throw new Error("Failed operation was not returned");

    const openResponse = await fetch(`${daemon.baseUrl}/api/v1/scaffolds`, {
      headers: { cookie: session.cookie },
    });
    const openResponseBody: unknown = await openResponse.json();
    expect(openResponse.status, JSON.stringify(openResponseBody)).toBe(200);
    expect(scaffoldOperationsResponseSchema.parse(openResponseBody).operations).toEqual([failed]);

    await daemon.close();
    daemon = undefined;
    const retryToken = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: retryToken,
      logger: false,
      stateDatabasePath: databasePath,
    });
    const retrySession = await authenticate(daemon, retryToken);
    const retriedResponse = await fetch(`${daemon.baseUrl}/api/v1/scaffolds/${failed.id}/retry`, {
      method: "POST",
      headers: mutationHeaders(daemon, retrySession),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "retry-failed-scaffold",
        expectedVersion: failed.version,
      }),
    });
    const retried = scaffoldOperationResponseSchema.parse(await retriedResponse.json()).operation;
    expect(retried).toMatchObject({ status: "COMPLETED", attempts: 2, version: 4 });
    expect((await inspectRepository(proposal.targetPath))?.topLevel).toBe(proposal.targetPath);
    const resolvedResponse = await fetch(`${daemon.baseUrl}/api/v1/scaffolds`, {
      headers: { cookie: retrySession.cookie },
    });
    const resolvedResponseBody: unknown = await resolvedResponse.json();
    expect(resolvedResponse.status, JSON.stringify(resolvedResponseBody)).toBe(200);
    expect(scaffoldOperationsResponseSchema.parse(resolvedResponseBody).operations).toEqual([]);
  });

  it("reconciles a confirmed pending operation before startup becomes ready", async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail scaffold restart "));
    const databasePath = join(root, "state.sqlite");
    const targetPath = join(root, "restart-project");
    const token = bootstrapToken();

    const previewDaemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "preview.sqlite"),
    });
    const previewSession = await authenticate(previewDaemon, token);
    const proposal = await propose(previewDaemon, previewSession.cookie, targetPath);
    await previewDaemon.close();

    let nextId = 0;
    const state = await openLocalState({
      databasePath,
      createId: (kind) => `${kind}-restart-${(nextId += 1).toString()}`,
      now: () => new Date("2026-09-01T09:30:00.000Z"),
    });
    state.execute({
      schemaVersion: 1,
      commandId: "confirm-before-crash",
      correlationId: "correlation-before-crash",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REQUEST_PROJECT_SCAFFOLD",
      payload: { proposal },
    });
    state.close();

    const restartToken = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: restartToken,
      logger: false,
      stateDatabasePath: databasePath,
    });
    const session = await authenticate(daemon, restartToken);
    const projectsResponse = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await projectsResponse.json());
    expect(projects.projects).toEqual([
      expect.objectContaining({ repositoryPath: proposal.targetPath, status: "ACTIVE" }),
    ]);
    expect((await inspectRepository(proposal.targetPath))?.topLevel).toBe(proposal.targetPath);
  });
});
