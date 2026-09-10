import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apiErrorResponseSchema,
  launchEvidencePackageResponseSchema,
  launchReleaseProjectResponseSchema,
  projectsResponseSchema,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

describe("launch release HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("protects owner mutations and exports only bounded immutable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail release api тест "));
    directories.push(directory);
    const repositoryPath = await makeThrowawayRepo(join(directory, "Recurkit with spaces"));
    const databasePath = join(directory, "state.sqlite");
    const state = await openLocalState({ databasePath });
    const projectId = "release-api-project";
    try {
      state.execute({
        schemaVersion: 1,
        commandId: "register-release-api-project",
        correlationId: "correlation-register-release-api-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: { id: projectId, fixtureId: null, name: "Recurkit", repositoryPath },
      });
    } finally {
      state.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);

    expect((await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/launch-release`)).status).toBe(401);
    expect(
      (
        await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/launch-release/environments`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: session.cookie, origin: daemon.baseUrl },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);

    const projects = projectsResponseSchema.parse(
      await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } }).then(
        async (response) => response.json(),
      ),
    );
    const project = projects.projects.find(({ id }) => id === projectId);
    if (project === undefined) throw new Error("Seeded Project unavailable");

    const savedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-release/environments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "save-release-api-environment",
          expectedProjectVersion: project.version,
          environmentId: null,
          expectedEnvironmentVersion: null,
          configuration: {
            kind: "PREVIEW",
            name: "Рекуркит Preview",
            presetId: "WEB_APP_V1",
            presetRevision: 1,
            publicBaseUrl: "https://preview.example.test",
            healthPath: "/api/health",
            requiredEnvironmentVariables: ["DATABASE_URL"],
          },
        }),
      },
    );
    expect(savedResponse.status).toBe(200);
    const saved = launchReleaseProjectResponseSchema.parse(await savedResponse.json());
    expect(saved.environments).toHaveLength(1);
    const environment = saved.environments[0];
    if (environment === undefined) throw new Error("Saved Environment unavailable");

    const releaseResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-release/releases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "create-release-api-release",
          expectedProjectVersion: saved.projectVersion,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          workItemIds: [],
        }),
      },
    );
    expect(releaseResponse.status).toBe(200);
    const released = launchReleaseProjectResponseSchema.parse(await releaseResponse.json());
    expect(released.latestRelease).not.toBeNull();
    if (released.latestRelease === null) throw new Error("Created Release unavailable");
    expect(released.latestRelease.sourceTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(released.latestRelease.requiredGateCount).toBe(24);
    expect(released.latestRelease.passedRequiredGateCount).toBe(0);
    expect(released.freshness).toEqual({ status: "CURRENT", reasons: [] });

    const releaseId = released.latestRelease.id;
    const exportResponse = await fetch(
      `${daemon.baseUrl}/api/v1/launch-releases/${releaseId}/evidence-package`,
      { headers: { cookie: session.cookie } },
    );
    expect(exportResponse.status).toBe(200);
    const evidence = launchEvidencePackageResponseSchema.parse(await exportResponse.json());
    expect(evidence.markdown).toContain("Required gates passed: 0 of 24");
    expect(evidence.markdown).not.toContain(repositoryPath);
    expect(evidence.markdown).not.toContain("DATABASE_URL=");

    expect(
      (
        await fetch(`${daemon.baseUrl}/api/v1/launch-releases/missing-release/evidence-package`, {
          headers: { cookie: session.cookie },
        })
      ).status,
    ).toBe(404);

    await writeFile(join(repositoryPath, ".git", "MERGE_HEAD"), "0".repeat(40));
    const unstableResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-release/releases`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "refuse-unstable-release-api-release",
          expectedProjectVersion: released.projectVersion,
          environmentId: environment.id,
          expectedEnvironmentVersion: environment.version,
          expectedEnvironmentContentHash: environment.contentHash,
          workItemIds: [],
        }),
      },
    );
    expect(unstableResponse.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await unstableResponse.json()).error.code).toBe(
      "REPOSITORY_OPERATION_IN_PROGRESS",
    );
  });
});
