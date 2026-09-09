import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_QA_DEFECTS,
  MAX_QA_ATTACHMENT_BYTES,
  MAX_QA_OBSERVATIONS,
  MAX_QA_REQUESTS,
  MAX_QA_RESPONSE_BYTES,
  MAX_QA_TOTAL_ATTACHMENT_BYTES,
  MAX_QA_TOTAL_RESPONSE_BYTES,
  qaAttachmentDraftSchema,
  qaDriverResultSchema,
  qaFinalizedAttachmentSchema,
  qaRetestCellSchema,
  qaRunSchema,
  type QAAttachmentDraft,
  type QADefectDraft,
  type QADriverResult,
  type QAFinalizedAttachment,
  type QALocator,
  type QAObservation,
  type QARetestCell,
  type QARun,
} from "@loomrail/contracts";
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
  type WebSocketRoute,
} from "playwright";
import { z } from "zod";

import {
  confirmBrowserQAArtifacts,
  createBrowserQAQuarantineDirectory,
  disposeBrowserQAQuarantineDirectory,
  stageBrowserQAArtifacts,
} from "./artifact-recovery.js";

export {
  deleteExpiredBrowserQAArtifacts,
  type BrowserQARetentionAction,
  type BrowserQARetentionResult,
} from "./artifact-retention.js";

export {
  BROWSER_QA_RECOVERY_MARKER,
  BrowserQAArtifactOpenError,
  BrowserQAArtifactRecoveryError,
  openVerifiedBrowserQAArtifact,
  recoverBrowserQAArtifacts,
  type BrowserQAArtifactRecovery,
  type BrowserQAArtifactOpenErrorCode,
  type BrowserQARecoveryMarker,
} from "./artifact-recovery.js";

const browserDriverErrorCodes = [
  "INVALID_INPUT",
  "DRIVER_SETUP_FAILED",
  "ATTACHMENT_FINALIZATION_FAILED",
  "ATTACHMENT_CONFIRMATION_FAILED",
  "QUARANTINE_DISPOSAL_FAILED",
] as const;

export type BrowserDriverErrorCode = (typeof browserDriverErrorCodes)[number];
const browserDriverErrorCodeSet: ReadonlySet<string> = new Set(browserDriverErrorCodes);

const browserDriverErrorMessages = {
  INVALID_INPUT: "The Browser QA run input is invalid.",
  DRIVER_SETUP_FAILED: "The Browser QA driver could not start safely.",
  ATTACHMENT_FINALIZATION_FAILED: "Browser QA attachments could not be finalized safely.",
  ATTACHMENT_CONFIRMATION_FAILED: "Browser QA attachments could not be confirmed safely.",
  QUARANTINE_DISPOSAL_FAILED: "The Browser QA quarantine could not be disposed safely.",
} as const satisfies Record<BrowserDriverErrorCode, string>;

const isBrowserDriverErrorCode = (value: unknown): value is BrowserDriverErrorCode =>
  typeof value === "string" && browserDriverErrorCodeSet.has(value);

/** The complete rejection vocabulary for public asynchronous BrowserDriver operations. */
export class BrowserDriverError extends Error {
  readonly code: BrowserDriverErrorCode;

  constructor(code: BrowserDriverErrorCode, message: string, options?: ErrorOptions) {
    const normalizedCode = isBrowserDriverErrorCode(code) ? code : "DRIVER_SETUP_FAILED";
    super(isBrowserDriverErrorCode(code) ? message : browserDriverErrorMessages[normalizedCode], options);
    this.name = "BrowserDriverError";
    this.code = normalizedCode;
  }
}

export type BrowserDriverExecution = {
  result: QADriverResult;
  /** Rejects only with BrowserDriverError. */
  finalizeAttachments: (input: {
    qaRunId: string;
    createAttachmentId: () => string;
  }) => Promise<readonly QAFinalizedAttachment[]>;
  /** Rejects only with BrowserDriverError. */
  confirmAttachments: () => Promise<void>;
  /** Rejects only with BrowserDriverError. */
  dispose: () => Promise<void>;
};

export type BrowserDriver = {
  id: "PLAYWRIGHT";
  /** Rejects only with BrowserDriverError; measured target/runtime failures are QADriverResult errors. */
  run: (qaRun: QARun, retestCells?: readonly QARetestCell[]) => Promise<BrowserDriverExecution>;
};

