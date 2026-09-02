import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { qaFinalizedAttachmentSchema } from "@loomrail/contracts";
import type { BrowserDriver } from "@loomrail/browser-qa";

import type { BrowserQAConfigResolver } from "../src/browser-qa-config.js";

export const BROWSER_QA_FIXTURE_SCREENSHOT = "verified browser QA screenshot";

export const passingBrowserQADriver = (options?: { artifactsDirectory?: string }): BrowserDriver => ({
  id: "PLAYWRIGHT",
  run: (qaRun) => {
    const target = qaRun.plan.targets[0];
    const scenario = qaRun.plan.scenarios[0];
    if (target === undefined || scenario === undefined) {
      throw new Error("The Browser QA fixture requires one target and one scenario");
    }
    const content = Buffer.from(BROWSER_QA_FIXTURE_SCREENSHOT);
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const attachment =
      options?.artifactsDirectory === undefined
        ? undefined
        : {
            handle: "fixture-screenshot",
            kind: "SCREENSHOT" as const,
            contentHash,
            byteSize: content.byteLength,
            targetId: target.id,
            scenarioId: scenario.id,
            capturedAt: qaRun.startedAt,
          };
    return Promise.resolve({
      result: {
        outcome: "MEASURED",
        environment: {
          osFamily: "MACOS",
          runtimeName: "NODE",
          runtimeVersion: "24.19.0",
          browserName: "CHROMIUM",
          browserVersion: "140.0",
        },
        executions: qaRun.plan.targets.flatMap((target) =>
          qaRun.plan.scenarios.map((scenario) => ({
            targetId: target.id,
            scenarioId: scenario.id,
            durationMs: 10,
            steps: scenario.steps.map(({ id }) => ({ id, status: "PASSED" as const, durationMs: 5 })),
            assertions: scenario.assertions.map(({ id }) => ({
              id,
              status: "PASSED" as const,
              details: null,
            })),
          })),
        ),
        observations: [],
        attachments: attachment === undefined ? [] : [attachment],
        defects: [],
      },
      finalizeAttachments: async ({ qaRunId, createAttachmentId }) => {
        if (attachment === undefined || options?.artifactsDirectory === undefined) return [];
        const runStorageSegment = `run-${createHash("sha256").update(qaRunId).digest("hex").slice(0, 32)}`;
        const filename = "fixture-screenshot.png";
        await mkdir(join(options.artifactsDirectory, "qa", runStorageSegment), { recursive: true });
        await writeFile(join(options.artifactsDirectory, "qa", runStorageSegment, filename), content);
        return [
          qaFinalizedAttachmentSchema.parse({
            handle: attachment.handle,
            ref: {
              schemaVersion: 1,
              id: createAttachmentId(),
              qaRunId,
              kind: attachment.kind,
              contentHash: attachment.contentHash,
              byteSize: attachment.byteSize,
              targetId: attachment.targetId,
              scenarioId: attachment.scenarioId,
              capturedAt: attachment.capturedAt,
              retentionClass: "STANDARD_30_DAYS",
              storageKey: `${runStorageSegment}/${filename}`,
            },
          }),
        ];
      },
      confirmAttachments: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    });
  },
});

const correctionFixtureDriver = (retestOutcome: "PASS" | "FAIL"): BrowserDriver => ({
  id: "PLAYWRIGHT",
  run: (qaRun, retestCells) => {
    const failing = qaRun.scope.type === "FULL" || retestOutcome === "FAIL";
    const cells =
      qaRun.scope.type === "FULL"
        ? qaRun.plan.targets.flatMap((target) =>
            qaRun.plan.scenarios.map((scenario) => ({
              targetId: target.id,
              scenarioId: scenario.id,
            })),
          )
        : retestCells;
    if (cells === undefined || cells.length === 0) {
      throw new Error("The correction fixture requires its durable sparse retest cells");
    }
    const firstCell = cells[0];
    if (firstCell === undefined) throw new Error("The correction fixture requires a measured cell");
    return Promise.resolve({
      result: {
        outcome: "MEASURED",
        environment: {
          osFamily: "MACOS",
          runtimeName: "NODE",
          runtimeVersion: "24.19.0",
          browserName: "CHROMIUM",
          browserVersion: "140.0",
        },
        executions: cells.map((cell) => {
          const scenario = qaRun.plan.scenarios.find(({ id }) => id === cell.scenarioId);
          if (scenario === undefined) throw new Error("The retest cell is outside the locked QA plan");
          const failingCell =
            failing && cell.targetId === firstCell.targetId && cell.scenarioId === firstCell.scenarioId;
          return {
            targetId: cell.targetId,
            scenarioId: cell.scenarioId,
            durationMs: 10,
            steps: scenario.steps.map(({ id }) => ({ id, status: "PASSED" as const, durationMs: 5 })),
            assertions: scenario.assertions.map(({ id }, index) => ({
              id,
              status: failingCell && index === 0 ? ("FAILED" as const) : ("PASSED" as const),
              details: failingCell && index === 0 ? "The intentional Q2 baseline check failed." : null,
            })),
          };
        }),
        observations: [],
        attachments: [],
        defects: failing
          ? [
              {
                severity: "HIGH" as const,
                title: "Intentional browser regression",
                description: "The initial full QA run found a deterministic regression for the Q2 loop.",
                reproduction: ["Open the affected cell and run its locked assertion."],
                targetId: firstCell.targetId,
                scenarioId: firstCell.scenarioId,
              },
            ]
          : [],
      },
      finalizeAttachments: () => Promise.resolve([]),
      confirmAttachments: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    });
  },
});

/** Measured Q2 fixture: the full baseline fails once and its locked sparse retest passes. */
export const failThenPassBrowserQADriver = (): BrowserDriver => correctionFixtureDriver("PASS");

/** Measured Q2 fixture: every locked run fails until the owner cancels the exhausted delivery. */
export const alwaysFailingBrowserQADriver = (): BrowserDriver => correctionFixtureDriver("FAIL");

export const readyBrowserQAConfig: BrowserQAConfigResolver = () =>
  Promise.resolve({
    status: "READY",
    targetOrigin: "http://127.0.0.1:4173",
    plan: {
      schemaVersion: 1,
      revision: 1,
      contentHash: `sha256:${"e".repeat(64)}`,
      targets: [
        {
          id: "desktop-light-en",
          viewport: { width: 1_280, height: 800 },
          locale: "en-US",
          theme: "LIGHT",
        },
      ],
      scenarios: [
        {
          id: "task-cockpit",
          title: "Task Cockpit shows the current state",
          steps: [{ id: "open", title: "Open the Task Cockpit", action: { type: "NAVIGATE", path: "/" } }],
          assertions: [
            {
              id: "state-visible",
              title: "The current state is visible",
              rule: { type: "VISIBLE", locator: { by: "TEXT", value: "Current work" } },
            },
          ],
        },
      ],
    },
  });
