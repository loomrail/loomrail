import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type { ProviderOutcome, ProviderUsage } from "@loomrail/contracts";
import { modelTierSchema } from "@loomrail/contracts";
import {
  decodeProviderStageResult,
  describeUnproductiveSession,
  localProviderRuntimeEnvironment,
  providerCapabilitiesSchema,
  providerMcpConnectionSchema,
  providerModelIdSchema,
  providerModelMappingSchema,
  providerStageResultSchemaFor,
  ProcessSpawnError,
  runProcess,
  type DecodedProviderStageResult,
  type ProcessExitOutcome,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderModelMapping,
  type ProviderSessionListener,
  type ProviderStageResultPolicy,
} from "@loomrail/provider-core";
import { z } from "zod";

import { readCodexAllowance } from "./allowance.js";
import { parseCodexEvent, TERMINAL_TURN_EVENT } from "./stream.js";

export {
  classifyCodexAuthenticationMode,
  codexProviderDiagnostics,
  codexRateLimitReportingTargetVerified,
  probeCodexAuthenticationMode,
  type CodexAuthenticationMode,
} from "./diagnostics.js";
export {
  codexRateLimitsProjectionSchema,
  normalizeCodexRateLimits,
  readCodexAllowance,
  type CodexRateLimitsProjection,
  type ReadCodexAllowanceOptions,
} from "./allowance.js";
export type { CodexEvent } from "./stream.js";
export { parseCodexEvent, TERMINAL_TURN_EVENT } from "./stream.js";

const SESSION_DEADLINE_MS = 600_000;
const PROCESS_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MODELS = {
  FAST: "gpt-5.6-luna",
  STANDARD: "gpt-5.6-terra",
  DEEP: "gpt-5.6-sol",
} as const satisfies ProviderModelMapping;

const DISABLED_BUILTIN_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "hooks",
  "image_generation",
  "plugins",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "view_image",
  "workspace_dependencies",
] as const;

export type CreateCodexProviderOptions = {
  command?: string;
  commandArgsPrefix?: readonly string[];
  contextWindowTokens?: number;
  models?: Partial<ProviderModelMapping>;
  environment?: Readonly<Record<string, string | undefined>>;
};

type ResolvedOptions = {
  command: string;
  commandArgsPrefix: readonly string[];
  contextWindowTokens: number;
  models: ProviderModelMapping;
  environment: NodeJS.ProcessEnv;
};

