import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_QA_DEFECTS,
  MAX_QA_OBSERVATIONS,
  qaAttachmentDraftSchema,
  qaDriverResultSchema,
  qaFinalizedAttachmentSchema,
  qaRunSchema,
  type QAAttachmentDraft,
  type QADefectDraft,
  type QADriverResult,
  type QAFinalizedAttachment,
  type QALocator,
  type QAObservation,
  type QARun,
} from "@loomrail/contracts";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

import { confirmBrowserQAArtifacts, stageBrowserQAArtifacts } from "./artifact-recovery.js";

export {
  BROWSER_QA_RECOVERY_MARKER,
  recoverBrowserQAArtifacts,
  type BrowserQAArtifactRecovery,
  type BrowserQARecoveryMarker,
} from "./artifact-recovery.js";

export type BrowserDriverExecution = {
  result: QADriverResult;
  finalizeAttachments: (input: {
    qaRunId: string;
    createAttachmentId: () => string;
  }) => Promise<readonly QAFinalizedAttachment[]>;
  confirmAttachments: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type BrowserDriver = {
  id: "PLAYWRIGHT";
  run: (qaRun: QARun) => Promise<BrowserDriverExecution>;
};

export type PlaywrightDriverOptions = {
  artifactsDirectory: string;
  timeoutMs?: number;
  slowRequestMs?: number;
};

type PendingAttachment = {
  draft: QAAttachmentDraft;
  filename: string;
  path: string;
};

const safeSummary = (value: string): string =>
  value
    .replaceAll(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1_000)
    .trim() || "Browser observation had no printable detail.";

const pathOfUrl = (value: string): string => {
  try {
    return new URL(value).pathname.slice(0, 500);
  } catch {
    return "[invalid URL]";
  }
};

const locatorFor = (page: Page, locator: QALocator): Locator => {
  switch (locator.by) {
    case "ROLE":
      return page.getByRole(locator.role, { name: locator.name, exact: true });
    case "TEST_ID":
      return page.getByTestId(locator.value);
    case "TEXT":
      return page.getByText(locator.value, { exact: true });
  }
};

const sha256File = async (path: string): Promise<{ contentHash: string; byteSize: number }> => {
  const [content, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    byteSize: metadata.size,
  };
};

const errorSummary = (error: unknown): string =>
  safeSummary(
    error instanceof Error ? error.message : "The Playwright driver failed without an Error value.",
  );

const observation = (observations: QAObservation[], value: QAObservation): void => {
  if (observations.length < MAX_QA_OBSERVATIONS) observations.push(value);
};

const defect = (defects: QADefectDraft[], value: QADefectDraft): void => {
  if (defects.length < MAX_QA_DEFECTS) defects.push(value);
};

const addDefectsForBlockingObservations = (
  observations: readonly QAObservation[],
  defects: QADefectDraft[],
): void => {
  for (const item of observations) {
    if (!item.blocking) continue;
    const alreadyRepresented = defects.some(
      (candidate) =>
        candidate.targetId === item.targetId &&
        candidate.scenarioId === item.scenarioId &&
        candidate.description === item.summary,
    );
    if (alreadyRepresented) continue;
    defect(defects, {
      severity: "HIGH",
      title: item.kind === "CONSOLE" ? "Blocking browser console error" : "Blocking network error",
      description: item.summary,
      reproduction: [
        `Run scenario ${item.scenarioId} on target ${item.targetId}.`,
        `Inspect the captured ${item.kind.toLowerCase()} evidence.`,
      ],
      targetId: item.targetId,
      scenarioId: item.scenarioId,
    });
  }
};

const bindEvidenceListeners = async (input: {
  context: BrowserContext;
  page: Page;
  allowedOrigin: string;
  targetId: string;
  currentScenarioId: () => string;
  observations: QAObservation[];
  slowRequestMs: number;
  onForbiddenOrigin: () => void;
  onUnsafeCapability: () => void;
}): Promise<void> => {
  const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  const started = new Map<string, number>();
  input.page.on("request", (request) => started.set(request.url(), Date.now()));
  input.page.on("response", (response) => {
    const status = response.status();
    const targetId = input.targetId;
    const scenarioId = input.currentScenarioId();
    const duration = Date.now() - (started.get(response.url()) ?? Date.now());
    if (status >= 400) {
      observation(input.observations, {
        kind: "NETWORK",
        severity: "ERROR",
        blocking: true,
        targetId,
        scenarioId,
        summary: `${status.toString()} ${pathOfUrl(response.url())}`,
      });
    } else if (duration >= input.slowRequestMs) {
      observation(input.observations, {
        kind: "NETWORK",
        severity: "WARNING",
        blocking: false,
        targetId,
        scenarioId,
        summary: `${duration.toString()} ms ${pathOfUrl(response.url())}`,
      });
    }
  });
  input.page.on("requestfailed", (request) => {
    observation(input.observations, {
      kind: "NETWORK",
      severity: "ERROR",
      blocking: true,
      targetId: input.targetId,
      scenarioId: input.currentScenarioId(),
      summary: safeSummary(`${request.failure()?.errorText ?? "Request failed"} ${pathOfUrl(request.url())}`),
    });
  });
  input.page.on("console", (message) => {
    if (message.type() !== "warning" && message.type() !== "error") return;
    observation(input.observations, {
      kind: "CONSOLE",
      severity: message.type() === "error" ? "ERROR" : "WARNING",
      blocking: message.type() === "error",
      targetId: input.targetId,
      scenarioId: input.currentScenarioId(),
      summary: safeSummary(message.text()),
    });
  });
  input.page.on("dialog", (dialog) => {
    input.onUnsafeCapability();
    void dialog.dismiss().catch(() => undefined);
  });
  input.page.on("download", (download) => {
    input.onUnsafeCapability();
    void download.cancel().catch(() => undefined);
  });
  await input.context.route("**/*", async (route) => {
    const request = route.request();
    let origin = "";
    try {
      origin = new URL(request.url()).origin;
    } catch {
      input.onForbiddenOrigin();
      await route.abort("blockedbyclient");
      return;
    }
    if (origin !== input.allowedOrigin) {
      input.onForbiddenOrigin();
      observation(input.observations, {
        kind: "NETWORK",
        severity: "ERROR",
        blocking: true,
        targetId: input.targetId,
        scenarioId: input.currentScenarioId(),
        summary: `Blocked off-origin request to ${origin.slice(0, 300)}`,
      });
      await route.abort("blockedbyclient");
      return;
    }
    if (!readOnlyMethods.has(request.method())) {
      observation(input.observations, {
        kind: "NETWORK",
        severity: "ERROR",
        blocking: true,
        targetId: input.targetId,
        scenarioId: input.currentScenarioId(),
        summary: `Blocked read-only QA request: ${request.method()} ${pathOfUrl(request.url())}`,
      });
      await route.abort("blockedbyclient");
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()["location"];
    if (response.status() >= 300 && response.status() < 400 && location !== undefined) {
      let redirectedOrigin = "";
      try {
        redirectedOrigin = new URL(location, request.url()).origin;
      } catch {
        input.onForbiddenOrigin();
        await route.abort("blockedbyclient");
        return;
      }
      if (redirectedOrigin !== input.allowedOrigin) {
        input.onForbiddenOrigin();
        observation(input.observations, {
          kind: "NETWORK",
          severity: "ERROR",
          blocking: true,
          targetId: input.targetId,
          scenarioId: input.currentScenarioId(),
          summary: `Blocked off-origin redirect to ${redirectedOrigin.slice(0, 300)}`,
        });
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.fulfill({ response });
  });
};

export const createPlaywrightDriver = (options: PlaywrightDriverOptions): BrowserDriver => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const slowRequestMs = options.slowRequestMs ?? 2_000;
  return {
    id: "PLAYWRIGHT",
    run: async (input): Promise<BrowserDriverExecution> => {
      const qaRun = qaRunSchema.parse(input);
      const runStorageSegment = `run-${createHash("sha256").update(qaRun.id).digest("hex").slice(0, 32)}`;
      const quarantineRoot = join(options.artifactsDirectory, ".quarantine");
      await mkdir(quarantineRoot, { recursive: true });
      const quarantineDirectory = await mkdtemp(join(quarantineRoot, `${runStorageSegment}-`));
      const pendingAttachments: PendingAttachment[] = [];
      const executions: Extract<QADriverResult, { outcome: "MEASURED" }>["executions"] = [];
      const observations: QAObservation[] = [];
      const defects: QADefectDraft[] = [];
      const securityViolations = new Set<"FORBIDDEN_ORIGIN" | "UNSAFE_CAPABILITY">();
      let targetUnavailable = false;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      let browserVersion = "unknown";
      let finalized = false;

      const confirmAttachments = async (): Promise<void> => {
        if (!finalized) return;
        await confirmBrowserQAArtifacts({
          artifactsDirectory: options.artifactsDirectory,
          runStorageSegment,
        });
      };

      const dispose = async (): Promise<void> => {
        if (!finalized) await rm(quarantineDirectory, { recursive: true, force: true });
      };

      try {
        browser = await chromium.launch({ headless: true });
        browserVersion = browser.version();
        for (const [targetIndex, target] of qaRun.plan.targets.entries()) {
          const context = await browser.newContext({
            viewport: target.viewport,
            locale: target.locale,
            colorScheme: target.theme === "DARK" ? "dark" : "light",
            acceptDownloads: false,
          });
          context.setDefaultTimeout(timeoutMs);
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          const page = await context.newPage();
          let scenarioId = qaRun.plan.scenarios[0]?.id ?? "baseline";
          await bindEvidenceListeners({
            context,
            page,
            allowedOrigin: qaRun.targetOrigin,
            targetId: target.id,
            currentScenarioId: () => scenarioId,
            observations,
            slowRequestMs,
            onForbiddenOrigin: () => {
              securityViolations.add("FORBIDDEN_ORIGIN");
            },
            onUnsafeCapability: () => {
              securityViolations.add("UNSAFE_CAPABILITY");
            },
          });

          for (const [scenarioIndex, scenario] of qaRun.plan.scenarios.entries()) {
            scenarioId = scenario.id;
            const stepResults: Extract<
              QADriverResult,
              { outcome: "MEASURED" }
            >["executions"][number]["steps"] = [];
            const assertionResults: Extract<
              QADriverResult,
              { outcome: "MEASURED" }
            >["executions"][number]["assertions"] = [];
            const executionStarted = Date.now();
            let executionBlocked = false;

            for (const step of scenario.steps) {
              const startedAt = Date.now();
              let status: "PASSED" | "FAILED" = "PASSED";
              if (executionBlocked) {
                stepResults.push({ id: step.id, status: "FAILED", durationMs: 0 });
                continue;
              }
              try {
                switch (step.action.type) {
                  case "NAVIGATE": {
                    const response = await page.goto(`${qaRun.targetOrigin}${step.action.path}`, {
                      waitUntil: "domcontentloaded",
                      timeout: timeoutMs,
                    });
                    if (!response?.ok())
                      throw new Error(
                        `Navigation returned ${response?.status().toString() ?? "no response"}`,
                      );
                    break;
                  }
                  case "CLICK":
                    await locatorFor(page, step.action.locator).click();
                    break;
                  case "PRESS":
                    await locatorFor(page, step.action.locator).press(step.action.key);
                    break;
                  case "WAIT_FOR_IDLE":
                    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
                    break;
                }
              } catch (error: unknown) {
                status = "FAILED";
                if (step.action.type === "NAVIGATE") {
                  targetUnavailable = true;
                  executionBlocked = true;
                }
                defect(defects, {
                  severity: "HIGH",
                  title: `Step failed: ${step.title}`,
                  description: errorSummary(error),
                  reproduction: [`Run scenario “${scenario.title}” on target ${target.id}.`, step.title],
                  targetId: target.id,
                  scenarioId: scenario.id,
                });
              }
              stepResults.push({ id: step.id, status, durationMs: Date.now() - startedAt });
            }

            for (const assertion of scenario.assertions) {
              let passed = false;
              let details: string | null = null;
              try {
                switch (assertion.rule.type) {
                  case "VISIBLE":
                    passed = await locatorFor(page, assertion.rule.locator).isVisible();
                    break;
                  case "TEXT_CONTAINS": {
                    const actual = await locatorFor(page, assertion.rule.locator).textContent();
                    passed = actual?.includes(assertion.rule.expected) === true;
                    details = passed
                      ? null
                      : safeSummary(`Expected text containing “${assertion.rule.expected}”.`);
                    break;
                  }
                  case "URL_PATH":
                    passed = pathOfUrl(page.url()) === assertion.rule.path;
                    break;
                  case "NO_HORIZONTAL_OVERFLOW":
                    passed = await page.evaluate<boolean>(
                      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
                    );
                    break;
                  case "FOCUSED":
                    passed =
                      (await locatorFor(page, assertion.rule.locator).evaluate(
                        "element => element === document.activeElement",
                      )) === true;
                    break;
                }
              } catch (error: unknown) {
                details = errorSummary(error);
              }
              if (!passed) {
                details ??= `Assertion failed: ${assertion.title}`;
                defect(defects, {
                  severity: "HIGH",
                  title: assertion.title,
                  description: details,
                  reproduction: [`Run scenario “${scenario.title}” on target ${target.id}.`],
                  targetId: target.id,
                  scenarioId: scenario.id,
                });
              }
              assertionResults.push({ id: assertion.id, status: passed ? "PASSED" : "FAILED", details });
            }

            const screenshotFilename = `target-${(targetIndex + 1).toString()}--scenario-${(
              scenarioIndex + 1
            ).toString()}.png`;
            const screenshotPath = join(quarantineDirectory, screenshotFilename);
            try {
              await page.screenshot({ path: screenshotPath, fullPage: true });
              const metadata = await sha256File(screenshotPath);
              const draft = qaAttachmentDraftSchema.parse({
                handle: `screenshot:${target.id}:${scenario.id}`,
                kind: "SCREENSHOT",
                ...metadata,
                targetId: target.id,
                scenarioId: scenario.id,
                capturedAt: new Date().toISOString(),
              });
              pendingAttachments.push({ draft, filename: screenshotFilename, path: screenshotPath });
            } catch (error: unknown) {
              defect(defects, {
                severity: "HIGH",
                title: `Screenshot capture failed: ${scenario.title}`,
                description: errorSummary(error),
                reproduction: [`Run scenario “${scenario.title}” on target ${target.id}.`],
                targetId: target.id,
                scenarioId: scenario.id,
              });
            }
            executions.push({
              targetId: target.id,
              scenarioId: scenario.id,
              durationMs: Date.now() - executionStarted,
              steps: stepResults,
              assertions: assertionResults,
            });
          }

          const traceFilename = `target-${(targetIndex + 1).toString()}--trace.zip`;
          const tracePath = join(quarantineDirectory, traceFilename);
          try {
            await context.tracing.stop({ path: tracePath });
            const metadata = await sha256File(tracePath);
            const firstScenario = qaRun.plan.scenarios[0];
            if (!firstScenario) throw new Error("QA plan has no scenario for trace attribution");
            const draft = qaAttachmentDraftSchema.parse({
              handle: `trace:${target.id}`,
              kind: "TRACE",
              ...metadata,
              targetId: target.id,
              scenarioId: firstScenario.id,
              capturedAt: new Date().toISOString(),
            });
            pendingAttachments.push({ draft, filename: traceFilename, path: tracePath });
          } catch (error: unknown) {
            const firstScenario = qaRun.plan.scenarios[0];
            if (firstScenario) {
              defect(defects, {
                severity: "HIGH",
                title: `Trace capture failed: ${target.id}`,
                description: errorSummary(error),
                reproduction: [`Run the target ${target.id}.`],
                targetId: target.id,
                scenarioId: firstScenario.id,
              });
            }
          }
          await context.close();
        }
      } catch (error: unknown) {
        await browser?.close().catch(() => undefined);
        const result = qaDriverResultSchema.parse({
          outcome: "ERROR",
          code: "DRIVER_CRASHED",
          summary: errorSummary(error),
        });
        return {
          result,
          finalizeAttachments: () => Promise.resolve([]),
          confirmAttachments,
          dispose,
        };
      } finally {
        await browser?.close().catch(() => undefined);
      }

      addDefectsForBlockingObservations(observations, defects);

      const result = qaDriverResultSchema.parse(
        securityViolations.has("FORBIDDEN_ORIGIN")
          ? {
              outcome: "ERROR",
              code: "ORIGIN_FORBIDDEN",
              summary: "The page attempted off-origin navigation.",
            }
          : securityViolations.has("UNSAFE_CAPABILITY")
            ? {
                outcome: "ERROR",
                code: "EVIDENCE_INVALID",
                summary: "The page attempted a dialog or download outside the read-only QA capability.",
              }
            : targetUnavailable
              ? {
                  outcome: "ERROR",
                  code: "TARGET_UNHEALTHY",
                  summary: "The loopback QA target was unavailable.",
                }
              : {
                  outcome: "MEASURED",
                  environment: {
                    osFamily:
                      process.platform === "darwin"
                        ? "MACOS"
                        : process.platform === "win32"
                          ? "WINDOWS"
                          : "LINUX",
                    runtimeName: "NODE",
                    runtimeVersion: process.versions.node,
                    browserName: "CHROMIUM",
                    browserVersion,
                  },
                  executions,
                  observations,
                  attachments: pendingAttachments.map(({ draft }) => draft),
                  defects,
                },
      );

      const finalizeAttachments = async (input: {
        qaRunId: string;
        createAttachmentId: () => string;
      }): Promise<readonly QAFinalizedAttachment[]> => {
        if (input.qaRunId !== qaRun.id || result.outcome !== "MEASURED") return [];
        const refs = await Promise.all(
          pendingAttachments.map(async ({ draft, path, filename }) => {
            const measured = await sha256File(path);
            if (measured.contentHash !== draft.contentHash || measured.byteSize !== draft.byteSize) {
              throw new Error("A quarantined Browser QA attachment changed before finalization");
            }
            return qaFinalizedAttachmentSchema.parse({
              handle: draft.handle,
              ref: {
                schemaVersion: 1,
                id: input.createAttachmentId(),
                qaRunId: qaRun.id,
                kind: draft.kind,
                contentHash: draft.contentHash,
                byteSize: draft.byteSize,
                targetId: draft.targetId,
                scenarioId: draft.scenarioId,
                capturedAt: draft.capturedAt,
                retentionClass: "STANDARD_30_DAYS",
                storageKey: `${runStorageSegment}/${filename}`,
              },
            });
          }),
        );
        await stageBrowserQAArtifacts({
          artifactsDirectory: options.artifactsDirectory,
          quarantineDirectory,
          runStorageSegment,
          qaRunId: qaRun.id,
          attachments: refs,
        });
        finalized = true;
        return refs;
      };
      return { result, finalizeAttachments, confirmAttachments, dispose };
    },
  };
};
