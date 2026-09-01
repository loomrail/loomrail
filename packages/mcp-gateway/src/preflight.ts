import { access, constants, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { McpProfileCandidate, McpProfileRevision } from "@loomrail/contracts";
import { validateMcpProfileCandidatePolicy } from "@loomrail/domain";

export type McpGatewayErrorCode =
  | "EXECUTABLE_NOT_FOUND"
  | "EXECUTABLE_NOT_FILE"
  | "EXECUTABLE_NOT_ALLOWED"
  | "SCRIPT_NOT_FOUND"
  | "SCRIPT_NOT_FILE"
  | "CONSENT_MISMATCH"
  | "PROBE_ALREADY_RUNNING"
  | "GATEWAY_UNAVAILABLE"
  | "SESSION_ALREADY_OPEN"
  | "SESSION_BINDING_INVALID";

export class McpGatewayError extends Error {
  readonly code: McpGatewayErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: McpGatewayErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpGatewayError";
    this.code = code;
    this.details = details;
  }
}

const scriptRuntimeNames = new Set(["node", "nodejs", "python", "python3"]);
const executableName = (path: string): string =>
  basename(path)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");

const resolveRegularFile = async (
  input: string,
  missingCode: "EXECUTABLE_NOT_FOUND" | "SCRIPT_NOT_FOUND",
  notFileCode: "EXECUTABLE_NOT_FILE" | "SCRIPT_NOT_FILE",
): Promise<string> => {
  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch (error: unknown) {
    throw new McpGatewayError(
      missingCode,
      "The local MCP path does not resolve to a file",
      {},
      { cause: error },
    );
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new McpGatewayError(notFileCode, "The local MCP path is not a regular file");
  }
  return resolved;
};

/**
 * Resolves symlinks before the consent challenge is created, so the path shown to the owner is the
 * same path later persisted and spawned. This performs no process launch.
 */
export const resolveMcpProfileCandidate = async (
  candidate: McpProfileCandidate,
): Promise<McpProfileCandidate> => {
  const policyChecked = validateMcpProfileCandidatePolicy(candidate);
  const executable = await resolveRegularFile(
    policyChecked.executable,
    "EXECUTABLE_NOT_FOUND",
    "EXECUTABLE_NOT_FILE",
  );
  try {
    await access(executable, constants.X_OK);
  } catch (error: unknown) {
    throw new McpGatewayError(
      "EXECUTABLE_NOT_ALLOWED",
      "The local MCP executable cannot be executed by this account",
      {},
      { cause: error },
    );
  }

  const args = [...policyChecked.args];
  if (scriptRuntimeNames.has(executableName(executable))) {
    const script = args[0];
    if (script === undefined) {
      // The pure policy already rejects this. Keeping the branch explicit protects this I/O seam
      // if its caller is ever widened independently.
      throw new McpGatewayError("SCRIPT_NOT_FOUND", "The MCP script path is missing");
    }
    args[0] = await resolveRegularFile(script, "SCRIPT_NOT_FOUND", "SCRIPT_NOT_FILE");
  }

  return validateMcpProfileCandidatePolicy({ ...policyChecked, executable, args });
};

/** Re-checks a durable revision immediately before spawn without changing what was consented. */
export const assertMcpRevisionExecutable = async (revision: McpProfileRevision): Promise<void> => {
  const resolved = await resolveMcpProfileCandidate({
    profileId: revision.profileId,
    name: revision.name,
    executable: revision.executable,
    args: revision.args,
    declaredTools: revision.declaredTools,
  });
  if (
    resolved.executable !== revision.executable ||
    resolved.args.some((arg, index) => arg !== revision.args[index])
  ) {
    throw new McpGatewayError(
      "CONSENT_MISMATCH",
      "The MCP executable or script now resolves differently from the consented revision",
    );
  }
};
