import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpCapabilityProbeState, McpConsent, McpProfileRevision } from "@loomrail/contracts";
import { mcpCapabilitySnapshotSchema } from "@loomrail/contracts";

import { assertMcpRevisionExecutable, McpGatewayError } from "./preflight.js";
import {
  supervisedServerParameters,
  supervisorFailureMarker,
  type SupervisedTransportOptions,
} from "./supervised-transport.js";

const PROBE_DEADLINE_MS = 5_000;
const PROBE_MESSAGE_LIMIT_BYTES = 1_048_576;
const PROBE_AGGREGATE_LIMIT_BYTES = 4_194_304;
const MAX_CAPABILITIES_PER_KIND = 64;

const inheritedEnvironmentKeys = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export const mcpProbeEnvironment = (environment: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const result: Record<string, string> = {};
  inheritedEnvironmentKeys.forEach((key) => {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  });
  return result;
};

export type McpProbeObservation = {
  state: McpCapabilityProbeState;
  protocolVersion: string | null;
  tools: string[];
  resources: string[];
  prompts: string[];
};

const emptyObservation = (state: Exclude<McpCapabilityProbeState, "READY">): McpProbeObservation => ({
  state,
  protocolVersion: null,
  tools: [],
  resources: [],
  prompts: [],
});

const validateObservation = (observation: McpProbeObservation): McpProbeObservation => {
  const parsed = mcpCapabilitySnapshotSchema
    .omit({
      id: true,
      schemaVersion: true,
      projectId: true,
      profileRevisionId: true,
      observedAt: true,
    })
    .safeParse(observation);
  return parsed.success ? parsed.data : emptyObservation("INVALID_RESPONSE");
};

const boundedNames = (values: readonly string[]): string[] | null => {
  if (values.length > MAX_CAPABILITIES_PER_KIND || new Set(values).size !== values.length) return null;
  return [...values].sort();
};

const aggregateWithinLimit = (values: readonly unknown[]): boolean =>
  Buffer.byteLength(JSON.stringify(values), "utf8") <= PROBE_AGGREGATE_LIMIT_BYTES;

const stateForError = (error: unknown): Exclude<McpCapabilityProbeState, "READY"> => {
  if (error instanceof McpGatewayError) return "SPAWN_FAILED";
  if (error instanceof DOMException && error.name === "AbortError") return "TIMED_OUT";
  if (SdkError.isInstance(error)) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return "TIMED_OUT";
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.SendFailed:
        return "PROCESS_EXITED";
      case SdkErrorCode.EraNegotiationFailed:
      case SdkErrorCode.MethodNotSupportedByProtocolVersion:
        return "UNSUPPORTED_PROTOCOL";
      case SdkErrorCode.ListPaginationExceeded:
        return "OUTPUT_LIMIT_REACHED";
      case SdkErrorCode.InvalidResult:
      case SdkErrorCode.UnsupportedResultType:
      case SdkErrorCode.InputRequiredRoundsExceeded:
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.AlreadyConnected:
      case SdkErrorCode.NotInitialized:
      case SdkErrorCode.CapabilityNotSupported:
      case SdkErrorCode.ClientHttpNotImplemented:
      case SdkErrorCode.ClientHttpAuthentication:
      case SdkErrorCode.ClientHttpForbidden:
      case SdkErrorCode.ClientHttpUnexpectedContent:
      case SdkErrorCode.ClientHttpFailedToOpenStream:
      case SdkErrorCode.ClientHttpFailedToTerminateSession:
        return "INVALID_RESPONSE";
    }
  }
  return "INVALID_RESPONSE";
};

export const probeMcpRevision = async (
  revision: McpProfileRevision,
  consent: McpConsent,
  options: SupervisedTransportOptions = {},
): Promise<McpProbeObservation> => {
  if (
    consent.projectId !== revision.projectId ||
    consent.profileRevisionId !== revision.id ||
    consent.canonicalDigest !== revision.canonicalDigest
  ) {
    throw new McpGatewayError("CONSENT_MISMATCH", "The MCP revision has no matching owner consent");
  }
  await assertMcpRevisionExecutable(revision);

  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, PROBE_DEADLINE_MS);
  const client = new Client(
    { name: "loomrail", version: "0.0.0" },
    {
      // The SDK's era-negotiation probe is the first thing an MCP server has to answer, and it
      // answers it after Node has started and its own bundle has loaded. Giving that first answer a
      // second of its own -- less than a fifth of the probe's whole budget -- made the result depend
      // on how busy the machine was rather than on the server: the bundled Context7 preset reports
      // READY on an idle laptop and times out on a loaded one. The deadline the spec sets is the
      // probe's, so negotiation gets that deadline too, and `deadline`/`signal` below still stop the
      // whole probe at exactly five seconds.
      versionNegotiation: { mode: "auto", probe: { timeoutMs: PROBE_DEADLINE_MS, maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
      listMaxPages: 4,
      defaultCacheTtlMs: 0,
    },
  );
  const supervised = supervisedServerParameters(revision, options);
  const transport = new StdioClientTransport({
    command: supervised.command,
    args: supervised.args,
    env: mcpProbeEnvironment(),
    stderr: "pipe",
    maxBufferSize: PROBE_MESSAGE_LIMIT_BYTES,
  });
  const supervisorFailure: {
    state: "INVALID_RESPONSE" | "OUTPUT_LIMIT_REACHED" | null;
  } = { state: null };
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-512);
    if (stderrTail.includes(supervisorFailureMarker(supervised.controlToken, "INVALID_RESPONSE"))) {
      supervisorFailure.state = "INVALID_RESPONSE";
      controller.abort();
    } else if (
      stderrTail.includes(supervisorFailureMarker(supervised.controlToken, "OUTPUT_LIMIT_REACHED"))
    ) {
      supervisorFailure.state = "OUTPUT_LIMIT_REACHED";
      controller.abort();
    }
  });

  try {
    await client.connect(transport, {
      signal: controller.signal,
      timeout: PROBE_DEADLINE_MS,
      maxTotalTimeout: PROBE_DEADLINE_MS,
    });
    const requestOptions = {
      signal: controller.signal,
      timeout: PROBE_DEADLINE_MS,
      maxTotalTimeout: PROBE_DEADLINE_MS,
      cacheMode: "bypass" as const,
    };
    const [toolResult, resourceResult, promptResult] = await Promise.all([
      client.listTools(undefined, requestOptions),
      client.listResources(undefined, requestOptions),
      client.listPrompts(undefined, requestOptions),
    ]);
    if (!aggregateWithinLimit([toolResult, resourceResult, promptResult])) {
      return emptyObservation("OUTPUT_LIMIT_REACHED");
    }
    const tools = boundedNames(toolResult.tools.map(({ name }) => name));
    const resources = boundedNames(resourceResult.resources.map(({ name }) => name));
    const prompts = boundedNames(promptResult.prompts.map(({ name }) => name));
    if (tools === null || resources === null || prompts === null) {
      return emptyObservation("OUTPUT_LIMIT_REACHED");
    }
    return validateObservation({
      state: "READY",
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      tools,
      resources,
      prompts,
    });
  } catch (error: unknown) {
    return emptyObservation(supervisorFailure.state ?? stateForError(error));
  } finally {
    clearTimeout(deadline);
    await client.close().catch(() => undefined);
  }
};
