#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { startDaemon } from "@loomrail/daemon";
import open from "open";

import { resolveLoomrailDataDirectory } from "./app-data.js";
import { collectDoctorReport, formatCliHelp, formatDoctorReport, serializeDoctorReport } from "./doctor.js";
import {
  deleteLocalLogs,
  exportLocalLogs,
  openLocalLogWriter,
  redactOperationalText,
} from "./log-lifecycle.js";
import { parseCliCommand, type StartCliCommand } from "./options.js";
import {
  collectSetupReadiness,
  formatSetupReadiness,
  selectSetupRoute,
  serializeSetupReadiness,
  setupRoutePrompt,
  type SetupRoute,
} from "./setup.js";
import { formatStartupReport } from "./startup-report.js";

const writeLine = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const writeFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : "Unknown Loomrail failure";
  process.stderr.write(`Loomrail failed: ${redactOperationalText(message)}\n`);
};

const start = async (options: StartCliCommand): Promise<void> => {
  const bootstrapToken = randomBytes(32).toString("base64url");
  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const dataDirectory = resolveLoomrailDataDirectory();
  const stateDatabasePath = join(dataDirectory, "state.sqlite");
  const localLogs = await openLocalLogWriter(dataDirectory);
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      bootstrapToken,
      loggerStream: { write: (message) => void localLogs.stream.write(message) },
      stateDatabasePath,
      webRoot,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error: unknown) {
    await localLogs.close().catch(() => undefined);
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal?: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    if (signal !== undefined) writeLine(`Loomrail received ${signal}; shutting down.`);
    shutdownPromise = (async () => {
      try {
        await daemon.close();
      } finally {
        await localLogs.close();
      }
    })();
    return shutdownPromise;
  };
  const terminateForSignal = (signal: string): void => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        writeFailure(error);
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", () => {
    terminateForSignal("SIGINT");
  });
  process.once("SIGTERM", () => {
    terminateForSignal("SIGTERM");
  });

  void localLogs.failed.then((error) => {
    writeFailure(error);
    process.exitCode = 1;
    void shutdown().catch((shutdownError: unknown) => {
      writeFailure(shutdownError);
    });
  });

  try {
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
  } catch (error: unknown) {
    await shutdown().catch(() => undefined);
    throw error;
  }
};

const chooseSetupRoute = async (): Promise<SetupRoute> => {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("setup requires --mode mock or --mode live outside an interactive terminal");
  }
  for (const promptLine of setupRoutePrompt()) writeLine(promptLine);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await selectSetupRoute((prompt) => terminal.question(prompt));
  } finally {
    terminal.close();
  }
};

const run = async (): Promise<void> => {
  const command = parseCliCommand(process.argv.slice(2));
  switch (command.command) {
    case "START":
      await start(command);
      return;
    case "SETUP": {
      const route = command.route ?? (await chooseSetupRoute());
      const report = await collectSetupReadiness(route);
      if (command.format === "JSON") {
        writeLine(serializeSetupReadiness(report));
      } else {
        for (const reportLine of formatSetupReadiness(report)) writeLine(reportLine);
      }
      if (report.status === "BLOCKED") process.exitCode = 1;
      return;
    }
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
    case "LOGS_EXPORT": {
      const exported = await exportLocalLogs(resolveLoomrailDataDirectory());
      process.stdout.write(exported.ndjson);
      return;
    }
    case "LOGS_DELETE": {
      const deleted = await deleteLocalLogs(resolveLoomrailDataDirectory());
      writeLine(
        `Deleted ${deleted.files.toString()} local log segment(s), ${deleted.bytes.toString()} bytes.`,
      );
      return;
    }
    case "HELP":
      for (const helpLine of formatCliHelp()) writeLine(helpLine);
      return;
  }
};

run().catch((error: unknown) => {
  writeFailure(error);
  process.exitCode = 1;
});
