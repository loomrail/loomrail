import { Buffer } from "node:buffer";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const PLUGIN_PROTOCOL = "loomrail.readonly-tools.v1" as const;
const MAX_RESULT_BYTES = 262_144;
const MAX_STRUCTURED_DEPTH = 8;
const MAX_STRUCTURED_NODES = 10_000;

const compareCodePoints = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const pluginIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u);
const pluginVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const pluginLicenseSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9A-Za-z.+() -]+$/u);
const pluginToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);

const pluginEntrypointSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((entrypoint) => !entrypoint.startsWith("/") && !/^[A-Za-z]:[/\\]/u.test(entrypoint), {
    message: "Plugin entrypoint must be relative",
  })
  .refine((entrypoint) => !entrypoint.includes("\\"), {
    message: "Plugin entrypoint must use portable forward slashes",
  })
  .refine(
    (entrypoint) =>
      entrypoint.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "Plugin entrypoint cannot contain empty or traversal segments" },
  )
  .refine((entrypoint) => /\.(?:js|mjs)$/u.test(entrypoint), {
    message: "Plugin entrypoint must be a JavaScript module",
  });

const isHostname = (value: string): boolean => {
  if (value.length > 253 || value.toLowerCase() !== value || value.endsWith(".")) return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => {
      if (label.length < 1 || label.length > 63) return false;
      return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label);
    })
  );
};

const pluginHostnameSchema = z.string().min(3).max(253).refine(isHostname, {
  message: "Plugin network hosts must be lowercase DNS hostnames without ports or paths",
});

const pluginNetworkPermissionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("NONE") }).strict(),
  z
    .object({
      mode: z.literal("DECLARED_HOSTS"),
      hosts: z.array(pluginHostnameSchema).min(1).max(32),
    })
    .strict()
    .superRefine(({ hosts }, context) => {
      if (new Set(hosts).size !== hosts.length) {
        context.addIssue({ code: "custom", message: "Plugin network hosts must be unique" });
      }
    }),
]);

export const readonlyPluginToolManifestSchema = z
  .object({
    name: pluginToolNameSchema,
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(500),
  })
  .strict();

export const readonlyPluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal(PLUGIN_PROTOCOL),
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(80),
    version: pluginVersionSchema,
    description: z.string().trim().min(1).max(500),
    license: pluginLicenseSchema,
    entrypoint: pluginEntrypointSchema,
    permissions: z.object({ network: pluginNetworkPermissionSchema }).strict(),
    tools: z.array(readonlyPluginToolManifestSchema).min(1).max(64),
  })
  .strict()
  .superRefine(({ tools }, context) => {
    const names = tools.map(({ name }) => name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "Plugin tool names must be unique" });
    }
  });

const pluginTextContentSchema = z.object({ type: z.literal("text"), text: z.string().max(131_072) }).strict();

const isBoundedJsonObject = (value: Readonly<Record<string, unknown>>): boolean => {
  const seen = new Set<object>();
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_STRUCTURED_NODES || current.depth > MAX_STRUCTURED_DEPTH) return false;
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      return false;
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RESULT_BYTES;
  } catch {
    return false;
  }
};

export const readonlyPluginToolResultSchema = z
  .object({
    content: z.array(pluginTextContentSchema).min(1).max(64),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const textBytes = result.content.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
    if (textBytes > MAX_RESULT_BYTES) {
      context.addIssue({ code: "custom", message: "Plugin tool text result exceeds 256 KiB" });
    }
    if (result.structuredContent !== undefined && !isBoundedJsonObject(result.structuredContent)) {
      context.addIssue({ code: "custom", message: "Plugin structured result is not bounded JSON" });
    }
  });

export type ReadonlyPluginToolResult = z.infer<typeof readonlyPluginToolResultSchema>;
export type ReadonlyPluginManifest = z.infer<typeof readonlyPluginManifestSchema>;
export type ReadonlyPluginToolManifest = z.infer<typeof readonlyPluginToolManifestSchema>;

const invokeReadonlyTool = Symbol("invokeReadonlyTool");

export type ReadonlyPluginTool = ReadonlyPluginToolManifest & {
  readonly inputSchema: z.ZodObject;
  readonly [invokeReadonlyTool]: (input: unknown) => Promise<ReadonlyPluginToolResult>;
};

export const defineReadonlyTool = <Schema extends z.ZodObject>(definition: {
  name: string;
  title?: string;
  description: string;
  inputSchema: Schema;
  run: (input: z.output<Schema>) => ReadonlyPluginToolResult | Promise<ReadonlyPluginToolResult>;
}): ReadonlyPluginTool => {
  const metadata = readonlyPluginToolManifestSchema.parse({
    name: definition.name,
    ...(definition.title === undefined ? {} : { title: definition.title }),
    description: definition.description,
  });
  return Object.freeze({
    ...metadata,
    inputSchema: definition.inputSchema,
    [invokeReadonlyTool]: async (input: unknown) =>
      readonlyPluginToolResultSchema.parse(await definition.run(definition.inputSchema.parse(input))),
  });
};

