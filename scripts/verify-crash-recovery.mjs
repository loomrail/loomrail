import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  agentFleetResponseSchema,
  eventsResponseSchema,
  providerSessionsResponseSchema,
  sessionExchangeResponseSchema,
  stateCommandResultSchema,
  workflowSnapshotSchema,
} from "../packages/contracts/dist/index.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureEntrypoint = resolve(repositoryRoot, "apps/daemon/test/fixtures/crash-daemon.mjs");
const WAIT_MS = 30_000;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const bootstrapToken = () => randomBytes(32).toString("base64url");

const childEnvironment = (values) => {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
    NODE_ENV: "test",
    ...values,
  };
};

const withTimeout = async (promise, description) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), WAIT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const startFixture = async ({ stateDatabasePath, demoProjectsRoot, bootstrapToken }) => {
  const child = spawn(process.execPath, [fixtureEntrypoint], {
    cwd: repositoryRoot,
    env: childEnvironment({
      LOOMRAIL_CRASH_STATE: stateDatabasePath,
      LOOMRAIL_CRASH_DEMOS: demoProjectsRoot,
      LOOMRAIL_CRASH_TOKEN: bootstrapToken,
    }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  const queued = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex(({ type }) => type === message.type);
    if (waiterIndex === -1) {
      queued.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    waiter.resolve(message);
  });
  child.once("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.once("exit", (code, signal) => {
    lines.close();
    const detail = stderr.length === 0 ? "no stderr" : stderr;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(
        new Error(
          `Crash fixture exited before ${waiter.type}: code=${String(code)}, signal=${String(signal)}; ${detail}`,
        ),
      );
    }
  });

  const waitFor = (type) => {
    const queuedIndex = queued.findIndex((message) => message.type === type);
    if (queuedIndex !== -1) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    return withTimeout(
      new Promise((resolveMessage, rejectMessage) => {
        waiters.push({ type, resolve: resolveMessage, reject: rejectMessage });
      }),
      type,
    );
  };

  const ready = await waitFor("READY");
  assert(typeof ready.baseUrl === "string", "Crash fixture did not report a base URL");
  return { child, baseUrl: ready.baseUrl, waitFor, stderr: () => stderr };
};

const stopChild = async (fixture, signal) => {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) return;
  const exited = once(fixture.child, "exit");
  const signalled = fixture.child.kill(signal);
  assert(signalled, `Could not send ${signal} to the exact crash-fixture child`);
  await withTimeout(exited, `${signal} child exit`);
};

const authenticate = async (baseUrl, bootstrapToken) => {
  const response = await fetch(`${baseUrl}/api/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ bootstrapToken }),
  });
  assert(response.ok, `Session exchange failed with ${response.status.toString()}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie !== undefined, "Session exchange did not return a cookie");
  const session = sessionExchangeResponseSchema.parse(await response.json());
  return { cookie, csrfToken: session.csrfToken };
};

const mutationHeaders = (baseUrl, session) => ({
  "content-type": "application/json",
  cookie: session.cookie,
  origin: baseUrl,
  "x-loomrail-csrf": session.csrfToken,
});

