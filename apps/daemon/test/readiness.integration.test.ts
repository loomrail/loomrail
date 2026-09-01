import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  projectConstitutionSnapshotSchema,
  projectReadinessSnapshotSchema,
  stateCommandResultSchema,
} from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

const execFileAsync = promisify(execFile);

describe("Project Readiness HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  let root = "";

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (root) await rm(root, { force: true, recursive: true });
  });

  it("runs an authenticated local preflight and persists owner attestations to READY", async () => {
    root = await mkdtemp(join(tmpdir(), "loomrail readiness api "));
    const repositoryPath = await makeThrowawayRepo(join(root, "owner project"));
    await writeFile(join(repositoryPath, ".gitignore"), ".env*\n.npmrc\n");
    await writeFile(join(repositoryPath, "LICENSE"), "test license\n");
    await execFileAsync("git", ["add", ".gitignore", "LICENSE"], { cwd: repositoryPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=loomrail-test@example.com",
        "-c",
        "user.name=Loomrail Test",
        "commit",
        "--quiet",
        "-m",
        "readiness inputs",
      ],
      { cwd: repositoryPath },
    );

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(root, "state.sqlite"),
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);
    const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ schemaVersion: 1, commandId: "register-readiness", repositoryPath }),
    });
    const registered = stateCommandResultSchema.parse(await registration.json());
    if (registered.type !== "PROJECT_REGISTERED") throw new Error("Project was not registered");

    const scan = await fetch(`${daemon.baseUrl}/api/v1/projects/${registered.project.id}/constitution/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "scan-readiness-constitution",
        expectedProjectVersion: registered.project.version,
      }),
    });
    const proposal = stateCommandResultSchema.parse(await scan.json());
    if (proposal.type !== "PROJECT_CONSTITUTION_PROPOSED") throw new Error("Constitution was not proposed");
    const adopted = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${registered.project.id}/constitution/adopt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "adopt-readiness-constitution",
          proposalId: proposal.proposal.id,
          expectedProjectVersion: registered.project.version,
          expectedProposalVersion: proposal.proposal.version,
        }),
      },
    );
    expect(projectConstitutionSnapshotSchema.parse(await adopted.json()).activeConstitution).not.toBeNull();

    const unauthenticated = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${registered.project.id}/readiness/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "run-without-session",
          expectedProjectVersion: registered.project.version,
        }),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const runResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${registered.project.id}/readiness/run`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "run-readiness",
          expectedProjectVersion: registered.project.version,
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    let snapshot = projectReadinessSnapshotSchema.parse(await runResponse.json());
    expect(snapshot.run).toMatchObject({ status: "ACTION_REQUIRED", workingTreeDirty: true });
    expect(snapshot.checks.filter((check) => check.mode === "AUTOMATED")).toSatisfy(
      (checks: typeof snapshot.checks) => checks.every((check) => check.status === "PASSED"),
    );

    for (const [key, outcome] of [
      ["LEGAL_OWNER_REVIEW", "CONFIRMED"],
      ["PAYMENTS_OWNER_REVIEW", "NOT_APPLICABLE"],
      ["ANALYTICS_OWNER_REVIEW", "NOT_APPLICABLE"],
    ] as const) {
      const run = snapshot.run;
      const check = snapshot.checks.find((candidate) => candidate.key === key);
      if (!run || !check) throw new Error(`Missing ${key}`);
      const response = await fetch(
        `${daemon.baseUrl}/api/v1/projects/${registered.project.id}/readiness/attest`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaVersion: 1,
            commandId: `attest-${key}`,
            runId: run.id,
            checkId: check.id,
            expectedRunVersion: run.version,
            outcome,
            rationale: `Owner reviewed ${key}`,
          }),
        },
      );
      expect(response.status).toBe(200);
      snapshot = projectReadinessSnapshotSchema.parse(await response.json());
    }

    expect(snapshot.run).toMatchObject({ status: "READY", version: 4 });
    expect(snapshot.attestations).toHaveLength(3);
    const fetched = await fetch(`${daemon.baseUrl}/api/v1/projects/${registered.project.id}/readiness`, {
      headers: { cookie: session.cookie },
    });
    expect(projectReadinessSnapshotSchema.parse(await fetched.json()).run).toMatchObject({ status: "READY" });
  });
});
