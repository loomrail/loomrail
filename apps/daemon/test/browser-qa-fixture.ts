import type { BrowserDriver } from "@loomrail/browser-qa";

import type { BrowserQAConfigResolver } from "../src/browser-qa-config.js";

export const passingBrowserQADriver = (): BrowserDriver => ({
  id: "PLAYWRIGHT",
  run: (qaRun) =>
    Promise.resolve({
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
        attachments: [],
        defects: [],
      },
      finalizeAttachments: () => Promise.resolve([]),
      dispose: () => Promise.resolve(),
    }),
});

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
