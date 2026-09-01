import { createRequire } from "node:module";
import process from "node:process";

import { mcpProfileCandidateSchema, type McpProfileCandidate } from "@loomrail/contracts";

export const CONTEXT7_PRESET_NAME = "Context7";
export const CONTEXT7_PRESET_VERSION = "3.2.5";
export const CONTEXT7_PRESET_TOOLS = ["query-docs", "resolve-library-id"] as const;

export class Context7PresetError extends Error {
  readonly code = "CONTEXT7_PRESET_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("The bundled Context7 preset is unavailable in this Loomrail installation", options);
    this.name = "Context7PresetError";
  }
}

type Context7PresetResolution = {
  runtimeExecutable?: string;
  resolveEntrypoint?: () => string;
};

const daemonRequire = createRequire(import.meta.url);

const resolveContext7Entrypoint = (): string => daemonRequire.resolve("@upstash/context7-mcp/dist/index.js");

/**
 * Builds the one server-owned C3 recipe. No browser value, PATH lookup, package launcher or
 * download contributes to it; C1 preflight canonicalises both absolute files before consent.
 */
export const resolveBundledContext7Candidate = (
  resolution: Context7PresetResolution = {},
): McpProfileCandidate => {
  let entrypoint: string;
  try {
    entrypoint = (resolution.resolveEntrypoint ?? resolveContext7Entrypoint)();
  } catch (error: unknown) {
    throw new Context7PresetError({ cause: error });
  }
  return mcpProfileCandidateSchema.parse({
    profileId: null,
    name: CONTEXT7_PRESET_NAME,
    executable: resolution.runtimeExecutable ?? process.execPath,
    args: [entrypoint, "--transport", "stdio"],
    declaredTools: [...CONTEXT7_PRESET_TOOLS],
  });
};
