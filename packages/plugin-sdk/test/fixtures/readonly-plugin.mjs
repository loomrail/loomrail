import {
  defineReadonlyPluginManifest,
  defineReadonlyTool,
  serveReadonlyToolPlugin,
} from "../../dist/index.js";
import process from "node:process";
import { z } from "zod";

const echo = defineReadonlyTool({
  name: "echo_docs",
  title: "Echo docs query",
  description: "Returns a synthetic documentation query for conformance tests.",
  inputSchema: z.object({ query: z.string().min(1) }),
  run: ({ query }) => {
    process.stderr.write("ECHO_HANDLER_CALLED\n");
    return {
      content: [{ type: "text", text: query }],
      structuredContent: { query },
    };
  },
});

const failSafely = defineReadonlyTool({
  name: "fail_safely",
  description: "Throws a synthetic secret-bearing error to verify redaction.",
  inputSchema: z.object({}),
  run: () => {
    throw new Error("PLUGIN_TEST_SECRET_MUST_NOT_ESCAPE");
  },
});

const invalidResult = defineReadonlyTool({
  name: "invalid_result",
  description: "Returns an invalid result to verify runtime rejection.",
  inputSchema: z.object({}),
  run: () => ({ content: [] }),
});

const tools = [echo, failSafely, invalidResult];
const manifest = defineReadonlyPluginManifest({
  id: "dev.loomrail.fixture",
  name: "Loomrail fixture plugin",
  version: "1.0.0",
  description: "Synthetic read-only plugin used by the SDK conformance suite.",
  license: "Apache-2.0",
  entrypoint: "dist/plugin.mjs",
  permissions: { network: { mode: "NONE" } },
  tools,
});

serveReadonlyToolPlugin({ manifest, tools });
