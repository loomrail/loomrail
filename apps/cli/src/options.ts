import { parseArgs } from "node:util";

export type StartCliCommand = {
  command: "START";
  noOpen: boolean;
  port?: number;
};

export type CliCommand =
  | StartCliCommand
  | { command: "DOCTOR"; format: "HUMAN" | "JSON" }
  | { command: "DATA_PATH" }
  | { command: "HELP" };

const parseStart = (args: string[]): StartCliCommand => {
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
    return { command: "START", noOpen: parsed.values["no-open"] };
  }

  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  return { command: "START", noOpen: parsed.values["no-open"], port };
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

const noArguments = (command: string, args: string[]): void => {
  if (args.length > 0) throw new Error(`${command} does not accept arguments`);
};

export const parseCliCommand = (args: string[]): CliCommand => {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h") {
    noArguments(first, rest);
    return { command: "HELP" };
  }
  if (first === undefined || first.startsWith("-")) return parseStart(args);
  if (first === "start") return parseStart(rest);
  if (first === "doctor") return parseDoctor(rest);
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
