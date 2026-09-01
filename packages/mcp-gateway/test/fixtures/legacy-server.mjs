import { createInterface } from "node:readline";
import process from "node:process";

const reply = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "server/discover") {
    reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (message.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "loomrail-legacy-test-server", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "legacy_search",
            description: "Synthetic legacy tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "resources/list") {
    reply({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === "prompts/list") {
    reply({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
    return;
  }
  reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
