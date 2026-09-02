import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_QA_SCENARIOS,
  MAX_QA_TARGETS,
  qaPlanSnapshotSchema,
  qaScenarioPlanSchema,
  qaTargetOriginSchema,
  qaTargetSchema,
  type Project,
  type QADriverResult,
  type QAPlanSnapshot,
} from "@loomrail/contracts";
import { z } from "zod";

export const BROWSER_QA_CONFIG_RELATIVE_PATH = ".loomrail/browser-qa.json";
export const MAX_BROWSER_QA_CONFIG_BYTES = 64 * 1_024;

export type BrowserQAConfigResolution =
  | { status: "READY"; targetOrigin: string; plan: QAPlanSnapshot }
  | {
      status: "ERROR";
      targetOrigin: string;
      plan: QAPlanSnapshot;
      error: Extract<QADriverResult, { outcome: "ERROR" }>;
    };

export type BrowserQAConfigResolver = (project: Project) => Promise<BrowserQAConfigResolution>;

const browserQAConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetOrigin: qaTargetOriginSchema,
    revision: z.number().int().positive(),
    targets: z.array(qaTargetSchema).min(1).max(MAX_QA_TARGETS),
    scenarios: z.array(qaScenarioPlanSchema).min(1).max(MAX_QA_SCENARIOS),
  })
  .strict();

const planFromConfig = (value: z.infer<typeof browserQAConfigFileSchema>): QAPlanSnapshot => {
  const definition = {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    targets: value.targets,
    scenarios: value.scenarios,
  };
  return qaPlanSnapshotSchema.parse({
    ...definition,
    contentHash: `sha256:${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`,
  });
};

const unavailablePlanDefinition = {
  schemaVersion: 1 as const,
  revision: 1,
  targets: [
    {
      id: "configuration-check",
      viewport: { width: 1_280, height: 800 },
      locale: "en-US",
      theme: "LIGHT" as const,
    },
  ],
  scenarios: [
    {
      id: "configuration-check",
      title: "Browser QA configuration is available",
      steps: [
        {
          id: "open",
          title: "Open the configured loopback target",
          action: { type: "NAVIGATE" as const, path: "/" },
        },
      ],
      assertions: [
        {
          id: "configured-path",
          title: "The configured path is active",
          rule: { type: "URL_PATH" as const, path: "/" },
        },
      ],
    },
  ],
};

const unavailablePlan = qaPlanSnapshotSchema.parse({
  ...unavailablePlanDefinition,
  contentHash: `sha256:${createHash("sha256")
    .update(JSON.stringify(unavailablePlanDefinition))
    .digest("hex")}`,
});

export const unavailableBrowserQAConfig = (summary: string): BrowserQAConfigResolution => ({
  status: "ERROR",
  // This origin is never navigated. It only keeps an errored QARun fully typed and unmistakably
  // local while the HumanRequest explains that the real project target was not configured.
  targetOrigin: "http://127.0.0.1:1",
  plan: unavailablePlan,
  error: { outcome: "ERROR", code: "EVIDENCE_INVALID", summary },
});

const readBoundedFile = async (path: string): Promise<string> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BROWSER_QA_CONFIG_BYTES) {
    throw new Error("Browser QA configuration must be a bounded regular file");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BROWSER_QA_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_BROWSER_QA_CONFIG_BYTES) {
      throw new Error("Browser QA configuration exceeds the size limit");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
};

/** Reads only the bounded, declarative browser plan. It never launches a project command. */
export const resolveProjectBrowserQAConfig: BrowserQAConfigResolver = async (project) => {
  try {
    const source = await readBoundedFile(join(project.repositoryPath, BROWSER_QA_CONFIG_RELATIVE_PATH));
    const parsed = browserQAConfigFileSchema.parse(JSON.parse(source));
    return { status: "READY", targetOrigin: parsed.targetOrigin, plan: planFromConfig(parsed) };
  } catch {
    return unavailableBrowserQAConfig(
      `Add a valid ${BROWSER_QA_CONFIG_RELATIVE_PATH} file and start its loopback target before retrying QA.`,
    );
  }
};