export type PlaywrightDriverOptions = {
  artifactsDirectory: string;
  timeoutMs?: number;
  slowRequestMs?: number;
  resolveHostname?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
};

type PendingAttachment = {
  draft: QAAttachmentDraft;
  filename: string;
  path: string;
};

const MAX_QA_WEBSOCKETS = 8;
const MAX_QA_WEBSOCKET_MESSAGES = 256;
const MAX_QA_WEBSOCKET_MESSAGE_BYTES = 1 * 1_024 * 1_024;
const MAX_QA_TOTAL_WEBSOCKET_BYTES = 4 * 1_024 * 1_024;
const NAVIGATION_INTERACTION_SETTLE_MS = 250;
const LOOPBACK_BROWSER_NETWORK_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks",
] as const;

const normalizeBrowserDriverError = (code: BrowserDriverErrorCode, error: unknown): BrowserDriverError => {
  let normalizedCode = code;
  try {
    if (error instanceof BrowserDriverError) {
      const candidateCode: unknown = error.code;
      if (isBrowserDriverErrorCode(candidateCode)) {
        normalizedCode = candidateCode;
      }
    }
  } catch {
    // A rejected value is untrusted at this boundary; even an accessor on `code` may throw.
  }
  return new BrowserDriverError(normalizedCode, browserDriverErrorMessages[normalizedCode], {
    cause: error,
  });
};

const normalizeBrowserDriverRun =
  (run: BrowserDriver["run"]): BrowserDriver["run"] =>
  async (input, retestCells) => {
    try {
      return await run(input, retestCells);
    } catch (error: unknown) {
      throw normalizeBrowserDriverError("DRIVER_SETUP_FAILED", error);
    }
  };

