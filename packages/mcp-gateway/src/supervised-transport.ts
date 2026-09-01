import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpProfileRevision } from "@loomrail/contracts";

export type SupervisedTransportOptions = {
  supervisorEntrypoint?: string;
  registryDirectory?: string;
};

export const supervisedServerParameters = (
  revision: McpProfileRevision,
  options: SupervisedTransportOptions = {},
): { command: string; args: string[]; controlToken: string; registryFile: string | null } => {
  const controlToken = randomBytes(32).toString("base64url");
  const recordId = randomBytes(32).toString("base64url");
  const registryFile =
    options.registryDirectory === undefined ? null : join(options.registryDirectory, `mcp-${recordId}.json`);
  return {
    command: process.execPath,
    args: [
      options.supervisorEntrypoint ?? fileURLToPath(new URL("./supervisor.js", import.meta.url)),
      "--parent-pid",
      String(process.pid),
      "--control-token",
      controlToken,
      ...(registryFile === null ? [] : ["--registry-file", registryFile]),
      "--",
      revision.executable,
      ...revision.args,
    ],
    controlToken,
    registryFile,
  };
};

export const supervisorFailureMarker = (
  controlToken: string,
  state: "INVALID_RESPONSE" | "OUTPUT_LIMIT_REACHED",
): string => `LOOMRAIL_MCP_SUPERVISOR:${controlToken}:${state}`;