const post = async (baseUrl, session, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: mutationHeaders(baseUrl, session),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Mutation ${path} failed with ${response.status.toString()}: ${await response.text()}`);
  }
  return response.json();
};

const seedRunningSession = async (fixture, bootstrapToken) => {
  const session = await authenticate(fixture.baseUrl, bootstrapToken);
  await post(fixture.baseUrl, session, "/api/v1/projects/fixtures/register", {
    schemaVersion: 1,
    commandId: "crash-register-fixture",
    fixtureId: "web-app-a",
  });
  const created = stateCommandResultSchema.parse(
    await post(fixture.baseUrl, session, "/api/v1/work-items", {
      schemaVersion: 1,
      commandId: "crash-create-item",
      projectId: "project-fixture-web-app-a",
      type: "TASK",
      title: "Recover an abruptly interrupted provider session",
      acceptanceCriteria: ["One durable interruption is visible after process restart."],
    }),
  );
  assert(created.type === "WORK_ITEM_CREATED", "Crash drill did not create its WorkItem");
  await post(fixture.baseUrl, session, `/api/v1/work-items/${created.workItem.id}/move`, {
    schemaVersion: 1,
    commandId: "crash-ready-item",
    expectedVersion: 1,
    targetState: "READY",
  });
  await post(fixture.baseUrl, session, `/api/v1/work-items/${created.workItem.id}/pipeline/start`, {
    schemaVersion: 1,
    commandId: "crash-start-pipeline",
    expectedVersion: 2,
  });
  await fixture.waitFor("PROVIDER_STARTED");
  return created.workItem.id;
};

const readRecoveredState = async (fixture, bootstrapToken, workItemId) => {
  const session = await authenticate(fixture.baseUrl, bootstrapToken);
  const headers = { cookie: session.cookie };
  const workflowResponse = await fetch(`${fixture.baseUrl}/api/v1/work-items/${workItemId}/workflow`, {
    headers,
  });
  assert(workflowResponse.ok, `Workflow read failed with ${workflowResponse.status.toString()}`);
  const snapshot = workflowSnapshotSchema.parse(await workflowResponse.json());
  const stageAttemptId = snapshot.stageAttempts[0]?.id;
  assert(stageAttemptId !== undefined, "Recovered workflow did not contain a StageAttempt");

  const sessionsResponse = await fetch(
    `${fixture.baseUrl}/api/v1/stage-attempts/${stageAttemptId}/sessions`,
    { headers },
  );
  assert(sessionsResponse.ok, `Provider-session read failed with ${sessionsResponse.status.toString()}`);
  const providerSessions = providerSessionsResponseSchema.parse(await sessionsResponse.json());

  const fleetResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-fleet`, { headers });
  assert(fleetResponse.ok, `Agent-fleet read failed with ${fleetResponse.status.toString()}`);
  const fleet = agentFleetResponseSchema.parse(await fleetResponse.json());

  const eventsResponse = await fetch(
    `${fixture.baseUrl}/api/v1/events?aggregateId=${encodeURIComponent(workItemId)}&limit=500`,
    { headers },
  );
  assert(eventsResponse.ok, `Event read failed with ${eventsResponse.status.toString()}`);
  const events = eventsResponseSchema.parse(await eventsResponse.json());
  assert(!events.hasMore, "Crash drill exceeded its bounded event page");
  return { snapshot, providerSessions, fleet, events };
};

const assertRecoveredOnce = ({ snapshot, providerSessions, fleet, events }) => {
  assert(snapshot.run?.status === "INTERRUPTED", "PipelineRun was not interrupted after daemon crash");
  assert(snapshot.stageAttempts.length === 1, "Crash drill produced an unexpected StageAttempt count");
  assert(
    snapshot.stageAttempts[0]?.status === "INTERRUPTED" &&
      snapshot.stageAttempts[0]?.failureCode === "DAEMON_RESTART",
    "Active StageAttempt did not retain the DAEMON_RESTART interruption",
  );
  assert(snapshot.recoveryReports.length === 1, "Daemon restart did not produce exactly one RecoveryReport");
  assert(
    snapshot.recoveryReports[0]?.reason === "DAEMON_RESTART",
    "RecoveryReport did not retain its daemon-restart reason",
  );
  assert(
    events.events.filter(({ type }) => type === "RECOVERY_REPORT_CREATED").length === 1,
    "Daemon restart did not retain exactly one recovery Event",
  );
  assert(
    providerSessions.sessions.every(({ status }) => status !== "RUNNING"),
    "A ProviderSession remained active after startup reconciliation",
  );
  assert(
    fleet.capacity.active === 0 && fleet.entries.every(({ status }) => status !== "RUNNING"),
    "An AgentRun remained active after startup reconciliation",
  );
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail crash drill "));
const stateDatabasePath = join(temporaryDirectory, "state.sqlite");
const demoProjectsRoot = join(temporaryDirectory, "demo-projects");
const liveFixtures = new Set();

try {
  const firstToken = bootstrapToken();
  const first = await startFixture({ stateDatabasePath, demoProjectsRoot, bootstrapToken: firstToken });
  liveFixtures.add(first);
  const workItemId = await seedRunningSession(first, firstToken);
  await stopChild(first, "SIGKILL");
  liveFixtures.delete(first);

  const secondToken = bootstrapToken();
  const second = await startFixture({ stateDatabasePath, demoProjectsRoot, bootstrapToken: secondToken });
  liveFixtures.add(second);
  assertRecoveredOnce(await readRecoveredState(second, secondToken, workItemId));
  await stopChild(second, "SIGTERM");
  liveFixtures.delete(second);

  const thirdToken = bootstrapToken();
  const third = await startFixture({ stateDatabasePath, demoProjectsRoot, bootstrapToken: thirdToken });
  liveFixtures.add(third);
  assertRecoveredOnce(await readRecoveredState(third, thirdToken, workItemId));
  await stopChild(third, "SIGTERM");
  liveFixtures.delete(third);

  process.stdout.write("Crash-recovery drill passed: one interrupted run, no replay, one durable report.\n");
} finally {
  await Promise.all(
    [...liveFixtures].map((fixture) =>
      stopChild(fixture, "SIGKILL").catch((error) => {
        process.stderr.write(`Crash-fixture cleanup failed: ${String(error)}\n`);
      }),
    ),
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
}
