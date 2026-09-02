import process from "node:process";

import { startDaemon } from "../../dist/server.js";

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

const stateDatabasePath = requiredEnvironment("LOOMRAIL_CRASH_STATE");
const demoProjectsRoot = requiredEnvironment("LOOMRAIL_CRASH_DEMOS");
const bootstrapToken = requiredEnvironment("LOOMRAIL_CRASH_TOKEN");

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const capabilities = {
  provider: "MOCK",
  start: true,
  interrupt: true,
  eventStream: false,
  usageReporting: false,
  contextWindowReporting: false,
  checkpointOnRequest: false,
  contextWindowTokens: 128_000,
  stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
  costReporting: false,
};

const blockingAdapter = {
  capabilities: () => capabilities,
  start: (invocation) => {
    writeMessage({ type: "PROVIDER_STARTED", sessionId: invocation.session.id });
    return new Promise(() => undefined);
  },
  requestHandoff: () => Promise.resolve(),
  abortSession: () => Promise.resolve(),
};

// Fixed providerAdapter means production routing never calls resolve in this drill. Keeping a
// no-probe registry nevertheless makes startup independent of whichever real CLIs the CI host has
// installed or authenticated.
const providerRegistry = {
  refresh: () => Promise.resolve(),
  availability: () => [],
  resolve: () => {
    throw new Error("The crash fixture must not route through a live provider registry");
  },
  environment: { override: "MOCK", invalid: false, requested: "MOCK" },
};

const daemon = await startDaemon({
  bootstrapToken,
  stateDatabasePath,
  demoProjectsRoot,
  logger: false,
  providerAdapter: blockingAdapter,
  providerRegistry,
});

writeMessage({ type: "READY", baseUrl: daemon.baseUrl });

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await daemon.close();
  writeMessage({ type: "STOPPED" });
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
