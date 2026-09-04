import { parseArgs } from "node:util";

export type StartCliCommand = {
  command: "START";
  noOpen: boolean;
  port?: number;
};

export type TryCliCommand = {
  command: "TRY";
  noOpen: boolean;
  port?: number;
};

export type SetupCliCommand = {
  command: "SETUP";
  format: "HUMAN" | "JSON";
  route?: "MOCK" | "LIVE";
};

export type CliCommand =
  | StartCliCommand
  | TryCliCommand
  | SetupCliCommand
  | { command: "DOCTOR"; format: "HUMAN" | "JSON" }
  | { command: "DATA_PATH" }
  | { command: "LOGS_EXPORT" }
  | { command: "LOGS_DELETE" }
  | { command: "HELP" };

const parseLaunch = (
  command: StartCliCommand["command"] | TryCliCommand["command"],
  args: string[],
): StartCliCommand | TryCliCommand => {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "no-open": { type: "boolean", default: false },
      port: { type: "string" },
    },
  });

  if (parsed.values.port === undefined) {
    return { command, noOpen: parsed.values["no-open"] };
  }

  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  return { command, noOpen: parsed.values["no-open"], port };
};

const parseDoctor = (args: string[]): CliCommand => {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { json: { type: "boolean", default: false } },
  });
  return { command: "DOCTOR", format: parsed.values.json ? "JSON" : "HUMAN" };
};

const parseSetup = (args: string[]): SetupCliCommand => {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const mode = parsed.values.mode;
  if (mode !== undefined && mode !== "mock" && mode !== "live") {
    throw new Error("setup --mode must be mock or live");
  }
  if (parsed.values.json && mode === undefined) {
    throw new Error("setup --json requires --mode mock or live");
  }
  return {
    command: "SETUP",
    format: parsed.values.json ? "JSON" : "HUMAN",
    ...(mode === undefined ? {} : { route: mode === "mock" ? "MOCK" : "LIVE" }),
  };
};

const noArguments = (command: string, args: string[]): void => {
  if (args.length > 0) throw new Error(`${command} does not accept arguments`);
};

const parseLogs = (args: string[]): CliCommand => {
  const [action, ...rest] = args;
  if (action === "export") {
    noArguments("logs export", rest);
    return { command: "LOGS_EXPORT" };
  }
  if (action === "delete") {
    noArguments("logs delete", rest);
    return { command: "LOGS_DELETE" };
  }
  throw new Error("logs requires exactly one action: export or delete");
};

export const parseCliCommand = (args: string[]): CliCommand => {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h") {
    noArguments(first, rest);
    return { command: "HELP" };
  }
  if (first === undefined || first.startsWith("-")) return parseLaunch("START", args);
  if (first === "start") return parseLaunch("START", rest);
  if (first === "try") return parseLaunch("TRY", rest);
  if (first === "setup") return parseSetup(rest);
  if (first === "doctor") return parseDoctor(rest);
  if (first === "logs") return parseLogs(rest);
  if (first === "data-path") {
    noArguments("data-path", rest);
    return { command: "DATA_PATH" };
  }
  if (first === "help") {
    noArguments("help", rest);
    return { command: "HELP" };
  }
  throw new Error(`Unknown Loomrail command: ${first}`);
};
