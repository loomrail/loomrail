import { parseArgs } from "node:util";

export type CliOptions = {
  noOpen: boolean;
  port?: number;
};

export const parseCliOptions = (args: string[]): CliOptions => {
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
    return { noOpen: parsed.values["no-open"] };
  }

  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  return { noOpen: parsed.values["no-open"], port };
};
