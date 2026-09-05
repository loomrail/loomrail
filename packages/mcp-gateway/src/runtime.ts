import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { Client, SdkError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Tool } from "@modelcontextprotocol/server";
import type { McpProfileRevision, McpSessionSnapshot, McpToolCallFailureCode } from "@loomrail/contracts";

import { assertMcpRevisionExecutable, McpGatewayError } from "./preflight.js";
import { mcpProbeEnvironment } from "./probe.js";
import { supervisedServerParameters } from "./supervised-transport.js";
import { proxyRequestSchema, type ProxyResponse, type ProxyTool } from "./wire.js";

const PRIVATE_MESSAGE_LIMIT_BYTES = 1_048_576;
const TOOL_ARGUMENT_LIMIT_BYTES = 262_144;
const TOOL_RESULT_LIMIT_BYTES = 1_048_576;
const TOOL_DEADLINE_MS = 60_000;
const SESSION_CONNECT_DEADLINE_MS = 5_000;
const MAX_JSON_DEPTH = 16;

export type McpProxyConnector = {
  id: string;
  proxyCommand: string;
  proxyArgs: string[];
  enabledTools: string[];
};

export type McpToolCallTerminalOutcome =
  | { status: "SUCCEEDED" }
  | { status: "FAILED"; failureCode: McpToolCallFailureCode }
  | { status: "UNKNOWN_OUTCOME"; failureCode: "CONNECTION_LOST" };

export type McpGatewaySessionBinding = {
  snapshot: McpSessionSnapshot;
  revision: McpProfileRevision;
  startToolCall: (input: { toolName: string; inputDigest: string }) => string | Promise<string>;
  finishToolCall: (callId: string, outcome: McpToolCallTerminalOutcome) => void | Promise<void>;
};

export type McpGatewayLease = {
  connections: McpProxyConnector[];
  close: () => Promise<void>;
};

type ActiveBinding = McpGatewaySessionBinding & {
  client: Client;
  tools: Map<string, ProxyTool>;
  token: string;
  socket: Socket | null;
};

export type McpGatewayRuntimeOptions = {
  proxyEntrypoint?: string;
  supervisorEntrypoint?: string;
  registryDirectory?: string;
};

const jsonDepth = (value: unknown, depth = 0): number => {
  if (depth > MAX_JSON_DEPTH) return depth;
  if (value === null || typeof value !== "object") return depth;
  const children: readonly unknown[] = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  let maximum = depth;
  for (const child of children) maximum = Math.max(maximum, jsonDepth(child, depth + 1));
  return maximum;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
};

const writeResponse = (socket: Socket, response: ProxyResponse): void => {
  const encoded = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > PRIVATE_MESSAGE_LIMIT_BYTES) {
    socket.write(
      `${JSON.stringify({
        type: "ERROR",
        id: "id" in response ? response.id : null,
        code: "CONNECTION_LOST",
        message: "The MCP proxy response exceeded the Loomrail limit",
      } satisfies ProxyResponse)}\n`,
    );
    return;
  }
  socket.write(encoded);
};

const proxyTool = (tool: Tool): ProxyTool => ({
  name: tool.name,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  ...(tool.description === undefined ? {} : { description: tool.description.slice(0, 2_048) }),
  inputSchema: tool.inputSchema,
});

const closeClient = async (binding: ActiveBinding): Promise<void> => {
  binding.socket?.destroy();
  binding.socket = null;
  await binding.client.close().catch(() => undefined);
};

const callFailure = (error: unknown): McpToolCallTerminalOutcome => {
  if (SdkError.isInstance(error)) return { status: "UNKNOWN_OUTCOME", failureCode: "CONNECTION_LOST" };
  return { status: "FAILED", failureCode: "PROTOCOL_ERROR" };
};

