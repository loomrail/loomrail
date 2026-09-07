import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectWorkspaceStrategyResponseSchema, projectsResponseSchema } from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";

describe("Project workspace strategy API", () => {
  let directory = "";
  let daemon: RunningDaemon | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail workspace strategy api "));
  });

  afterEach(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requires owner mutation security and returns the durable selection", async () => {
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo-projects"),
      logger: false,
    });
    const unauthenticated = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/workspace-strategy`,
    );
    expect(unauthenticated.status).toBe(401);

    const session = await authenticate(daemon, token);
    const register = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-project", fixtureId: "web-app-a" }),
    });
    expect(register.status).toBe(200);
    const projectId = "project-fixture-web-app-a";

    const initialResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`, {
      headers: { cookie: session.cookie },
    });
    expect(initialResponse.status).toBe(200);
    expect(projectWorkspaceStrategyResponseSchema.parse(await initialResponse.json())).toMatchObject({
      selection: { strategy: "ISOLATED_WORKTREE", projectVersion: 1 },
    });

    const missingCsrf = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: daemon.baseUrl,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "missing-csrf",
        expectedProjectVersion: 1,
        strategy: "SHARED_CURRENT_DIRECTORY",
      }),
    });
    expect(missingCsrf.status).toBe(403);

    const foreignOrigin = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`, {
      method: "PUT",
      headers: { ...mutationHeaders(daemon, session), origin: "https://example.invalid" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "foreign-origin",
        expectedProjectVersion: 1,
        strategy: "SHARED_CURRENT_DIRECTORY",
      }),
    });
    expect(foreignOrigin.status).toBe(403);

    const selectedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`,
      {
        method: "PUT",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "choose-shared",
          expectedProjectVersion: 1,
          strategy: "SHARED_CURRENT_DIRECTORY",
        }),
      },
    );
    expect(selectedResponse.status).toBe(200);
    expect(projectWorkspaceStrategyResponseSchema.parse(await selectedResponse.json())).toMatchObject({
      selection: { strategy: "SHARED_CURRENT_DIRECTORY", projectVersion: 2 },
    });

    const staleResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`, {
      method: "PUT",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "stale-selection",
        expectedProjectVersion: 1,
        strategy: "ISOLATED_WORKTREE",
      }),
    });
    expect(staleResponse.status).toBe(409);

    const invalidResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/workspace-strategy`, {
      method: "PUT",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "invalid-selection",
        expectedProjectVersion: 2,
        strategy: "UNSAFE_SHARED_DIRECTORY",
      }),
    });
    expect(invalidResponse.status).toBe(400);

    const projects = projectsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(projects.projects[0]).toMatchObject({ version: 2 });
  });
});
