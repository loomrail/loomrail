import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";

const mode = process.argv[2] ?? "ready";

if (mode === "tree" || mode === "orphan-tree") {
  const pidFile = process.argv[3];
  if (pidFile === undefined) throw new Error("tree mode requires a pid file");
  const helper = spawn(
    process.execPath,
    [fileURLToPath(new URL("./signal-resistant-child.mjs", import.meta.url))],
    { stdio: "ignore" },
  );
  if (helper.pid === undefined) throw new Error("tree helper did not start");
  writeFileSync(pidFile, JSON.stringify({ serverPid: process.pid, helperPid: helper.pid }));
}

if (mode === "orphan-tree") {
  setInterval(() => undefined, 1_000);
} else if (mode === "stalled") {
  process.stdin.resume();
} else {
  serveStdio(() => {
    const server = new McpServer({ name: "loomrail-test-server", version: "1.0.0" });
    const toolCount = mode === "too-many-tools" ? 65 : 2;

    for (let index = 0; index < toolCount; index += 1) {
      server.registerTool(
        `tool_${index.toString().padStart(2, "0")}`,
        {
          description: "Synthetic read-only test tool",
          inputSchema: z.object({ query: z.string().optional() }),
        },
        async ({ query }) => {
          if (mode === "exit-on-call") process.exit(42);
          if (mode === "delayed-call") {
            await delay(250);
          }
          return { content: [{ type: "text", text: query ?? "ok" }] };
        },
      );
    }

    server.registerResource(
      "project_readme",
      "loomrail-test://readme",
      { description: "Synthetic project documentation", mimeType: "text/plain" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "test" }] }),
    );
    server.registerPrompt(
      "summarize_project",
      { description: "Synthetic prompt", argsSchema: z.object({}) },
      async () => ({
        messages: [{ role: "user", content: { type: "text", text: "Summarize the project" } }],
      }),
    );

    return server;
  });
}