const executableAvailable = (
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): boolean => {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (environment["PATH"] ?? environment["Path"] ?? "")
          .split(delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

const resolveOptions = (options: CreateCodexProviderOptions): ResolvedOptions => {
  const sourceEnvironment = options.environment ?? process.env;
  return {
    command: options.command ?? "codex",
    commandArgsPrefix: options.commandArgsPrefix ?? [],
    contextWindowTokens: options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    models: providerModelMappingSchema.parse({ ...DEFAULT_MODELS, ...options.models }),
    environment: localProviderRuntimeEnvironment(sourceEnvironment),
  };
};

const stagePolicy = (invocation: ProviderInvocation): ProviderStageResultPolicy => ({
  humanRequests: invocation.humanRequests,
  acceptanceInput: invocation.acceptanceInput,
});

const tryParseStructuredResult = (
  text: string,
  invocation: ProviderInvocation,
): DecodedProviderStageResult | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return decodeProviderStageResult(invocation.session.stage, candidate, stagePolicy(invocation));
};

type SessionRuntime = { stop: () => Promise<void> };

/** Local official Codex CLI adapter. Authentication remains entirely inside Codex. */
export const createCodexProvider = (options: CreateCodexProviderOptions = {}): ProviderAdapter => {
  const resolved = resolveOptions(options);
  const cliAvailable = executableAvailable(resolved.command, resolved.environment);
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    modelMapping: () => ({ ...resolved.models }),
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CODEX",
        start: cliAvailable,
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        contextWindowReporting: true,
        checkpointOnRequest: false,
        contextWindowTokens: resolved.contextWindowTokens,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
        tokenBudgetEnforcement: "POST_SESSION",
        canReportRateLimits: true,
      }),
    readAllowance: () =>
      readCodexAllowance({
        command: resolved.command,
        commandArgsPrefix: resolved.commandArgsPrefix,
      }),
    start: async (
      invocation: ProviderInvocation,
      listener: ProviderSessionListener,
    ): Promise<ProviderOutcome> => {
      const scratchDirectory = await mkdtemp(join(tmpdir(), "loomrail-codex-"));
      try {
        const schemaPath = join(scratchDirectory, "stage-result.schema.json");
        await writeFile(
          schemaPath,
          JSON.stringify(
            z.toJSONSchema(providerStageResultSchemaFor(invocation.session.stage, stagePolicy(invocation))),
          ),
          { encoding: "utf8", mode: 0o600 },
        );
        const connections = providerMcpConnectionSchema.array().max(64).parse(invocation.mcpConnections);
        // GPT-5.6 Codex models use code-mode-only metadata. If every MCP namespace is left in the
        // nested code-mode surface, disabling the general JavaScript host also makes the bounded
        // Loomrail tools unreachable. Keep only the explicitly supplied session namespaces as
        // direct top-level tools; the general code-mode host remains disabled below.
        const directToolNamespaces = connections.map((connection) => `mcp__${connection.id}`);
        const codeModeArguments =
          directToolNamespaces.length === 0
            ? []
            : [
                "-c",
                "features.code_mode.enabled=true",
                "-c",
                `features.code_mode.direct_only_tool_namespaces=${JSON.stringify(directToolNamespaces)}`,
              ];
        const mcpArguments = connections.flatMap((connection) => [
          "-c",
          `mcp_servers.${connection.id}.command=${JSON.stringify(connection.proxyCommand)}`,
          "-c",
          `mcp_servers.${connection.id}.args=${JSON.stringify(connection.proxyArgs)}`,
          "-c",
          `mcp_servers.${connection.id}.enabled_tools=${JSON.stringify(connection.enabledTools)}`,
          // This approves only the already allowlisted Loomrail MCP surface. The executor remains
          // the authority for read/write/recipe permission, CAS, audit and recovery; without this
          // setting non-interactive `codex exec` cancels every MCP call at its UI approval layer.
          "-c",
          `mcp_servers.${connection.id}.default_tools_approval_mode="approve"`,
        ]);
        const model = providerModelIdSchema.parse(
          invocation.modelId ?? resolved.models[modelTierSchema.parse(invocation.modelTier)],
        );
        const args = [
          "exec",
          "--json",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          ...codeModeArguments,
          ...DISABLED_BUILTIN_FEATURES.flatMap((feature) => ["--disable", feature]),
          "--model",
          model,
          ...mcpArguments,
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "-C",
          scratchDirectory,
          "--output-schema",
          schemaPath,
          invocation.contextPack.text,
        ];

        let result: DecodedProviderStageResult | undefined;
        let completedUsage: ProviderUsage | undefined;
        let providerFailureText: string | undefined;
        const providerFailure = { rateLimited: false };
        let linesReceived = 0;
        let linesUnused = 0;
        let linesUnreadable = 0;

        invocation.authoritySignal.throwIfAborted();
        const run = runProcess({
          command: resolved.command,
          args: [...resolved.commandArgsPrefix, ...args],
          cwd: scratchDirectory,
          environment: resolved.environment,
          onLine: (line) => {
            linesReceived += 1;
            const event = parseCodexEvent(line);
            if (event === null) {
              const decoded = tryParseStructuredResult(line, invocation);
              if (decoded === null) {
                linesUnused += 1;
                linesUnreadable += 1;
              } else {
                result = decoded;
                if (decoded.checkpoint !== null) listener.onCheckpoint(decoded.checkpoint);
              }
              return;
            }
            switch (event.type) {
              case "item.completed": {
                const decoded = tryParseStructuredResult(event.item.text, invocation);
                if (decoded === null) {
                  linesUnused += 1;
                } else {
                  result = decoded;
                  if (decoded.checkpoint !== null) listener.onCheckpoint(decoded.checkpoint);
                }
                return;
              }
              case "turn.completed": {
                const usage: ProviderUsage = { ...event.usage, quality: "ACTUAL" };
                completedUsage = usage;
                listener.onUsage(usage);
                listener.onContextWindow({
                  usedTokens: Math.min(usage.inputTokens, resolved.contextWindowTokens),
                  windowTokens: resolved.contextWindowTokens,
                  quality: "ACTUAL",
                });
                return;
              }
              case "turn.failed":
                providerFailureText = event.errorMessage;
                providerFailure.rateLimited = event.rateLimited;
                return;
              case "thread.started":
              case "turn.started":
              case "item.ignored":
                linesUnused += 1;
                return;
            }
          },
          onStderr: () => undefined,
          deadlineMs: SESSION_DEADLINE_MS,
          graceMs: PROCESS_TERMINATION_GRACE_MS,
        });
        runningSessions.set(invocation.session.id, { stop: run.stop });
        if (run.pid !== undefined) listener.onProcessStarted?.(run.pid);
        let exit: ProcessExitOutcome;
        try {
          exit = await run.exited;
        } catch (error: unknown) {
          if (!(error instanceof ProcessSpawnError)) throw error;
          return describeUnproductiveSession({
            provider: "CODEX",
            command: resolved.command,
            reason: "SPAWN_FAILED",
            exitCode: null,
            signal: null,
            linesReceived,
            linesUnused,
            linesUnreadable,
            providerText: null,
          });
        }
        const endedNormally = exit.code === 0 && exit.signal === null;
        if (endedNormally && completedUsage !== undefined && result !== undefined) return result.outcome;
        return describeUnproductiveSession({
          provider: "CODEX",
          command: resolved.command,
          reason: providerFailure.rateLimited
            ? "PROVIDER_RATE_LIMITED"
            : providerFailureText !== undefined
              ? "PROVIDER_REPORTED_FAILURE"
              : result === undefined
                ? "NO_STRUCTURED_RESULT"
                : endedNormally
                  ? "TERMINAL_TURN_EVENT_MISSING"
                  : "SESSION_ENDED_UNFINISHED",
          terminalEvent: TERMINAL_TURN_EVENT,
          exitCode: exit.code,
          signal: exit.signal,
          linesReceived,
          linesUnused,
          linesUnreadable,
          providerText: providerFailureText ?? null,
        });
      } finally {
        runningSessions.delete(invocation.session.id);
        await rm(scratchDirectory, { recursive: true, force: true });
      }
    },
    requestHandoff: () => Promise.resolve(),
    abortSession: async (sessionId) => {
      await runningSessions.get(sessionId)?.stop();
    },
  };
};
