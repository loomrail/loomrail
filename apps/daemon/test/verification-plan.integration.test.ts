import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apiErrorResponseSchema,
  stateCommandResultSchema,
  verificationPlanSettingsResponseSchema,
} from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

describe("Project verification Plan HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  let root = "";

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail verification api "));
    const repositoryPath = await makeThrowawayRepo(join(root, "project with spaces-ёж"));
    const executionMarker = join(repositoryPath, "must-not-exist");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.17.1",
        scripts: { test: `touch ${executionMarker}`, preinstall: "dangerous-lifecycle" },
      }),
    );
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "state.sqlite"),
    });
    const session = await authenticate(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-project", repositoryPath }),
    });
    const registered = stateCommandResultSchema.parse(await response.json());
    if (registered.type !== "PROJECT_REGISTERED") throw new Error("Project was not registered");
    return { repositoryPath, executionMarker, session, project: registered.project };
  };

  it("previews inert exact argv and publishes only after authenticated owner adoption", async () => {
    const { repositoryPath, executionMarker, session, project } = await setup();
    if (!daemon) throw new Error("Daemon did not start");
    const route = `${daemon.baseUrl}/api/v1/projects/${project.id}/verification-plan`;

    const unauthenticated = await fetch(route);
    expect(unauthenticated.status).toBe(401);

    const previewResponse = await fetch(route, { headers: { cookie: session.cookie } });
    expect(previewResponse.status).toBe(200);
    const preview = verificationPlanSettingsResponseSchema.parse(await previewResponse.json());
    expect(preview.projectVersion).toBe(project.version);
    expect(preview.plan).toBeNull();
    expect(preview.publication).toBeNull();
    expect(preview.proposal.recipes).toHaveLength(1);
    expect(preview.proposal.recipes[0]?.executable).toBe("pnpm");
    expect(preview.proposal.recipes[0]?.argv).toEqual(["run", "test"]);
    expect(preview.proposal.recipes[0]?.provenance.scriptBodyPreview).toBe(`touch ${executionMarker}`);
    expect(JSON.stringify(preview)).not.toContain("dangerous-lifecycle");
    await expect(access(executionMarker)).rejects.toThrow();
    await expect(access(join(repositoryPath, ".loomrail"))).rejects.toThrow();

    const forbidden = await fetch(`${route}/adopt`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-without-origin",
        expectedProjectVersion: preview.projectVersion,
        proposalHash: preview.proposal.proposalHash,
      }),
    });
    expect(forbidden.status).toBe(403);

    const adoption = await fetch(`${route}/adopt`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-verification-plan",
        expectedProjectVersion: preview.projectVersion,
        proposalHash: preview.proposal.proposalHash,
      }),
    });
    expect(adoption.status).toBe(200);
    const settings = verificationPlanSettingsResponseSchema.parse(await adoption.json());
    expect(settings).toMatchObject({
      projectVersion: project.version + 1,
      plan: { revision: 1, status: "ACTIVE" },
      publication: { status: "APPLIED", attempts: 1 },
    });
    expect(
      JSON.parse(await readFile(join(repositoryPath, ".loomrail", "verification-plan.json"), "utf8")),
    ).toEqual(settings.plan);
    await expect(access(executionMarker)).rejects.toThrow();
  });

  it("rescans at adoption and rejects a stale preview before creating durable authority", async () => {
    const { repositoryPath, session, project } = await setup();
    if (!daemon) throw new Error("Daemon did not start");
    const route = `${daemon.baseUrl}/api/v1/projects/${project.id}/verification-plan`;
    const preview = verificationPlanSettingsResponseSchema.parse(
      await (await fetch(route, { headers: { cookie: session.cookie } })).json(),
    );
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.17.1", scripts: { test: "changed command" } }),
    );

    const adoption = await fetch(`${route}/adopt`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-stale-preview",
        expectedProjectVersion: preview.projectVersion,
        proposalHash: preview.proposal.proposalHash,
      }),
    });

    expect(adoption.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await adoption.json()).error.code).toBe("PROPOSAL_HASH_MISMATCH");
    const current = verificationPlanSettingsResponseSchema.parse(
      await (await fetch(route, { headers: { cookie: session.cookie } })).json(),
    );
    expect(current.plan).toBeNull();
    await expect(access(join(repositoryPath, ".loomrail"))).rejects.toThrow();
  });

  it("preserves an unknown owner file and refuses adoption", async () => {
    const { repositoryPath, session, project } = await setup();
    if (!daemon) throw new Error("Daemon did not start");
    await mkdir(join(repositoryPath, ".loomrail"));
    const ownerContent = '{"owner":"keep me"}\n';
    await writeFile(join(repositoryPath, ".loomrail", "verification-plan.json"), ownerContent);
    const route = `${daemon.baseUrl}/api/v1/projects/${project.id}/verification-plan`;
    const preview = verificationPlanSettingsResponseSchema.parse(
      await (await fetch(route, { headers: { cookie: session.cookie } })).json(),
    );

    expect(preview.proposal.target.state).toBe("BLOCKED");
    const adoption = await fetch(`${route}/adopt`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "adopt-blocked-target",
        expectedProjectVersion: preview.projectVersion,
        proposalHash: preview.proposal.proposalHash,
      }),
    });
    expect(adoption.status).toBe(409);
    expect(await readFile(join(repositoryPath, ".loomrail", "verification-plan.json"), "utf8")).toBe(
      ownerContent,
    );
  });
});