const safeSummary = (value: string): string =>
  value
    .replaceAll(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(
      /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replaceAll(/(?:file:\/\/)?\/(?:Users|home)\/[^\s"']+/g, "[local-path]")
    .replaceAll(/(?:file:\/\/)?\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"']+/g, "[local-path]")
    .replaceAll(/[A-Za-z]:[\\/](?:Users|Temp)[\\/][^\s"']+/g, "[local-path]")
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

class QAEvidenceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QAEvidenceLimitError";
  }
}

class QAOriginPolicyError extends Error {
  constructor(options?: ErrorOptions) {
    super("The localhost QA target did not resolve exclusively to loopback addresses", options);
    this.name = "QAOriginPolicyError";
  }
}

const sha256File = async (path: string): Promise<{ contentHash: string; byteSize: number }> => {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new Error("Browser QA evidence is not a non-empty regular file");
    }
    if (metadata.size > MAX_QA_ATTACHMENT_BYTES) {
      throw new QAEvidenceLimitError("Browser QA evidence exceeded the per-file size limit");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1_024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, metadata.size - position),
        position,
      );
      if (bytesRead === 0) throw new Error("Browser QA evidence was truncated while hashing");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { contentHash: `sha256:${hash.digest("hex")}`, byteSize: metadata.size };
  } finally {
    await handle.close();
  }
};

const isLoopbackAddress = (address: string): boolean => {
  if (address === "::1") return true;
  const mapped = /^::ffff:(127(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const candidate = mapped ?? address;
  const octets = candidate.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
};

const resolveTargetNetworkPolicy = async (
  targetOrigin: string,
  resolveHostname: NonNullable<PlaywrightDriverOptions["resolveHostname"]>,
): Promise<{ allowedOrigin: string; launchArgs: readonly string[] }> => {
  const target = new URL(targetOrigin);
  if (target.hostname !== "localhost") {
    return { allowedOrigin: target.origin, launchArgs: LOOPBACK_BROWSER_NETWORK_ARGS };
  }
  let addresses;
  try {
    addresses = await resolveHostname(target.hostname);
  } catch (error: unknown) {
    throw new QAOriginPolicyError({ cause: error });
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isLoopbackAddress(address))) {
    throw new QAOriginPolicyError();
  }
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!selected) throw new QAOriginPolicyError();
  const mappedAddress = selected.address.includes(":") ? `[${selected.address}]` : selected.address;
  return {
    allowedOrigin: target.origin,
    launchArgs: [...LOOPBACK_BROWSER_NETWORK_ARGS, `--host-resolver-rules=MAP localhost ${mappedAddress}`],
  };
};

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" || /(?:timeout|timed out).*\d+\s*ms/i.test(error.message));

const waitForAssertion = async (
  probe: () => Promise<boolean>,
  deadline: number,
): Promise<
  { passed: true } | { passed: false; error: { present: false } | { present: true; value: unknown } }
> => {
  let lastError: { present: false } | { present: true; value: unknown } = { present: false };
  do {
    try {
      if (await probe()) return { passed: true };
    } catch (error: unknown) {
      lastError = { present: true, value: error };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { passed: false, error: lastError };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
  } while (Date.now() < deadline);
  return { passed: false, error: lastError };
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

const bindReadOnlyWebSockets = async (input: {
  context: BrowserContext;
  allowedOrigin: string;
  targetId: string;
  currentScenarioId: () => string;
  observations: QAObservation[];
  onForbiddenOrigin: () => void;
  onInvalidEvidence: () => void;
}): Promise<void> => {
  let websocketCount = 0;
  let websocketMessageCount = 0;
  let websocketBytes = 0;
  let websocketLimitExceeded = false;
  const rejectWebSocketEvidence = (): void => {
    if (websocketLimitExceeded) return;
    websocketLimitExceeded = true;
    input.onInvalidEvidence();
    observation(input.observations, {
      kind: "NETWORK",
      severity: "ERROR",
      blocking: true,
      targetId: input.targetId,
      scenarioId: input.currentScenarioId(),
      summary: "Blocked WebSocket because the Browser QA evidence limit was exceeded.",
    });
  };
  const consumeWebSocketMessage = (message: string | Buffer): boolean => {
    const byteLength = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
    websocketMessageCount += 1;
    websocketBytes += byteLength;
    if (
      websocketMessageCount > MAX_QA_WEBSOCKET_MESSAGES ||
      byteLength > MAX_QA_WEBSOCKET_MESSAGE_BYTES ||
      websocketBytes > MAX_QA_TOTAL_WEBSOCKET_BYTES
    ) {
      rejectWebSocketEvidence();
      return false;
    }
    return true;
  };
  await input.context.routeWebSocket("**/*", async (socket) => {
    let websocketOrigin = "";
    try {
      const url = new URL(socket.url());
      if (url.protocol === "ws:") url.protocol = "http:";
      else if (url.protocol === "wss:") url.protocol = "https:";
      else throw new TypeError("Unsupported WebSocket protocol");
      websocketOrigin = url.origin;
    } catch {
      input.onForbiddenOrigin();
      await socket.close({ code: 1008, reason: "Blocked by Browser QA origin policy" });
      return;
    }
    if (websocketOrigin !== input.allowedOrigin) {
      input.onForbiddenOrigin();
      observation(input.observations, {
        kind: "NETWORK",
        severity: "ERROR",
        blocking: true,
        targetId: input.targetId,
        scenarioId: input.currentScenarioId(),
        summary: `Blocked off-origin WebSocket to ${websocketOrigin.slice(0, 300)}`,
      });
      await socket.close({ code: 1008, reason: "Blocked by Browser QA origin policy" });
      return;
    }
    websocketCount += 1;
    if (websocketCount > MAX_QA_WEBSOCKETS || socket.protocols().length > 0) {
      rejectWebSocketEvidence();
      await socket.close({ code: 1008, reason: "Blocked by Browser QA evidence policy" });
      return;
    }
    let server: WebSocketRoute;
    try {
      server = socket.connectToServer();
    } catch {
      rejectWebSocketEvidence();
      await socket.close({ code: 1011, reason: "Browser QA connection failed" });
      return;
    }
    // Browser QA is read-only: the handshake may unblock local development hydration, but the page
    // never gains a bidirectional command channel to the target.
    socket.onMessage((message) => {
      if (!consumeWebSocketMessage(message)) {
        void socket.close({ code: 1009, reason: "Browser QA evidence limit exceeded" });
        void server.close({ code: 1009, reason: "Browser QA evidence limit exceeded" });
      }
    });
    server.onMessage((message) => {
      if (consumeWebSocketMessage(message)) {
        socket.send(message);
        return;
      }
      void socket.close({ code: 1009, reason: "Browser QA evidence limit exceeded" });
      void server.close({ code: 1009, reason: "Browser QA evidence limit exceeded" });
    });
  });
};

const bindEvidenceListeners = async (input: {
  context: BrowserContext;
  page: Page;
  allowedOrigin: string;
  targetId: string;
  currentScenarioId: () => string;
  observations: QAObservation[];
  slowRequestMs: number;
  timeoutMs: number;
  onForbiddenOrigin: () => void;
  onUnsafeCapability: () => void;
  onInvalidEvidence: () => void;
  onTimeout: () => void;
}): Promise<void> => {
  const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  const started = new Map<string, number>();
  let requestCount = 0;
  let responseBytes = 0;
  const rejectEvidence = async (route: Route, summary: string) => {
    input.onInvalidEvidence();
    observation(input.observations, {
      kind: "NETWORK",
      severity: "ERROR",
      blocking: true,
      targetId: input.targetId,
      scenarioId: input.currentScenarioId(),
      summary,
    });
    await route.abort("blockedbyclient");
  };
  // Keyed by URL and released as soon as a request settles: a page polling unique URLs would
  // otherwise grow this map for the life of the context, aborted-by-cap requests included.
  input.page.on("request", (request) => started.set(request.url(), Date.now()));
  input.page.on("response", (response) => {
    const status = response.status();
    const targetId = input.targetId;
    const scenarioId = input.currentScenarioId();
    const startedAt = started.get(response.url());
    started.delete(response.url());
    const duration = Date.now() - (startedAt ?? Date.now());
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
    started.delete(request.url());
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
    requestCount += 1;
    if (requestCount > MAX_QA_REQUESTS) {
      await rejectEvidence(route, "Blocked request because the Browser QA request limit was exceeded.");
      return;
    }
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
    const sensitiveRequestHeaders = new Set(["authorization", "cookie", "proxy-authorization"]);
    const requestHeaders = await request.allHeaders();
    if (
      Object.entries(requestHeaders).some(
        ([headerName, value]) => sensitiveRequestHeaders.has(headerName.toLowerCase()) && value.length > 0,
      )
    ) {
      await rejectEvidence(route, "Blocked request carrying credentials outside the Browser QA capability.");
      return;
    }
    let response;
    try {
      response = await route.fetch({
        headers: requestHeaders,
        maxRedirects: 0,
        timeout: input.timeoutMs,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) input.onTimeout();
      await route.abort("failed").catch(() => undefined);
      return;
    }
    const responseHeaders = response.headers();
    await input.context.clearCookies();
    delete responseHeaders["set-cookie"];
    delete responseHeaders["set-cookie2"];
    const location = responseHeaders["location"];
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
    const declaredLength = responseHeaders["content-length"];
    if (declaredLength !== undefined && /^\d+$/.test(declaredLength)) {
      const byteSize = Number(declaredLength);
      if (byteSize > MAX_QA_RESPONSE_BYTES || responseBytes + byteSize > MAX_QA_TOTAL_RESPONSE_BYTES) {
        await rejectEvidence(route, "Blocked response because the Browser QA response limit was exceeded.");
        return;
      }
    }
    const body = await response.body();
    if (
      body.byteLength > MAX_QA_RESPONSE_BYTES ||
      responseBytes + body.byteLength > MAX_QA_TOTAL_RESPONSE_BYTES
    ) {
      await rejectEvidence(route, "Blocked response because the Browser QA response limit was exceeded.");
      return;
    }
    responseBytes += body.byteLength;
    await route.fulfill({ status: response.status(), headers: responseHeaders, body });
  });
};

const playwrightDriverOptionsSchema = z
  .object({
    artifactsDirectory: z.string().trim().min(1).max(32_768),
    timeoutMs: z.number().int().min(50).max(120_000).optional(),
    slowRequestMs: z.number().int().min(1).max(60_000).optional(),
  })
  .strict();

export const createPlaywrightDriver = (options: PlaywrightDriverOptions): BrowserDriver => {
  const parsedOptions = playwrightDriverOptionsSchema.parse({
    artifactsDirectory: options.artifactsDirectory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.slowRequestMs === undefined ? {} : { slowRequestMs: options.slowRequestMs }),
  });
  if (options.resolveHostname !== undefined && typeof options.resolveHostname !== "function") {
    throw new TypeError("Browser QA hostname resolver must be a function");
  }
  const timeoutMs = parsedOptions.timeoutMs ?? 10_000;
  const slowRequestMs = parsedOptions.slowRequestMs ?? 2_000;
  const resolveHostname =
    options.resolveHostname ?? (async (hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  return {
    id: "PLAYWRIGHT",
    run: normalizeBrowserDriverRun(async (input, retestCells): Promise<BrowserDriverExecution> => {
      const parsedRun = qaRunSchema.safeParse(input);
      if (!parsedRun.success) {
        throw new BrowserDriverError("INVALID_INPUT", "The Browser QA run input is invalid.");
      }
      const qaRun = parsedRun.data;
      const selectedCells =
        qaRun.scope.type === "FULL"
          ? (() => {
              if (retestCells !== undefined) {
                throw new BrowserDriverError(
                  "INVALID_INPUT",
                  "A full Browser QA run cannot receive a sparse retest scope.",
                );
              }
              return null;
            })()
          : (() => {
              const parsedCells = z.array(qaRetestCellSchema).min(1).safeParse(retestCells);
              if (!parsedCells.success) {
                throw new BrowserDriverError("INVALID_INPUT", "The Browser QA retest scope is invalid.");
              }
              const parsed = parsedCells.data;
              const baselineCells = new Set(
                qaRun.plan.targets.flatMap((target) =>
                  qaRun.plan.scenarios.map((scenario) => `${target.id}\u0000${scenario.id}`),
                ),
              );
              const keys = parsed.map(({ targetId, scenarioId }) => `${targetId}\u0000${scenarioId}`);
              if (new Set(keys).size !== keys.length || keys.some((key) => !baselineCells.has(key))) {
                throw new BrowserDriverError(
                  "INVALID_INPUT",
                  "The Browser QA retest scope is outside the locked baseline plan.",
                );
              }
              return new Set(keys);
            })();
      const runStorageSegment = `run-${createHash("sha256").update(qaRun.id).digest("hex").slice(0, 32)}`;
      const quarantineDirectory = await createBrowserQAQuarantineDirectory({
        artifactsDirectory: parsedOptions.artifactsDirectory,
        runStorageSegment,
      });
      const pendingAttachments: PendingAttachment[] = [];
      const executions: Extract<QADriverResult, { outcome: "MEASURED" }>["executions"] = [];
      const observations: QAObservation[] = [];
      const defects: QADefectDraft[] = [];
      const securityViolations = new Set<"FORBIDDEN_ORIGIN" | "UNSAFE_CAPABILITY" | "INVALID_EVIDENCE">();
      let targetUnavailable = false;
      let timedOut = false;
      let attachmentBytes = 0;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      let browserVersion = "unknown";
      let finalized = false;
      const hasTerminalFailure = (): boolean => securityViolations.size > 0 || timedOut || targetUnavailable;

      const confirmAttachments = async (): Promise<void> => {
        if (!finalized) return;
        try {
          await confirmBrowserQAArtifacts({
            artifactsDirectory: parsedOptions.artifactsDirectory,
            runStorageSegment,
          });
        } catch (error: unknown) {
          throw new BrowserDriverError(
            "ATTACHMENT_CONFIRMATION_FAILED",
            "Browser QA attachments could not be confirmed safely.",
            { cause: error },
          );
        }
      };

      const dispose = async (): Promise<void> => {
        if (finalized) return;
        try {
          await disposeBrowserQAQuarantineDirectory({
            artifactsDirectory: parsedOptions.artifactsDirectory,
            quarantineDirectory,
            runStorageSegment,
          });
        } catch (error: unknown) {
          throw new BrowserDriverError(
            "QUARANTINE_DISPOSAL_FAILED",
            "The Browser QA quarantine could not be disposed safely.",
            { cause: error },
          );
        }
      };

      try {
        const networkPolicy = await resolveTargetNetworkPolicy(qaRun.targetOrigin, resolveHostname);
        browser = await chromium.launch({ headless: true, args: [...networkPolicy.launchArgs] });
        browserVersion = browser.version();
        for (const [targetIndex, target] of qaRun.plan.targets.entries()) {
          const selectedScenarios = qaRun.plan.scenarios.filter(
            (scenario) => selectedCells === null || selectedCells.has(`${target.id}\u0000${scenario.id}`),
          );
          if (selectedScenarios.length === 0) continue;
          const context = await browser.newContext({
            viewport: target.viewport,
            locale: target.locale,
            colorScheme: target.theme === "DARK" ? "dark" : "light",
            acceptDownloads: false,
            serviceWorkers: "block",
          });
          context.setDefaultTimeout(timeoutMs);
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          let scenarioId = selectedScenarios[0]?.id ?? "baseline";
          await bindReadOnlyWebSockets({
            context,
            allowedOrigin: networkPolicy.allowedOrigin,
            targetId: target.id,
            currentScenarioId: () => scenarioId,
            observations,
            onForbiddenOrigin: () => {
              securityViolations.add("FORBIDDEN_ORIGIN");
            },
            onInvalidEvidence: () => {
              securityViolations.add("INVALID_EVIDENCE");
            },
          });
          const page = await context.newPage();
          await bindEvidenceListeners({
            context,
            page,
            allowedOrigin: networkPolicy.allowedOrigin,
            targetId: target.id,
            currentScenarioId: () => scenarioId,
            observations,
            slowRequestMs,
            timeoutMs,
            onForbiddenOrigin: () => {
              securityViolations.add("FORBIDDEN_ORIGIN");
            },
            onUnsafeCapability: () => {
              securityViolations.add("UNSAFE_CAPABILITY");
            },
            onInvalidEvidence: () => {
              securityViolations.add("INVALID_EVIDENCE");
            },
            onTimeout: () => {
              timedOut = true;
            },
          });

          for (const scenario of selectedScenarios) {
            const scenarioIndex = qaRun.plan.scenarios.findIndex(({ id }) => id === scenario.id);
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
                    const navigationDeadline = Date.now() + timeoutMs;
                    const response = await page.goto(`${qaRun.targetOrigin}${step.action.path}`, {
                      waitUntil: "domcontentloaded",
                      timeout: timeoutMs,
                    });
                    if (!response?.ok())
                      throw new Error(
                        `Navigation returned ${response?.status().toString() ?? "no response"}`,
                      );
                    const loadBudgetMs = navigationDeadline - Date.now();
                    if (loadBudgetMs <= 0)
                      throw new Error(`Navigation timed out after ${timeoutMs.toString()} ms`);
                    await page.waitForLoadState("load", { timeout: loadBudgetMs });
                    // Locator actionability cannot tell whether a server-rendered control has a
                    // client handler yet. Give already-loaded framework work one short, fixed,
                    // driver-owned turn without waiting for application polling to become idle.
                    const settleBudgetMs = Math.min(
                      NAVIGATION_INTERACTION_SETTLE_MS,
                      navigationDeadline - Date.now(),
                    );
                    if (settleBudgetMs > 0) await page.waitForTimeout(settleBudgetMs);
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
                if (isTimeoutError(error)) timedOut = true;
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

            if (!hasTerminalFailure()) {
              const assertionDeadline = Date.now() + timeoutMs;
              for (const assertion of scenario.assertions) {
                const settled = await waitForAssertion(async () => {
                  switch (assertion.rule.type) {
                    case "VISIBLE":
                      return locatorFor(page, assertion.rule.locator).isVisible();
                    case "TEXT_CONTAINS": {
                      const actual = await locatorFor(page, assertion.rule.locator).textContent();
                      return actual?.includes(assertion.rule.expected) === true;
                    }
                    case "URL_PATH":
                      return pathOfUrl(page.url()) === assertion.rule.path;
                    case "NO_HORIZONTAL_OVERFLOW":
                      return page.evaluate<boolean>(
                        "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
                      );
                    case "FOCUSED":
                      return locatorFor(page, assertion.rule.locator).evaluate((element: object) => {
                        const ownerDocument: unknown = Reflect.get(element, "ownerDocument");
                        return (
                          typeof ownerDocument === "object" &&
                          ownerDocument !== null &&
                          element === Reflect.get(ownerDocument, "activeElement")
                        );
                      });
                  }
                }, assertionDeadline);
                const passed = settled.passed;
                let details = settled.passed
                  ? null
                  : settled.error.present
                    ? errorSummary(settled.error.value)
                    : assertion.rule.type === "TEXT_CONTAINS"
                      ? safeSummary(`Expected text containing “${assertion.rule.expected}”.`)
                      : null;
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
                assertionResults.push({
                  id: assertion.id,
                  status: passed ? "PASSED" : "FAILED",
                  details,
                });
              }
            }

            if (!hasTerminalFailure()) {
              const screenshotFilename = `target-${(targetIndex + 1).toString()}--scenario-${(
                scenarioIndex + 1
              ).toString()}.png`;
              const screenshotPath = join(quarantineDirectory, screenshotFilename);
              try {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                const metadata = await sha256File(screenshotPath);
                if (attachmentBytes + metadata.byteSize > MAX_QA_TOTAL_ATTACHMENT_BYTES) {
                  throw new QAEvidenceLimitError("Browser QA evidence exceeded the per-run size limit");
                }
                attachmentBytes += metadata.byteSize;
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
                if (error instanceof QAEvidenceLimitError) {
                  securityViolations.add("INVALID_EVIDENCE");
                }
                defect(defects, {
                  severity: "HIGH",
                  title: `Screenshot capture failed: ${scenario.title}`,
                  description: errorSummary(error),
                  reproduction: [`Run scenario “${scenario.title}” on target ${target.id}.`],
                  targetId: target.id,
                  scenarioId: scenario.id,
                });
              }
            }
            executions.push({
              targetId: target.id,
              scenarioId: scenario.id,
              durationMs: Date.now() - executionStarted,
              steps: stepResults,
              assertions: assertionResults,
            });
            if (hasTerminalFailure()) break;
          }

          const traceFilename = `target-${(targetIndex + 1).toString()}--trace.zip`;
          const tracePath = join(quarantineDirectory, traceFilename);
          if (hasTerminalFailure()) {
            await context.tracing.stop().catch(() => undefined);
          } else {
            try {
              await context.tracing.stop({ path: tracePath });
              const metadata = await sha256File(tracePath);
              if (attachmentBytes + metadata.byteSize > MAX_QA_TOTAL_ATTACHMENT_BYTES) {
                throw new QAEvidenceLimitError("Browser QA evidence exceeded the per-run size limit");
              }
              attachmentBytes += metadata.byteSize;
              const firstScenario = selectedScenarios[0];
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
              if (error instanceof QAEvidenceLimitError) {
                securityViolations.add("INVALID_EVIDENCE");
              }
              const firstScenario = selectedScenarios[0];
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
          }
          await context.close();
          if (hasTerminalFailure()) break;
        }
      } catch (error: unknown) {
        await browser?.close().catch(() => undefined);
        const result = qaDriverResultSchema.parse({
          outcome: "ERROR",
          code: error instanceof QAOriginPolicyError ? "ORIGIN_FORBIDDEN" : "DRIVER_CRASHED",
          summary:
            error instanceof QAOriginPolicyError
              ? "The localhost QA target did not resolve exclusively to loopback addresses."
              : errorSummary(error),
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
            : securityViolations.has("INVALID_EVIDENCE")
              ? {
                  outcome: "ERROR",
                  code: "EVIDENCE_INVALID",
                  summary: "Browser QA evidence exceeded a deterministic safety limit.",
                }
              : timedOut
                ? {
                    outcome: "ERROR",
                    code: "TIMEOUT",
                    summary: "Browser QA exceeded its deterministic execution timeout.",
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
        try {
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
            artifactsDirectory: parsedOptions.artifactsDirectory,
            quarantineDirectory,
            runStorageSegment,
            qaRunId: qaRun.id,
            attachments: refs,
          });
          finalized = true;
          return refs;
        } catch (error: unknown) {
          throw new BrowserDriverError(
            "ATTACHMENT_FINALIZATION_FAILED",
            "Browser QA attachments could not be finalized safely.",
            { cause: error },
          );
        }
      };
      return { result, finalizeAttachments, confirmAttachments, dispose };
    }),
  };
};
