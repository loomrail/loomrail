# Loomrail Plugin SDK v1

> Read-only tool plugins · [Русская версия](PLUGIN-SDK.ru.md)

The first Plugin SDK is deliberately narrow. It helps an author build a separate MCP stdio process with typed inputs,
a strict manifest, fixed read-only annotations, bounded results, and safe error handling. It does not provide workflow
hooks, package installation, a marketplace, secrets, shell/Git access, or side-effect tools.

The SDK is published from the main package:

```bash
npm install loomrail@next zod
```

Import it through `loomrail/plugin-sdk`. Do not import Loomrail daemon, domain, or persistence packages.

## Minimal plugin

```ts
import {
  defineReadonlyPluginManifest,
  defineReadonlyTool,
  serveReadonlyToolPlugin,
} from "loomrail/plugin-sdk";
import { z } from "zod";

const searchDocs = defineReadonlyTool({
  name: "search_docs",
  description: "Searches the public Acme documentation.",
  inputSchema: z.object({ query: z.string().min(1).max(500) }),
  run: async ({ query }) => {
    const response = await fetch(`https://docs.example.com/search?q=${encodeURIComponent(query)}`);
    const text = await response.text();
    return { content: [{ type: "text", text: text.slice(0, 32_000) }] };
  },
});

const tools = [searchDocs];

export const manifest = defineReadonlyPluginManifest({
  id: "com.example.docs",
  name: "Acme docs",
  version: "1.0.0",
  description: "Read-only search over the public Acme documentation.",
  license: "MIT",
  entrypoint: "dist/index.js",
  permissions: {
    network: { mode: "DECLARED_HOSTS", hosts: ["docs.example.com"] },
  },
  tools,
});

serveReadonlyToolPlugin({ manifest, tools });
```

The manifest tool list is derived from the definitions. An author cannot separately advertise one tool and serve
another. The SDK owns the MCP annotations: every v1 tool is read-only, non-destructive, and idempotent. A network
declaration sets the open-world annotation but remains a claim for owner review, not an operating-system firewall.

Write `manifest` as JSON during your build and ship it beside the compiled relative `entrypoint`. Keep the entrypoint
self-contained; v1 has no runtime downloader or package-manager launcher.

## Check compatibility in Loomrail

Until a later installer/catalog milestone, local registration uses the existing **Settings → MCP connections** flow:

1. Build the plugin locally and review its source and generated manifest.
2. Propose the absolute Node executable and the absolute compiled entrypoint as separate argv elements.
3. Confirm the exact C1 command and run the capability probe.
4. Verify that discovered tools exactly match the manifest.
5. Grant only the tools the project needs. New provider sessions receive the snapshot; existing sessions do not.

The proposal does not run the process. Consent allows the bounded probe; the separate Grant controls which tool names
a provider can call. A manifest, a successful probe, and read-only annotations do not prove that third-party code is
safe.

## Security contract

- A plugin process runs with the local user's operating-system authority. Loomrail does not claim an OS sandbox.
- Never place credentials in the manifest, argv, source fixture, or tool result. SDK v1 has no secret interface.
- stdout belongs exclusively to MCP. Send bounded diagnostics to stderr and redact sensitive values yourself.
- Handler exceptions are converted to a generic error; their raw messages and stacks are not returned to the client.
- Plugins cannot mutate Loomrail workflow state through the SDK. Any future domain extension needs a separate,
  validated command contract and owner decision.
- Registry discovery, downloads, updates, signatures, and rollback are not part of v1.

The normative scope is [C2 Plugin SDK v1](../plans/37-c2-plugin-sdk-spec.ru.md), and the security reasoning is in
[ADR-0006](../adr/0006-read-only-tool-plugin-sdk.md) and the [threat model](../security/THREAT-MODEL.md).
