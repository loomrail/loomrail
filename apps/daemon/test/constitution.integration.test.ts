import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  constitutionPresetsResponseSchema,
  projectConstitutionSnapshotSchema,
  projectsResponseSchema,
  stateCommandResultSchema,
} from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import {
  authenticate,
  bootstrapToken,
  mutationHeaders,
  type AuthenticatedSession,
} from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

describe("Project Constitution HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const setup = async (): Promise<{
    projectId: string;
    projectVersion: number;
    repositoryPath: string;
    session: AuthenticatedSession;
  }> => {
    const root = await mkdtemp(join(tmpdir(), "loomrail constitution api "));
    temporaryDirectories.push(root);
    const repositoryPath = await makeThrowawayRepo(join(root, "existing project"));
    await Promise.all([
      writeFile(
        join(repositoryPath, "package.json"),
        JSON.stringify({ scripts: { verify: "echo private-script-canary" } }),
      ),
      writeFile(join(repositoryPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(join(repositoryPath, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
      writeFile(join(repositoryPath, "tsconfig.json"), "{}\n"),
      writeFile(join(repositoryPath, "AGENTS.md"), "untrusted-instruction-canary\n"),
      writeFile(join(repositoryPath, ".env"), "SECRET=environment-canary\n"),
    ]);

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "state.sqlite"),
    });
    const session = await authenticate(daemon, token);
    const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-constitution-project",
        repositoryPath,
      }),
    });
    expect(registration.status).toBe(200);
    const registered = stateCommandResultSchema.parse(await registration.json());
    if (registered.type !== "PROJECT_REGISTERED") {
      throw new Error("Repository registration did not create a Project");
    }
    const listed = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await listed.json());
    const project = projects.projects.find((candidate) => candidate.id === registered.project.id);
    if (!project) throw new Error("Registered Project was not listed");
    return { projectId: project.id, projectVersion: project.version, repositoryPath, session };
  };

  it("scans without executing or leaking input, then publishes only after owner adoption", async () => {
    const { projectId, projectVersion, repositoryPath, session } = await setup();
    if (!daemon) throw new Error("Daemon did not start");

    const presetsResponse = await fetch(`${daemon.baseUrl}/api/v1/constitution-presets`, {
      headers: { cookie: session.cookie },
    });
    const presets = constitutionPresetsResponseSchema.parse(await presetsResponse.json());
    expect(presets.presets).toHaveLength(3);

    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/constitution/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "scan-without-session",
        expectedProjectVersion: projectVersion,
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const scanResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/constitution/scan`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "scan-constitution-project",
        expectedProjectVersion: projectVersion,
      }),
    });
    expect(scanResponse.status).toBe(200);
    const proposed = stateCommandResultSchema.parse(await scanResponse.json());
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") {
      throw new Error("Expected a Constitution Proposal");
    }
    expect(proposed.proposal.recommendedPresetId).toBe("typescript-pnpm-workspace");
    const serialised = JSON.stringify(proposed);
    expect(serialised).not.toContain("private-script-canary");
    expect(serialised).not.toContain("environment-canary");
    expect(serialised).not.toContain("untrusted-instruction-canary");
    await expect(access(join(repositoryPath, ".loomrail"))).rejects.toThrow();

    const adoption = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/constitution/adopt`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-constitution-project",
        proposalId: proposed.proposal.id,
        expectedProjectVersion: projectVersion,
        expectedProposalVersion: proposed.proposal.version,
      }),
    });
    expect(adoption.status).toBe(200);
    const snapshot = projectConstitutionSnapshotSchema.parse(await adoption.json());
    expect(snapshot.activeConstitution).toMatchObject({ status: "ACTIVE", ordinal: 1 });
    expect(snapshot.pendingConstitution).toBeNull();
    expect(await readFile(join(repositoryPath, ".loomrail", "constitution.md"), "utf8")).toBe(
      proposed.proposal.renderedMarkdown,
    );
  });

  it("records a compare-and-set conflict without overwriting the owner's file", async () => {
    const { projectId, projectVersion, repositoryPath, session } = await setup();
    if (!daemon) throw new Error("Daemon did not start");
    const scanResponse = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/constitution/scan`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "scan-before-race",
        expectedProjectVersion: projectVersion,
      }),
    });
    const proposed = stateCommandResultSchema.parse(await scanResponse.json());
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") {
      throw new Error("Expected a Constitution Proposal");
    }
    await mkdir(join(repositoryPath, ".loomrail"));
    await writeFile(join(repositoryPath, ".loomrail", "constitution.md"), "owner change\n");

    const adoption = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/constitution/adopt`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-after-race",
        proposalId: proposed.proposal.id,
        expectedProjectVersion: projectVersion,
        expectedProposalVersion: proposed.proposal.version,
      }),
    });
    expect(adoption.status).toBe(200);
    const snapshot = projectConstitutionSnapshotSchema.parse(await adoption.json());
    expect(snapshot.activeConstitution).toBeNull();
    expect(snapshot.pendingConstitution).toMatchObject({ status: "FAILED" });
    expect(snapshot.publication).toMatchObject({
      status: "FAILED",
      lastErrorCode: "CONSTITUTION_TARGET_CHANGED",
    });
    expect(await readFile(join(repositoryPath, ".loomrail", "constitution.md"), "utf8")).toBe(
      "owner change\n",
    );
  });
});
