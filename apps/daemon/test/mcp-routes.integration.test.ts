import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apiErrorResponseSchema,
  mcpProfileProposalSchema,
  mcpProfilesResponseSchema,
  projectsResponseSchema,
  stateCommandResultSchema,
} from "@loomrail/contracts";
import type { McpGateway } from "@loomrail/mcp-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import {
  authenticate,
  bootstrapToken,
  mutationHeaders,
  type AuthenticatedSession,
} from "./daemon-fixtures.js";

describe("daemon MCP profile routes", () => {
  let daemon: RunningDaemon | undefined;
  let directory = "";
  let session: AuthenticatedSession;
  let projectVersion = 0;
  const resolveCandidate = vi.fn<McpGateway["resolveCandidate"]>((candidate) => Promise.resolve(candidate));
  const probe = vi.fn<McpGateway["probe"]>(() =>
    Promise.resolve({
      state: "READY",
      protocolVersion: "2026-07-28",
      tools: ["read_docs", "search_docs"],
      resources: ["project_docs"],
      prompts: [],
    }),
  );
  const open = vi.fn<McpGateway["open"]>(() =>
    Promise.resolve({ connections: [], close: () => Promise.resolve() }),
  );
  const recoverOrphans = vi.fn<McpGateway["recoverOrphans"]>(() => Promise.resolve([]));
  const revoke = vi.fn<McpGateway["revoke"]>();
  const close = vi.fn<McpGateway["close"]>(() => Promise.resolve());
  const shutdown = vi.fn<McpGateway["shutdown"]>(() => Promise.resolve());

  beforeEach(async () => {
    resolveCandidate.mockClear();
    probe.mockClear();
    recoverOrphans.mockClear();
    open.mockClear();
    revoke.mockClear();
    close.mockClear();
    shutdown.mockClear();
    directory = await mkdtemp(join(tmpdir(), "loomrail MCP daemon "));
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      stateDatabasePath: join(directory, "state.sqlite"),
      demoProjectsRoot: join(directory, "demo projects"),
      workspacesRoot: join(directory, "workspaces"),
      port: 0,
      logger: false,
      mcpGateway: { resolveCandidate, probe, recoverOrphans, open, revoke, close, shutdown },
    });
    session = await authenticate(daemon, token);
    const registered = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-mcp-route-project",
        fixtureId: "web-app-a",
      }),
    });
    expect(registered.status).toBe(200);
    const listed = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { cookie: session.cookie },
    });
    const projects = projectsResponseSchema.parse(await listed.json());
    const project = projects.projects.find(({ id }) => id === "project-fixture-web-app-a");
    if (!project) throw new Error("MCP route test Project was not registered");
    projectVersion = project.version;
  });

  afterEach(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const candidate = {
    profileId: null,
    name: "Project docs",
    executable: "/opt/loomrail/docs-mcp",
    args: ["--read-only"],
    declaredTools: ["search_docs", "read_docs"],
  };

  const propose = async () => {
    if (!daemon) throw new Error("Daemon not started");
    const response = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          expectedProjectVersion: projectVersion,
          candidate,
        }),
      },
    );
    expect(response.status).toBe(200);
    return mcpProfileProposalSchema.parse(await response.json());
  };

  it("runs proposal, one-shot consent, probe, grant and revoke without accepting spawn data on probe", async () => {
    if (!daemon) throw new Error("Daemon not started");
    const proposal = await propose();
    expect(resolveCandidate).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(proposal.candidate.declaredTools).toEqual(["search_docs", "read_docs"]);

    const confirmation = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals/${proposal.challengeId}/confirm`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "confirm-mcp-profile",
          expectedProjectVersion: projectVersion,
          challengeId: proposal.challengeId,
          canonicalDigest: proposal.canonicalDigest,
        }),
      },
    );
    expect(confirmation.status).toBe(200);
    const confirmed = stateCommandResultSchema.parse(await confirmation.json());
    if (confirmed.type !== "MCP_PROFILE_CONSENTED") throw new Error("MCP profile was not consented");
    projectVersion = confirmed.projectVersion;

    const replay = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals/${proposal.challengeId}/confirm`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "confirm-mcp-profile-again",
          expectedProjectVersion: projectVersion - 1,
          challengeId: proposal.challengeId,
          canonicalDigest: proposal.canonicalDigest,
        }),
      },
    );
    expect(replay.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await replay.json()).error.code).toBe("MCP_PROPOSAL_CONSUMED");

    const injectedSpawnPayload = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profiles/${confirmed.revision.id}/probe`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "probe-with-injected-command",
          executable: "/bin/sh",
          args: ["-c", "exit 0"],
        }),
      },
    );
    expect(injectedSpawnPayload.status).toBe(400);
    expect(probe).not.toHaveBeenCalled();

    const probedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profiles/${confirmed.revision.id}/probe`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({ schemaVersion: 1, commandId: "probe-mcp-profile" }),
      },
    );
    expect(probedResponse.status).toBe(200);
    const probed = stateCommandResultSchema.parse(await probedResponse.json());
    expect(probed).toMatchObject({ type: "MCP_CAPABILITY_RECORDED", snapshot: { state: "READY" } });
    expect(probe).toHaveBeenCalledWith(confirmed.revision, confirmed.consent);

    const grantResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profiles/${confirmed.revision.id}/grant`,
      {
        method: "PUT",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "grant-mcp-profile",
          expectedProjectVersion: projectVersion,
          expectedGrantVersion: null,
          tools: ["read_docs"],
          ownerAttestsReadOnly: true,
        }),
      },
    );
    expect(grantResponse.status).toBe(200);
    const granted = stateCommandResultSchema.parse(await grantResponse.json());
    if (granted.type !== "MCP_GRANT_CHANGED") throw new Error("MCP grant was not recorded");
    expect(granted.grant).toMatchObject({ enabled: true, version: 1, tools: ["read_docs"] });
    projectVersion = granted.projectVersion;

    const profilesResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profiles`,
      { headers: { cookie: session.cookie } },
    );
    const profiles = mcpProfilesResponseSchema.parse(await profilesResponse.json());
    expect(profiles).toMatchObject({
      projectVersion,
      profiles: [{ capability: { state: "READY" }, grant: { enabled: true } }],
    });

    const revokeResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profiles/${confirmed.revision.id}/grant`,
      {
        method: "DELETE",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "revoke-mcp-profile",
          expectedProjectVersion: projectVersion,
          expectedGrantVersion: 1,
        }),
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(stateCommandResultSchema.parse(await revokeResponse.json())).toMatchObject({
      type: "MCP_GRANT_CHANGED",
      grant: { enabled: false, version: 2 },
    });
    expect(revoke).toHaveBeenCalledWith(granted.grant.id);
  });

  it("builds the Context7 proposal on the server and rejects injected spawn fields", async () => {
    if (!daemon) throw new Error("Daemon not started");
    const endpoint = `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-presets/context7/proposal`;
    const injected = await fetch(endpoint, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({
        schemaVersion: 1,
        expectedProjectVersion: projectVersion,
        executable: "/bin/sh",
        args: ["-c", "exit 0"],
      }),
    });
    expect(injected.status).toBe(400);
    expect(resolveCandidate).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: mutationHeaders(daemon, session),
      body: JSON.stringify({ schemaVersion: 1, expectedProjectVersion: projectVersion }),
    });
    expect(response.status).toBe(200);
    const proposal = mcpProfileProposalSchema.parse(await response.json());
    expect(proposal.candidate).toMatchObject({
      profileId: null,
      name: "Context7",
      executable: process.execPath,
      declaredTools: ["query-docs", "resolve-library-id"],
    });
    expect(proposal.candidate.args.slice(1)).toEqual(["--transport", "stdio"]);
    expect(proposal.candidate.args[0]).toMatch(/[/\\]@upstash[/\\]context7-mcp[/\\]dist[/\\]index\.js$/u);
    expect(resolveCandidate).toHaveBeenCalledExactlyOnceWith(proposal.candidate);
  });

  it("requires CSRF and Origin and burns a digest-mismatched proposal", async () => {
    if (!daemon) throw new Error("Daemon not started");
    const forbidden = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ schemaVersion: 1, expectedProjectVersion: projectVersion, candidate }),
      },
    );
    expect(forbidden.status).toBe(403);
    expect(resolveCandidate).not.toHaveBeenCalled();

    const proposal = await propose();
    const mismatch = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals/${proposal.challengeId}/confirm`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "confirm-wrong-digest",
          expectedProjectVersion: projectVersion,
          challengeId: proposal.challengeId,
          canonicalDigest: "f".repeat(64),
        }),
      },
    );
    expect(mismatch.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await mismatch.json()).error.code).toBe("MCP_PROPOSAL_MISMATCH");

    const afterMismatch = await fetch(
      `${daemon.baseUrl}/api/v1/projects/project-fixture-web-app-a/mcp-profile-proposals/${proposal.challengeId}/confirm`,
      {
        method: "POST",
        headers: mutationHeaders(daemon, session),
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "confirm-after-wrong-digest",
          expectedProjectVersion: projectVersion,
          challengeId: proposal.challengeId,
          canonicalDigest: proposal.canonicalDigest,
        }),
      },
    );
    expect(afterMismatch.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await afterMismatch.json()).error.code).toBe("MCP_PROPOSAL_CONSUMED");
  });
});