export type DefineReadonlyPluginManifestInput = Omit<
  ReadonlyPluginManifest,
  "schemaVersion" | "protocol" | "tools"
> & {
  tools: readonly ReadonlyPluginTool[];
};

const manifestToolFor = (tool: ReadonlyPluginTool): ReadonlyPluginToolManifest => ({
  name: tool.name,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  description: tool.description,
});

const freezeManifest = (manifest: ReadonlyPluginManifest): ReadonlyPluginManifest => {
  if (manifest.permissions.network.mode === "DECLARED_HOSTS") {
    Object.freeze(manifest.permissions.network.hosts);
  }
  Object.freeze(manifest.permissions.network);
  Object.freeze(manifest.permissions);
  manifest.tools.forEach(Object.freeze);
  Object.freeze(manifest.tools);
  return Object.freeze(manifest);
};

export const defineReadonlyPluginManifest = (
  input: DefineReadonlyPluginManifestInput,
): ReadonlyPluginManifest => {
  const network =
    input.permissions.network.mode === "NONE"
      ? { mode: "NONE" as const }
      : {
          mode: "DECLARED_HOSTS" as const,
          hosts: [...input.permissions.network.hosts].sort(compareCodePoints),
        };
  const manifest = readonlyPluginManifestSchema.parse({
    schemaVersion: 1,
    protocol: PLUGIN_PROTOCOL,
    id: input.id,
    name: input.name,
    version: input.version,
    description: input.description,
    license: input.license,
    entrypoint: input.entrypoint,
    permissions: { network },
    tools: input.tools.map(manifestToolFor).sort((left, right) => compareCodePoints(left.name, right.name)),
  });
  return freezeManifest(manifest);
};

export type PluginDefinitionErrorCode = "MANIFEST_TOOL_MISMATCH";

export class PluginDefinitionError extends Error {
  readonly code: PluginDefinitionErrorCode;

  constructor(code: PluginDefinitionErrorCode, message: string) {
    super(message);
    this.name = "PluginDefinitionError";
    this.code = code;
  }
}

const toolIdentity = (tool: ReadonlyPluginToolManifest): string => JSON.stringify(tool);

const assertManifestMatchesTools = (
  manifest: ReadonlyPluginManifest,
  tools: readonly ReadonlyPluginTool[],
): void => {
  const manifestTools = manifest.tools.map(toolIdentity).sort(compareCodePoints);
  const runtimeTools = tools.map(manifestToolFor).map(toolIdentity).sort(compareCodePoints);
  if (
    manifestTools.length !== runtimeTools.length ||
    manifestTools.some((tool, index) => tool !== runtimeTools[index])
  ) {
    throw new PluginDefinitionError(
      "MANIFEST_TOOL_MISMATCH",
      "The plugin manifest does not match the tools served by this process",
    );
  }
};

const genericFailure = (): CallToolResult => ({
  content: [{ type: "text", text: "The plugin tool failed." }],
  isError: true,
});

const toMcpResult = (result: ReadonlyPluginToolResult): CallToolResult => ({
  content: result.content.map((item) => ({ ...item })),
  ...(result.structuredContent === undefined ? {} : { structuredContent: { ...result.structuredContent } }),
  ...(result.isError === undefined ? {} : { isError: result.isError }),
});

export type ReadonlyToolPluginHandle = { close: () => Promise<void> };

/**
 * Serves one validated plugin over stdio. The SDK owns transport and MCP annotations; callers only
 * provide the manifest and tool definitions, so no server object or lifecycle hook leaks through
 * the interface.
 */
export const serveReadonlyToolPlugin = (input: {
  manifest: ReadonlyPluginManifest;
  tools: readonly ReadonlyPluginTool[];
}): ReadonlyToolPluginHandle => {
  const manifest = readonlyPluginManifestSchema.parse(input.manifest);
  assertManifestMatchesTools(manifest, input.tools);
  const openWorld = manifest.permissions.network.mode === "DECLARED_HOSTS";
  return serveStdio(
    () => {
      const server = new McpServer({ name: manifest.id, version: manifest.version });
      for (const tool of input.tools) {
        server.registerTool(
          tool.name,
          {
            ...(tool.title === undefined ? {} : { title: tool.title }),
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: openWorld,
            },
          },
          async (args) => {
            try {
              return toMcpResult(await tool[invokeReadonlyTool](args));
            } catch {
              return genericFailure();
            }
          },
        );
      }
      return server;
    },
    { onerror: () => undefined },
  );
};
