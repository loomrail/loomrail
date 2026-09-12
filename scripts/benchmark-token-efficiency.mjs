import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { assembleContextPack } from "../packages/context-assembly/dist/index.js";
import { renderProviderInvocationPrompt } from "../packages/provider-core/dist/index.js";
import { deliveryTemplate } from "../packages/workflow-engine/dist/index.js";

// Frozen source revision, same fixture and tool schedule on both sides. No provider runs.
const baseline = "12bb55548c9fb550cdf0db1bbf7b177abd1822be";
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(join(root, "packages/context-assembly/.benchmark-"));
const providerScratch = await mkdtemp(join(root, "packages/provider-core/.benchmark-"));
try {
  const hashes = {};
  for (const name of ["render", "assemble"]) {
    const source = execFileSync("git", ["show", `${baseline}:packages/context-assembly/src/${name}.ts`], {
      cwd: root,
      encoding: "utf8",
    });
    hashes[name] = createHash("sha256").update(source).digest("hex");
    await writeFile(
      join(scratch, `${name}.js`),
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  }
  const old = await import(pathToFileURL(join(scratch, "assemble.js")).href);
  const providerFiles = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseline, "--", "packages/provider-core/src"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const file of providerFiles) {
    const source = execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" });
    hashes[file] = createHash("sha256").update(source).digest("hex");
    await writeFile(
      join(providerScratch, file.split("/").at(-1).replace(/\.ts$/, ".js")),
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  }
  const oldProvider = await import(pathToFileURL(join(providerScratch, "index.js")).href);
  const checkpoint = {
    id: "checkpoint-plan",
    version: 1,
    summary: "Add docs/runbooks/local-health-check.md; GET /health is implemented in src/health.ts.",
    completed: ["Confirmed /health route and existing checks"],
    remaining: ["Write runbook; preserve all verification gates"],
    deadEnds: ["No /health/ready route exists"],
    openQuestions: [],
  };
  const rows = [];
  for (const { stage, contextPack: spec } of deliveryTemplate.stages) {
    const sources = {
      workItemBrief: {
        id: "documentation-task",
        version: 1,
        title: "Document local health checks",
        description: "Add a bounded runbook describing the existing health endpoint and local verification.",
        acceptanceCriteria: [
          "Document the actual health route",
          "Keep Review, Project verification, measured Browser QA and owner Acceptance",
        ],
        priority: "NORMAL",
        risk: "LOW",
      },
      workflowPosition: {
        templateId: "delivery-v1",
        templateVersion: 4,
        stage,
        attempt: 1,
        sessionOrdinal: 1,
      },
      projectVerificationPlan: {
        id: "verification-plan",
        revision: 1,
        status: "ACTIVE",
        recipes: ["lint", "build", "test", "test:e2e"].map((id) => ({
          id,
          kind: "UNIT",
          label: id,
          required: true,
          timeoutSeconds: 300,
          networkPolicy: "NONE",
        })),
      },
      projectConstitution: null,
      qaCorrection: null,
      decisions: [
        {
          id: "decision-route",
          version: 1,
          question: "Health path?",
          answer: "Document existing /health; do not add a new route.",
        },
      ],
      latestCheckpoint: null,
      stageHandoff:
        stage === "PLAN"
          ? { stage: "DISCOVERY", checkpoint }
          : stage === "IMPLEMENT"
            ? { stage: "PLAN", checkpoint }
            : null,
      reviewInput:
        stage === "REVIEW"
          ? {
              implementationAttempt: { id: "implement", version: 2, attempt: 1, resultTree: "a".repeat(40) },
              authorAgentRun: { id: "author", version: 2, provider: "CODEX" },
              diffSummary: {
                baseline: "b".repeat(40),
                truncated: false,
                files: [
                  {
                    path: "docs/runbooks/local-health-check.md",
                    previousPath: null,
                    status: "ADDED",
                    insertions: 3,
                    deletions: 0,
                    binary: false,
                    content: {
                      type: "TEXT",
                      patch:
                        "@@ -0,0 +1,3 @@\n+# Local health\n+GET /health\n+Run all required verification checks.\n",
                      truncated: false,
                      omittedBytes: 0,
                    },
                  },
                ],
              },
              openFindings: [],
            }
          : null,
      evidence: ["QA", "ACCEPTANCE"].includes(stage)
        ? [
            {
              id: "review",
              version: 1,
              kind: "REVIEW_REPORT",
              title: "Independent Review",
              summary: "Reviewed the exact runbook diff against the existing route.",
              checks: ["Documented route matches implementation"],
            },
          ]
        : [],
      activity: Array.from({ length: 25 }, (_, index) => ({
        id: `audit-${index}`,
        version: 1,
        occurredAt: "2026-09-12T00:00:00.000Z",
        description: "Provider session checkpoint and workspace tool call recorded",
      })),
    };
    const args = { sources, spec, budgetTokens: 24_000, bytesPerToken: 4 };
    const before = old.assembleContextPack(args);
    const after = assembleContextPack({ ...args, projection: "STAGE_V1" });
    if (before.type !== "ASSEMBLED" || after.type !== "ASSEMBLED")
      throw new Error("Benchmark fixture must fit both assemblers");
    // Same six bounded reads where the role has workspace tools; Acceptance has none on either side.
    // No invented cache hits or savings from assumed fewer calls.
    const results = Array.from({ length: stage === "ACCEPTANCE" ? 0 : 6 }, (_, index) => ({
      status: "SUCCEEDED",
      operation: "READ_FILE",
      output: {
        type: "FILE",
        path: `docs/section-${index}.md`,
        sha256: "c".repeat(64),
        content: "Health endpoint: GET /health.\n".repeat(120),
        offsetBytes: 0,
        truncated: false,
      },
    }));
    const wire = (result, legacy) =>
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(legacy ? { structuredContent: { result } } : {}),
        isError: false,
      });
    const invocation = (pack) => ({
      session: { stage },
      contextPack: pack,
      acceptanceInput: null,
      mcpConnections:
        stage === "ACCEPTANCE"
          ? []
          : [
              {
                id: "loomrail_workspace",
                enabledTools: [
                  "loomrail_list_directory",
                  "loomrail_read_file",
                  ...(stage === "IMPLEMENT"
                    ? ["loomrail_write_file", "loomrail_edit_file", "loomrail_delete_file"]
                    : []),
                ],
              },
            ],
      ...(stage === "ACCEPTANCE"
        ? {}
        : { workspace: { access: stage === "IMPLEMENT" ? "READ_WRITE" : "READ_ONLY" } }),
    });
    const beforePrompt = oldProvider.renderProviderInvocationPrompt(invocation(before.pack));
    const afterPrompt = renderProviderInvocationPrompt(invocation(after.pack));
    const replayBytes = (prompt, legacy) => {
      let history = Buffer.byteLength(prompt);
      let total = history;
      for (const result of results) {
        history += Buffer.byteLength(wire(result, legacy));
        total += history;
      }
      return total;
    };
    rows.push({
      stage,
      toolResultCount: results.length,
      beforePackBytes: Buffer.byteLength(before.pack.text),
      afterPackBytes: Buffer.byteLength(after.pack.text),
      beforePromptBytes: Buffer.byteLength(beforePrompt),
      afterPromptBytes: Buffer.byteLength(afterPrompt),
      beforeReplayBytes: replayBytes(beforePrompt, true),
      afterReplayBytes: replayBytes(afterPrompt, false),
      beforeHash: before.pack.contentHash,
      afterHash: after.pack.contentHash,
    });
  }
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, baseline, sourceHashes: hashes, metric: "UTF8_BYTES_NOT_PROVIDER_TOKENS", assumptions: "Identical stage fixtures and six tool results for each workspace-enabled stage; no tool results for Acceptance. Cumulative full-history replay. Includes the full Loomrail invocation prompt, including newly added guidance. Excludes provider-owned prefixes, tool definitions and call arguments, output, cache and actual tool scheduling. Fixture reports are test data, not production success evidence.", actualProviderTokens: null, cachedTokens: null, uncachedTokens: null, rows, totals: { beforePackBytes: total("beforePackBytes"), afterPackBytes: total("afterPackBytes"), beforePromptBytes: total("beforePromptBytes"), afterPromptBytes: total("afterPromptBytes"), beforeReplayBytes: total("beforeReplayBytes"), afterReplayBytes: total("afterReplayBytes"), replayReductionPercent: 100 * (1 - total("afterReplayBytes") / total("beforeReplayBytes")) } }, null, 2)}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
  await rm(providerScratch, { recursive: true, force: true });
}
