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
  LOCAL_PROVIDER_SESSION_DEADLINE_MS,
  providerCapabilitiesSchema,
  providerMcpConnectionSchema,
  providerModelIdSchema,
  providerModelMappingSchema,
  providerStageResultSchemaFor,
  ProcessSpawnError,
  renderProviderInvocationPrompt,
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

import { parseClaudeEvent } from "./stream.js";

export { claudeCodeProviderDiagnostics } from "./diagnostics.js";
export type { ClaudeEvent } from "./stream.js";
export { parseClaudeEvent } from "./stream.js";

const PROCESS_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_MODELS = {
  FAST: "claude-haiku-4-5-20251001",
  STANDARD: "claude-sonnet-5",
  DEEP: "claude-opus-5",
} as const satisfies ProviderModelMapping;

export type CreateClaudeCodeProviderOptions = {
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

const resolveOptions = (options: CreateClaudeCodeProviderOptions): ResolvedOptions => {
  const sourceEnvironment = options.environment ?? process.env;
  return {
    command: options.command ?? "claude",
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

const stageResultSchema = (invocation: ProviderInvocation): string => {
  const schema: Record<string, unknown> = {
    ...z.toJSONSchema(providerStageResultSchemaFor(invocation.session.stage, stagePolicy(invocation))),
  };
  Reflect.deleteProperty(schema, "$schema");
  return JSON.stringify(schema);
};

const decodeResult = (
  event: { text: string; structuredOutput?: unknown },
  invocation: ProviderInvocation,
): DecodedProviderStageResult | null => {
  if (event.structuredOutput !== undefined) {
    const structured = decodeProviderStageResult(
      invocation.session.stage,
      event.structuredOutput,
      stagePolicy(invocation),
    );
    if (structured !== null) return structured;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(event.text) as unknown;
  } catch {
    return null;
  }
  return decodeProviderStageResult(invocation.session.stage, candidate, stagePolicy(invocation));
};

type SessionRuntime = { stop: () => Promise<void> };

/** Local official Claude Code adapter. Authentication remains entirely inside Claude Code. */
export const createClaudeCodeProvider = (options: CreateClaudeCodeProviderOptions = {}): ProviderAdapter => {
  const resolved = resolveOptions(options);
  const cliAvailable = executableAvailable(resolved.command, resolved.environment);
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    modelMapping: () => ({ ...resolved.models }),
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CLAUDE_CODE",
        start: cliAvailable,
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        contextWindowReporting: true,
        checkpointOnRequest: false,
        contextWindowTokens: resolved.contextWindowTokens,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: true,
        tokenBudgetEnforcement: "POST_SESSION",
        canReportRateLimits: false,
      }),
    start: async (
      invocation: ProviderInvocation,
      listener: ProviderSessionListener,
    ): Promise<ProviderOutcome> => {
      const scratchDirectory = await mkdtemp(join(tmpdir(), "loomrail-claude-"));
      try {
        const connections = providerMcpConnectionSchema.array().max(64).parse(invocation.mcpConnections);
        const allowedTools = connections.flatMap((connection) =>
          connection.enabledTools.map((tool) => `mcp__${connection.id}__${tool}`),
        );
        const mcpConfigPath = join(scratchDirectory, "mcp-config.json");
        await writeFile(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: Object.fromEntries(
              connections.map((connection) => [
                connection.id,
                { type: "stdio", command: connection.proxyCommand, args: connection.proxyArgs },
              ]),
            ),
          }),
          { encoding: "utf8", mode: 0o600 },
        );
        const model = providerModelIdSchema.parse(
          invocation.modelId ?? resolved.models[modelTierSchema.parse(invocation.modelTier)],
        );
        const args = [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--restricted",
          "--setting-sources",
          "",
          "--mcp-config",
          mcpConfigPath,
          "--strict-mcp-config",
          "--tools",
          "",
          ...(allowedTools.length === 0 ? [] : ["--allowedTools", ...allowedTools]),
          "--permission-mode",
          "dontAsk",
          "--no-chrome",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--max-turns",
          "33",
          "--model",
          model,
          "--json-schema",
          stageResultSchema(invocation),
          renderProviderInvocationPrompt(invocation),
        ];

        let outcome: ProviderOutcome | undefined;
        let usage: ProviderUsage | undefined;
        let providerFailureText: string | undefined;
        const providerFailure = { rateLimited: false };
        let linesReceived = 0;
        let linesUnused = 0;

        invocation.authoritySignal.throwIfAborted();
        const run = runProcess({
          command: resolved.command,
          args: [...resolved.commandArgsPrefix, ...args],
          cwd: scratchDirectory,
          environment: resolved.environment,
          onLine: (line) => {
            linesReceived += 1;
            const event = parseClaudeEvent(line);
            if (event === null) {
              linesUnused += 1;
              return;
            }
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cachedInputTokens: event.cachedInputTokens,
              costUsd: event.costUsd,
              quality: "ACTUAL",
            };
            listener.onUsage(usage);
            listener.onContextWindow({
              usedTokens: Math.min(event.inputTokens, resolved.contextWindowTokens),
              windowTokens: resolved.contextWindowTokens,
              quality: "ACTUAL",
            });
            if (!event.ok) {
              providerFailureText = event.text;
              providerFailure.rateLimited = event.rateLimited;
              return;
            }
            const decoded = decodeResult(event, invocation);
            if (decoded !== null) {
              outcome = decoded.outcome;
              if (decoded.checkpoint !== null) listener.onCheckpoint(decoded.checkpoint);
            }
          },
          onStderr: () => undefined,
          deadlineMs: LOCAL_PROVIDER_SESSION_DEADLINE_MS,
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
            provider: "CLAUDE_CODE",
            command: resolved.command,
            reason: "SPAWN_FAILED",
            exitCode: null,
            signal: null,
            linesReceived,
            linesUnused,
            providerText: null,
          });
        }
        if (exit.code === 0 && exit.signal === null && usage !== undefined && outcome !== undefined) {
          return outcome;
        }
        return describeUnproductiveSession({
          provider: "CLAUDE_CODE",
          command: resolved.command,
          reason: providerFailure.rateLimited
            ? "PROVIDER_RATE_LIMITED"
            : providerFailureText !== undefined
              ? "PROVIDER_REPORTED_FAILURE"
              : outcome === undefined
                ? "NO_STRUCTURED_RESULT"
                : "SESSION_ENDED_UNFINISHED",
          exitCode: exit.code,
          signal: exit.signal,
          linesReceived,
          linesUnused,
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
