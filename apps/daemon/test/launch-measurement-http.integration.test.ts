import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LaunchBrowserMeasurement, VerificationPlanProposal } from "@loomrail/contracts";
import { launchMeasurementProjectResponseSchema, projectsResponseSchema } from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { verificationPlanProposalHash } from "@loomrail/project-readiness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import type { LaunchServiceStarter } from "../src/launch-measurement-runner.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-09-10T13:00:00.000Z";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const proposalFor = (projectId: string): VerificationPlanProposal => {
  const content: Omit<VerificationPlanProposal, "proposalHash"> = {
    schemaVersion: 1,
    projectId,
    target: { state: "ABSENT", digest: null },
    recipes: [
      {
        schemaVersion: 1,
        id: "package-audit",
        kind: "AUDIT",
        label: "Dependency audit",
        required: true,
        executable: "pnpm",
        argv: ["run", "audit"],
        cwd: ".",
        timeoutSeconds: 300,
        outputLimitBytes: 65_536,
        environmentProfile: "VERIFICATION_BASELINE",
        networkPolicy: "INHERIT_HOST",
        provenance: {
          source: "PACKAGE_JSON_SCRIPT",
          manifestPath: "package.json",
          manifestContentHash: "a".repeat(64),
          scriptName: "audit",
          scriptBodyPreview: "pnpm audit --audit-level high",
        },
      },
      {
        schemaVersion: 1,
        id: "package-start",
        kind: "SERVE",
        label: "Start service",
        required: false,
        executable: "pnpm",
        argv: ["run", "start"],
        cwd: ".",
        timeoutSeconds: 300,
        outputLimitBytes: 65_536,
        environmentProfile: "VERIFICATION_BASELINE",
        networkPolicy: "INHERIT_HOST",
        provenance: {
          source: "PACKAGE_JSON_SCRIPT",
          manifestPath: "package.json",
          manifestContentHash: "a".repeat(64),
          scriptName: "start",
          scriptBodyPreview: "node server.mjs",
        },
      },
    ],
    warnings: [],
  };
  return { ...content, proposalHash: verificationPlanProposalHash(content) };
};

const measurement: LaunchBrowserMeasurement = {
  samples: [
    { lcpMs: 800, inpMs: 40, cls: 0.01, scriptBytes: 10_000 },
    { lcpMs: 900, inpMs: 50, cls: 0.02, scriptBytes: 11_000 },
    { lcpMs: 1_000, inpMs: 60, cls: 0.03, scriptBytes: 12_000 },
  ],
  headers: [
    { name: "content-security-policy", present: true },
    { name: "x-content-type-options", present: true },
  ],
  privateRoutes: [{ path: "/private", statusCode: 401 }],
  secrets: [],
  scannedScriptBytes: 33_000,
  browserName: "CHROMIUM",
  browserVersion: "140.0.0",
};

