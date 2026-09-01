import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineReadonlyPluginManifest,
  defineReadonlyTool,
  PluginDefinitionError,
  readonlyPluginManifestSchema,
  readonlyPluginToolResultSchema,
  serveReadonlyToolPlugin,
} from "../src/index.js";

const tool = (name: string) =>
  defineReadonlyTool({
    name,
    description: `Read-only ${name}`,
    inputSchema: z.object({ query: z.string() }),
    run: ({ query }) => ({ content: [{ type: "text", text: query }] }),
  });

describe("plugin manifest", () => {
  it("derives an immutable canonical tool and network surface", () => {
    const tools = [tool("zebra"), tool("alpha")];
    const manifest = defineReadonlyPluginManifest({
      id: "com.example.docs",
      name: "Docs",
      version: "1.2.3-beta.1",
      description: "Queries public documentation.",
      license: "MIT",
      entrypoint: "dist/plugin.mjs",
      permissions: {
        network: { mode: "DECLARED_HOSTS", hosts: ["z.example.com", "api.example.com"] },
      },
      tools,
    });

    expect(manifest.tools.map(({ name }) => name)).toEqual(["alpha", "zebra"]);
    expect(manifest.permissions.network).toEqual({
      mode: "DECLARED_HOSTS",
      hosts: ["api.example.com", "z.example.com"],
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tools)).toBe(true);
    if (manifest.permissions.network.mode !== "DECLARED_HOSTS") {
      throw new Error("Expected the declared-host manifest variant");
    }
    expect(Object.isFrozen(manifest.permissions.network.hosts)).toBe(true);
  });

  it.each([
    { entrypoint: "/tmp/plugin.mjs" },
    { entrypoint: "../plugin.mjs" },
    { entrypoint: "dist\\plugin.mjs" },
    { entrypoint: "dist/plugin.ts" },
  ])("rejects unsafe entrypoint $entrypoint", ({ entrypoint }) => {
    const parsed = readonlyPluginManifestSchema.safeParse({
      schemaVersion: 1,
      protocol: "loomrail.readonly-tools.v1",
      id: "com.example.docs",
      name: "Docs",
      version: "1.0.0",
      description: "Docs plugin",
      license: "MIT",
      entrypoint,
      permissions: { network: { mode: "NONE" } },
      tools: [{ name: "lookup", description: "Lookup docs" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects executable, secret and workflow fields as an unknown authority surface", () => {
    const parsed = readonlyPluginManifestSchema.safeParse({
      schemaVersion: 1,
      protocol: "loomrail.readonly-tools.v1",
      id: "com.example.docs",
      name: "Docs",
      version: "1.0.0",
      description: "Docs plugin",
      license: "MIT",
      entrypoint: "dist/plugin.mjs",
      permissions: { network: { mode: "NONE" }, filesystemWrite: true },
      tools: [{ name: "lookup", description: "Lookup docs" }],
      command: "/bin/sh",
      env: { API_KEY: "secret" },
      workflowHooks: ["afterAcceptance"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate tools and network hosts", () => {
    const base = {
      schemaVersion: 1,
      protocol: "loomrail.readonly-tools.v1",
      id: "com.example.docs",
      name: "Docs",
      version: "1.0.0",
      description: "Docs plugin",
      license: "MIT",
      entrypoint: "dist/plugin.mjs",
      permissions: {
        network: { mode: "DECLARED_HOSTS", hosts: ["api.example.com", "api.example.com"] },
      },
      tools: [
        { name: "lookup", description: "Lookup docs" },
        { name: "lookup", description: "Lookup docs again" },
      ],
    };
    expect(readonlyPluginManifestSchema.safeParse(base).success).toBe(false);
  });

  it("refuses manifest and runtime tool drift before opening the transport", () => {
    const first = tool("first");
    const second = tool("second");
    const manifest = defineReadonlyPluginManifest({
      id: "com.example.docs",
      name: "Docs",
      version: "1.0.0",
      description: "Docs plugin",
      license: "MIT",
      entrypoint: "dist/plugin.mjs",
      permissions: { network: { mode: "NONE" } },
      tools: [first],
    });
    expect(() => serveReadonlyToolPlugin({ manifest, tools: [second] })).toThrow(PluginDefinitionError);
  });
});

describe("plugin results", () => {
  it("accepts bounded JSON and rejects circular or oversized content", () => {
    expect(
      readonlyPluginToolResultSchema.parse({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { count: 1, nested: [true, null, "value"] },
      }),
    ).toBeDefined();

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(
      readonlyPluginToolResultSchema.safeParse({
        content: [{ type: "text", text: "ok" }],
        structuredContent: circular,
      }).success,
    ).toBe(false);
    expect(
      readonlyPluginToolResultSchema.safeParse({
        content: [{ type: "text", text: "x".repeat(262_145) }],
      }).success,
    ).toBe(false);
  });
});
