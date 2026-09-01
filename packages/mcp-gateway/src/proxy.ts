import { connect } from "node:net";

import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { proxyResponseSchema, type ProxyResponse } from "./wire.js";

const optionsSchema = z.tuple([
  z.literal("--port"),
  z.coerce.number().int().min(1).max(65_535),
  z.literal("--token"),
  z.string().min(32).max(256),
]);

const parsedOptions = optionsSchema.safeParse(process.argv.slice(2));
if (!parsedOptions.success) {
  process.stderr.write("The Loomrail MCP proxy arguments are invalid.\n");
  process.exitCode = 2;
} else {
  const [, port, , token] = parsedOptions.data;
  const socket = connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  socket.setNoDelay(true);
  const pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let buffer = "";
  let nextCallId = 0;
  let readyResolve: ((response: Extract<ProxyResponse, { type: "READY" }>) => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const ready = new Promise<Extract<ProxyResponse, { type: "READY" }>>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ type: "AUTH", token })}\n`);
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 1_048_576) {
      socket.destroy(new Error("The Loomrail MCP proxy response exceeded the limit"));
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let response: ProxyResponse | null = null;
      try {
        const parsed = proxyResponseSchema.safeParse(JSON.parse(line) as unknown);
        if (parsed.success) response = parsed.data;
      } catch {
        response = null;
      }
      if (response === null) {
        socket.destroy(new Error("The Loomrail MCP proxy response is invalid"));
        return;
      }
      if (response.type === "READY") {
        readyResolve?.(response);
        readyResolve = null;
        readyReject = null;
      } else if (response.id !== null) {
        const call = pending.get(response.id);
        if (call !== undefined) {
          pending.delete(response.id);
          if (response.type === "RESULT") call.resolve(response.result);
          else call.reject(new Error(response.message));
        }
      } else if (response.type === "ERROR") {
        readyReject?.(new Error(response.message));
      }
      newline = buffer.indexOf("\n");
    }
  });

  // A lease closing is the ordinary way this socket ends: the gateway calls `socket.destroy()` with
  // no error, so `close` fires and `error` never does. Settling the in-flight calls only from the
  // `error` handler therefore left them pending forever on exactly the path that happens every time
  // a ProviderSession finishes, and the agent's own request timeout became the only thing that ended
  // the wait. Both endings now abandon the same way, and `abandon` is idempotent.
  const abandon = (error: Error): void => {
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };

  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      abandon(new Error("The Loomrail MCP gateway closed this session connector"));
      resolve();
    });
  });
  socket.on("error", abandon);

  const call = (name: string, args: Record<string, unknown>): Promise<unknown> => {
    nextCallId += 1;
    const id = String(nextCallId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ type: "CALL", id, name, arguments: args })}\n`);
    });
  };

  try {
    const greeting = await ready;
    const server = new McpServer({ name: "loomrail-session-proxy", version: "0.0.0" });
    for (const tool of greeting.tools) {
      server.registerTool(
        tool.name,
        {
          ...(tool.title === undefined ? {} : { title: tool.title }),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: fromJsonSchema(tool.inputSchema),
        },
        async (args) =>
          CallToolResultSchema.parse(await call(tool.name, z.record(z.string(), z.unknown()).parse(args))),
      );
    }
    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1_048_576,
    });
    await server.connect(transport);
    await closed;
    await server.close().catch(() => undefined);
  } catch {
    process.stderr.write("The Loomrail MCP proxy could not connect to the local gateway.\n");
    socket.destroy();
    process.exitCode = 1;
  }
}