describe("launch measurement HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  let target: Server | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (target?.listening) await closeServer(target);
    target = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("protects owner controls and returns only typed current-tree launch evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail launch api тест "));
    directories.push(directory);
    const repositoryPath = await makeThrowawayRepo(join(directory, "Recurkit local app"));
    await writeFile(
      join(repositoryPath, "package.json"),
      `${JSON.stringify({ scripts: { audit: "pnpm audit --audit-level high", start: "node server.mjs" } }, null, 2)}\n`,
    );
    await execFileAsync("git", ["add", "package.json"], { cwd: repositoryPath });
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
        "launch fixture",
      ],
      { cwd: repositoryPath },
    );

    const databasePath = join(directory, "state.sqlite");
    const state = await openLocalState({ databasePath, now: () => new Date(timestamp) });
    const projectId = "launch-api-project";
    try {
      state.execute({
        schemaVersion: 1,
        commandId: "register-launch-api-project",
        correlationId: "correlation-register-launch-api-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: projectId,
          fixtureId: null,
          name: "Recurkit",
          repositoryPath,
        },
      });
      state.execute({
        schemaVersion: 1,
        commandId: "adopt-launch-api-verification",
        correlationId: "correlation-adopt-launch-api-verification",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ADOPT_VERIFICATION_PLAN",
        payload: { projectId, expectedProjectVersion: 1, proposal: proposalFor(projectId) },
      });
    } finally {
      state.close();
    }

    target = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      target?.once("error", reject);
      target?.listen(0, "127.0.0.1", resolve);
    });
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("Target port unavailable");

    const startService = vi.fn<LaunchServiceStarter>((input) => {
      let finish: (() => void) | undefined;
      const completion = new Promise<{
        state: "STOPPED";
        errorCode: null;
        beforeTree: string;
        afterTree: string;
        processStopped: true;
        durationMs: number;
        capturedOutputBytes: number;
        outputTruncated: false;
      }>((resolve) => {
        finish = () => {
          resolve({
            state: "STOPPED",
            errorCode: null,
            beforeTree: input.expectedTree,
            afterTree: input.expectedTree,
            processStopped: true,
            durationMs: 10,
            capturedOutputBytes: 0,
            outputTruncated: false,
          });
        };
      });
      return Promise.resolve({
        state: "STARTED",
        beforeTree: input.expectedTree,
        stop: () => finish?.(),
        completion,
      });
    });
    const driver = { id: "PLAYWRIGHT" as const, measure: vi.fn(() => Promise.resolve(measurement)) };
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
      launchMeasurementDriver: driver,
      launchServiceStarter: startService,
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);

    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/launch-measurement`);
    expect(unauthenticated.status).toBe(401);

    const missingCsrf = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-measurement/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: session.cookie, origin: daemon.baseUrl },
        body: JSON.stringify({}),
      },
    );
    expect(missingCsrf.status).toBe(403);

    const configuration = {
      verificationPlanId: "verification-plan-1",
      verificationPlanRevision: 1,
      verificationPlanContentHash: "placeholder",
      startupRecipeId: "package-start",
      dependencyAuditRecipeId: "package-audit",
      targetOrigin: `http://127.0.0.1:${address.port.toString()}`,
      healthPath: "/health/ready",
      probePath: "/",
      privateRoutes: ["/private"],
      samples: 3,
      thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 100_000 },
      requiredHeaders: ["content-security-policy", "x-content-type-options"],
    };
    const verification = await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/verification-plan`, {
      headers: { cookie: session.cookie },
    }).then(
      async (response) =>
        response.json() as Promise<{ plan: { id: string; revision: number; contentHash: string } }>,
    );
    configuration.verificationPlanId = verification.plan.id;
    configuration.verificationPlanRevision = verification.plan.revision;
    configuration.verificationPlanContentHash = verification.plan.contentHash;
    const projects = projectsResponseSchema.parse(
      await fetch(`${daemon.baseUrl}/api/v1/projects`, { headers: { cookie: session.cookie } }).then(
        async (response) => response.json(),
      ),
    );
    const project = projects.projects.find(({ id }) => id === projectId);
    if (project === undefined) throw new Error("Seeded project unavailable");

    const adoptedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-measurement/plan`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "adopt-launch-api-plan",
          expectedProjectVersion: project.version,
          configuration,
        }),
      },
    );
    expect(adoptedResponse.status).toBe(200);
    const adopted = launchMeasurementProjectResponseSchema.parse(await adoptedResponse.json());
    expect(adopted.plan).toMatchObject({ status: "ACTIVE", revision: 1 });

    const startedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-measurement/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "start-launch-api-run",
          expectedPlanRevision: adopted.plan?.revision,
          expectedPlanContentHash: adopted.plan?.contentHash,
        }),
      },
    );
    expect(startedResponse.status).toBe(200);
    expect(launchMeasurementProjectResponseSchema.parse(await startedResponse.json()).latestRun?.status).toBe(
      "RUNNING",
    );
    await daemon.whenIdle();

    const completedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/launch-measurement`,
      { headers: { cookie: session.cookie } },
    );
    const completedBody = await completedResponse.text();
    expect(completedBody).not.toContain("server.mjs");
    const completed = launchMeasurementProjectResponseSchema.parse(JSON.parse(completedBody));
    expect(completed.latestRun).toMatchObject({ status: "FAILED", errorCode: null });
    expect(completed.latestRun?.results).toHaveLength(6);
    expect(completed.latestRun?.results.find(({ key }) => key === "DEPS_AUDIT")?.status).toBe(
      "ACTION_REQUIRED",
    );
    expect(completed.freshness).toEqual({ status: "CURRENT", reasons: [] });
    expect(startService).toHaveBeenCalledOnce();
    expect(driver.measure).toHaveBeenCalledOnce();
  });
});