export const createMcpRuntime = (options: McpGatewayRuntimeOptions = {}) => {
  const proxyEntrypoint = options.proxyEntrypoint ?? fileURLToPath(new URL("./proxy.js", import.meta.url));
  const pendingTokens = new Map<string, ActiveBinding>();
  const sessionBindings = new Map<string, ActiveBinding[]>();
  const revokedGrants = new Set<string>();
  let broker: NetServer | null = null;
  let brokerPort: number | null = null;

  const handleCall = async (
    socket: Socket,
    binding: ActiveBinding,
    request: { id: string; name: string; arguments: Record<string, unknown> },
  ): Promise<void> => {
    if (revokedGrants.has(binding.snapshot.grantId)) {
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "GRANT_REVOKED",
        message: "The MCP grant was revoked",
      });
      return;
    }
    if (!binding.tools.has(request.name)) {
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "TOOL_NOT_GRANTED",
        message: "The MCP tool is not granted to this provider session",
      });
      return;
    }
    const inputJson = canonicalJson(request.arguments);
    if (
      Buffer.byteLength(inputJson, "utf8") > TOOL_ARGUMENT_LIMIT_BYTES ||
      jsonDepth(request.arguments) > MAX_JSON_DEPTH
    ) {
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "ARGUMENTS_INVALID",
        message: "The MCP tool arguments exceeded the Loomrail limit",
      });
      return;
    }

    let callId: string;
    try {
      callId = await binding.startToolCall({
        toolName: request.name,
        inputDigest: createHash("sha256").update(inputJson).digest("hex"),
      });
    } catch {
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "GRANT_REVOKED",
        message: "The MCP tool call is no longer allowed",
      });
      return;
    }

    let result: Awaited<ReturnType<typeof binding.client.callTool>>;
    try {
      result = await binding.client.callTool(
        { name: request.name, arguments: request.arguments },
        { timeout: TOOL_DEADLINE_MS, maxTotalTimeout: TOOL_DEADLINE_MS },
      );
    } catch (error: unknown) {
      await Promise.resolve(binding.finishToolCall(callId, callFailure(error))).catch(() => undefined);
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "CONNECTION_LOST",
        message: "The MCP server connection was lost; Loomrail will not retry this call",
      });
      return;
    }
    // From here the tool HAS run. A failure to record that fact must not be reported to the agent
    // as a lost connection: the natural response to "your call did not happen" is to call again,
    // which for a side-effecting tool is exactly the duplicate this accounting exists to prevent.
    // The outcome goes back as observed; the accounting failure stays in the daemon's diagnostics.
    const encodedResult = JSON.stringify(result);
    if (Buffer.byteLength(encodedResult, "utf8") > TOOL_RESULT_LIMIT_BYTES) {
      await Promise.resolve(
        binding.finishToolCall(callId, { status: "FAILED", failureCode: "OUTPUT_LIMIT_REACHED" }),
      ).catch(() => undefined);
      writeResponse(socket, {
        type: "ERROR",
        id: request.id,
        code: "CONNECTION_LOST",
        message: "The MCP tool result exceeded the Loomrail limit",
      });
      return;
    }
    await Promise.resolve(
      binding.finishToolCall(
        callId,
        result.isError === true ? { status: "FAILED", failureCode: "SERVER_ERROR" } : { status: "SUCCEEDED" },
      ),
    ).catch(() => undefined);
    writeResponse(socket, { type: "RESULT", id: request.id, result });
  };

  const acceptSocket = (socket: Socket): void => {
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    let buffer = "";
    let binding: ActiveBinding | null = null;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > PRIVATE_MESSAGE_LIMIT_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let input: unknown;
        try {
          input = JSON.parse(line) as unknown;
        } catch {
          writeResponse(socket, {
            type: "ERROR",
            id: null,
            code: "INVALID_REQUEST",
            message: "The MCP proxy request is invalid",
          });
          socket.destroySoon();
          return;
        }
        const parsed = proxyRequestSchema.safeParse(input);
        if (!parsed.success) {
          writeResponse(socket, {
            type: "ERROR",
            id: null,
            code: "INVALID_REQUEST",
            message: "The MCP proxy request is invalid",
          });
          socket.destroySoon();
          return;
        }
        if (binding === null) {
          if (parsed.data.type !== "AUTH") {
            writeResponse(socket, {
              type: "ERROR",
              id: null,
              code: "AUTH_REJECTED",
              message: "The MCP proxy token is required",
            });
            socket.destroySoon();
            return;
          }
          const found = pendingTokens.get(parsed.data.token);
          if (found === undefined) {
            writeResponse(socket, {
              type: "ERROR",
              id: null,
              code: "AUTH_REJECTED",
              message: "The MCP proxy token is invalid or already used",
            });
            socket.destroySoon();
            return;
          }
          pendingTokens.delete(parsed.data.token);
          binding = found;
          binding.socket = socket;
          writeResponse(socket, { type: "READY", tools: [...binding.tools.values()] });
        } else if (parsed.data.type === "CALL") {
          void handleCall(socket, binding, parsed.data);
        } else {
          writeResponse(socket, {
            type: "ERROR",
            id: null,
            code: "INVALID_REQUEST",
            message: "The MCP proxy is already authenticated",
          });
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      if (binding?.socket === socket) binding.socket = null;
    });
    socket.on("error", () => undefined);
  };

  const ensureBroker = async (): Promise<number> => {
    if (brokerPort !== null) return brokerPort;
    broker = createServer(acceptSocket);
    await new Promise<void>((resolve, reject) => {
      broker?.once("error", reject);
      broker?.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = broker.address();
    if (address === null || typeof address === "string") {
      throw new McpGatewayError("GATEWAY_UNAVAILABLE", "The MCP proxy broker did not bind to loopback");
    }
    brokerPort = address.port;
    return brokerPort;
  };

  const open = async (bindings: readonly McpGatewaySessionBinding[]): Promise<McpGatewayLease> => {
    if (bindings.length === 0) return { connections: [], close: () => Promise.resolve() };
    const sessionIds = new Set(bindings.map(({ snapshot }) => snapshot.providerSessionId));
    if (sessionIds.size !== 1) {
      throw new McpGatewayError(
        "SESSION_BINDING_INVALID",
        "One MCP gateway lease must belong to one ProviderSession",
      );
    }
    const sessionId = bindings[0]?.snapshot.providerSessionId;
    if (sessionId === undefined) {
      throw new McpGatewayError("SESSION_BINDING_INVALID", "The MCP gateway lease has no ProviderSession");
    }
    if (sessionBindings.has(sessionId)) {
      throw new McpGatewayError(
        "SESSION_ALREADY_OPEN",
        "The ProviderSession already has an MCP gateway lease",
      );
    }

    const active: ActiveBinding[] = [];
    try {
      const port = await ensureBroker();
      for (const binding of bindings) {
        if (
          binding.snapshot.profileRevisionId !== binding.revision.id ||
          binding.snapshot.profileDigest !== binding.revision.canonicalDigest
        ) {
          throw new McpGatewayError(
            "CONSENT_MISMATCH",
            "The MCP session snapshot does not match its revision",
          );
        }
        await assertMcpRevisionExecutable(binding.revision);
        const client = new Client(
          { name: "loomrail-gateway", version: "0.0.0" },
          // Same reasoning as the capability probe: era negotiation is answered only after the
          // server process has finished starting, so it gets the same budget as the connect below
          // rather than a separate one-second cliff that turns a busy machine into a failed session.
          {
            versionNegotiation: {
              mode: "auto",
              probe: { timeoutMs: SESSION_CONNECT_DEADLINE_MS, maxRetries: 0 },
            },
          },
        );
        const supervised = supervisedServerParameters(binding.revision, options);
        const transport = new StdioClientTransport({
          command: supervised.command,
          args: supervised.args,
          env: mcpProbeEnvironment(),
          stderr: "pipe",
          maxBufferSize: PRIVATE_MESSAGE_LIMIT_BYTES,
        });
        transport.stderr?.on("data", () => undefined);
        await client.connect(transport, {
          timeout: SESSION_CONNECT_DEADLINE_MS,
          maxTotalTimeout: SESSION_CONNECT_DEADLINE_MS,
        });
        const listed = await client.listTools(undefined, {
          timeout: SESSION_CONNECT_DEADLINE_MS,
          maxTotalTimeout: SESSION_CONNECT_DEADLINE_MS,
        });
        const allowed = new Set(binding.snapshot.tools);
        const tools = new Map(
          listed.tools
            .filter(({ name }) => allowed.has(name))
            .map((tool) => [tool.name, proxyTool(tool)] as const),
        );
        const token = randomBytes(32).toString("base64url");
        const entry: ActiveBinding = { ...binding, client, tools, token, socket: null };
        active.push(entry);
        pendingTokens.set(token, entry);
        revokedGrants.delete(binding.snapshot.grantId);
        if (tools.size === 0) {
          throw new McpGatewayError("CONSENT_MISMATCH", "No granted MCP tools are available from the server");
        }
      }
      sessionBindings.set(sessionId, active);
      const connections = active.map((binding, index): McpProxyConnector => ({
        id: `loomrail_${String(index + 1).padStart(2, "0")}`,
        proxyCommand: process.execPath,
        proxyArgs: [proxyEntrypoint, "--port", String(port), "--token", binding.token],
        enabledTools: [...binding.tools.keys()],
      }));
      let closed = false;
      return {
        connections,
        close: async () => {
          if (closed) return;
          closed = true;
          sessionBindings.delete(sessionId);
          await Promise.all(
            active.map(async (binding) => {
              pendingTokens.delete(binding.token);
              await closeClient(binding);
            }),
          );
        },
      };
    } catch (error: unknown) {
      await Promise.all(
        active.map(async (binding) => {
          pendingTokens.delete(binding.token);
          await closeClient(binding);
        }),
      );
      throw error;
    }
  };

  const revoke = (grantId: string): void => {
    revokedGrants.add(grantId);
  };

  const close = async (sessionId: string): Promise<void> => {
    const bindings = sessionBindings.get(sessionId) ?? [];
    sessionBindings.delete(sessionId);
    await Promise.all(
      bindings.map(async (binding) => {
        pendingTokens.delete(binding.token);
        await closeClient(binding);
      }),
    );
  };

  const shutdown = async (): Promise<void> => {
    await Promise.all([...sessionBindings.keys()].map((sessionId) => close(sessionId)));
    pendingTokens.clear();
    const current = broker;
    broker = null;
    brokerPort = null;
    if (current !== null) {
      await new Promise<void>((resolve) =>
        current.close(() => {
          resolve();
        }),
      );
    }
  };

  return { open, revoke, close, shutdown };
};
