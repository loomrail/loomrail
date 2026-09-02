#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "@loomrail/daemon";
import open from "open";

import { resolveLoomrailDataDirectory } from "./app-data.js";
import { collectDoctorReport, formatCliHelp, formatDoctorReport, serializeDoctorReport } from "./doctor.js";
import { parseCliCommand, type StartCliCommand } from "./options.js";
import { formatStartupReport } from "./startup-report.js";

const writeLine = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const start = async (options: StartCliCommand): Promise<void> => {
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
    provider: daemon.provider,
  })) {
    writeLine(line);
  }
};

const run = async (): Promise<void> => {
  const command = parseCliCommand(process.argv.slice(2));
  switch (command.command) {
    case "START":
      await start(command);
      return;
    case "DOCTOR": {
      const report = await collectDoctorReport();
      if (command.format === "JSON") {
        writeLine(serializeDoctorReport(report));
      } else {
        for (const reportLine of formatDoctorReport(report)) writeLine(reportLine);
      }
      if (report.status === "FAIL") process.exitCode = 1;
      return;
    }
    case "DATA_PATH":
      writeLine(resolveLoomrailDataDirectory());
      return;
    case "HELP":
      for (const helpLine of formatCliHelp()) writeLine(helpLine);
      return;
  }
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Loomrail failure";
  process.stderr.write(`Loomrail failed: ${message}\n`);
  process.exitCode = 1;
});
