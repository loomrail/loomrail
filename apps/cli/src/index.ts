#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "@loomrail/daemon";
import open from "open";

import { resolveLoomrailDataDirectory } from "./app-data.js";
import { parseCliOptions } from "./options.js";
import { formatStartupReport } from "./startup-report.js";

const writeLine = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const run = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));
  const bootstrapToken = randomBytes(32).toString("base64url");
  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const stateDatabasePath = join(resolveLoomrailDataDirectory(), "state.sqlite");
  const daemon = await startDaemon({
    bootstrapToken,
    stateDatabasePath,
    webRoot,
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    writeLine(`Loomrail received ${signal}; shutting down.`);
    await daemon.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  let browserOpened = false;
  if (!options.noOpen) {
    await open(daemon.bootstrapUrl, { wait: false });
    browserOpened = true;
  }

  for (const line of formatStartupReport({
    baseUrl: daemon.baseUrl,
    bootstrapUrl: daemon.bootstrapUrl,
    browserOpened,
  })) {
    writeLine(line);
  }
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  process.stderr.write(`Loomrail failed to start: ${message}\n`);
  process.exitCode = 1;
});
