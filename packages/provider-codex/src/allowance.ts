import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  providerAllowanceSnapshotSchema,
  type ProviderAllowanceBucket,
  type ProviderAllowanceUnavailableReason,
  type ProviderAllowanceSnapshot,
} from "@loomrail/contracts";
import { z } from "zod";

const MAX_UNIX_SECONDS = 8_640_000_000_000;
const DEFAULT_READ_DEADLINE_MS = 3_000;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_RESPONSE_LINE_BYTES = 32 * 1_024;
const INITIALIZE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const limitIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const rateLimitReachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const codexRateLimitWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    windowDurationMins: z.number().int().positive().max(527_040),
    resetsAt: z.number().int().positive().max(MAX_UNIX_SECONDS),
  })
  .strict();

const codexRateLimitGroupSchema = z
  .object({
    limitId: limitIdSchema,
    limitName: z.string().trim().min(1).max(96).nullable().optional(),
    primary: codexRateLimitWindowSchema.nullable(),
    secondary: codexRateLimitWindowSchema.nullable(),
    rateLimitReachedType: rateLimitReachedTypeSchema.nullable().optional(),
  })
  .strict();

const codexRateLimitWindowWireSchema = z
  .looseObject({
    usedPercent: z.unknown(),
    windowDurationMins: z.unknown().nullable().optional(),
    resetsAt: z.unknown().nullable().optional(),
  })
  .nullable()
  .optional();

const codexRateLimitGroupWireSchema = z.looseObject({
  limitId: z.unknown().nullable().optional(),
  limitName: z.unknown().nullable().optional(),
  primary: codexRateLimitWindowWireSchema,
  secondary: codexRateLimitWindowWireSchema,
  rateLimitReachedType: z.unknown().nullable().optional(),
});

export const codexRateLimitsProjectionSchema = z
  .object({
    rateLimits: codexRateLimitGroupSchema.nullable(),
    rateLimitsByLimitId: z.record(limitIdSchema, codexRateLimitGroupSchema).nullable().optional(),
  })
  .strict()
  .superRefine((projection, context) => {
    for (const [key, group] of Object.entries(projection.rateLimitsByLimitId ?? {})) {
      if (key !== group.limitId) {
        context.addIssue({
          code: "custom",
          path: ["rateLimitsByLimitId", key, "limitId"],
          message: "Codex rate-limit map key must match its limit id",
        });
      }
    }
  });

export type CodexRateLimitsProjection = z.infer<typeof codexRateLimitsProjectionSchema>;

export type ReadCodexAllowanceOptions = {
  command?: string;
  commandArgsPrefix?: readonly string[];
  deadlineMs?: number;
  terminationGraceMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};

const unavailableSnapshot = (
  observedAt: string,
  reason: ProviderAllowanceUnavailableReason,
): ProviderAllowanceSnapshot =>
  providerAllowanceSnapshotSchema.parse({
    schemaVersion: 1,
    provider: "CODEX",
    observedAt,
    freshness: "UNAVAILABLE",
    buckets: [],
    unavailableReason: reason,
  });

const projectWindow = (
  value: z.infer<typeof codexRateLimitWindowWireSchema>,
): z.infer<typeof codexRateLimitWindowSchema> | null => {
  if (value?.windowDurationMins == null || value.resetsAt == null) return null;
  return codexRateLimitWindowSchema.parse({
    usedPercent: value.usedPercent,
    windowDurationMins: value.windowDurationMins,
    resetsAt: value.resetsAt,
  });
};

const projectGroup = (value: unknown, fallbackLimitId: string): z.infer<typeof codexRateLimitGroupSchema> => {
  const source = codexRateLimitGroupWireSchema.parse(value);
  return codexRateLimitGroupSchema.parse({
    limitId: source.limitId ?? fallbackLimitId,
    limitName: source.limitName ?? null,
    primary: projectWindow(source.primary),
    secondary: projectWindow(source.secondary),
    rateLimitReachedType: source.rateLimitReachedType ?? null,
  });
};

// The App Server response also carries account/plan/credit/spend-control fields. They are not part
// of Loomrail's contract and must never cross the adapter seam, so every nested allowance value is
// selected field-by-field before the closed projection is validated. Provider-owned additions are
// ignored; malformed values in an admitted field still fail closed. Current App Server schemas
// allow a nullable limit id in a map entry, where the validated map key is the stable fallback, and
// nullable window/reset values, where there is not enough evidence to publish that window.
const projectRateLimits = (value: unknown): CodexRateLimitsProjection => {
  const source = z
    .looseObject({
      rateLimits: z.unknown(),
      rateLimitsByLimitId: z.record(limitIdSchema, z.unknown()).nullable().optional(),
    })
    .parse(value);
  return codexRateLimitsProjectionSchema.parse({
    rateLimits: source.rateLimits === null ? null : projectGroup(source.rateLimits, "codex"),
    ...(source.rateLimitsByLimitId === undefined
      ? {}
      : {
          rateLimitsByLimitId:
            source.rateLimitsByLimitId === null
              ? null
              : Object.fromEntries(
                  Object.entries(source.rateLimitsByLimitId).map(([limitId, group]) => [
                    limitId,
                    projectGroup(group, limitId),
                  ]),
                ),
        }),
  });
};

const toBucket = (
  group: z.infer<typeof codexRateLimitGroupSchema>,
  slot: "primary" | "secondary",
): ProviderAllowanceBucket | null => {
  const window = group[slot];
  if (window === null) return null;
  // App Server's reached type explains the account/workspace cause, not whether the primary or
  // secondary window caused it. Applying that group-level value to either bucket would invent
  // per-window evidence and could choose the wrong reset. A bucket is reached only when its own
  // bounded percentage proves it; structured terminal 429 handling remains the source of an
  // immediate provider-rate-limit Attention item.
  const limitReached = window.usedPercent >= 100;
  return {
    id: `${group.limitId}:${slot}`,
    name: group.limitName ?? group.limitId,
    kind: slot === "primary" ? "PRIMARY" : "SECONDARY",
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    windowDurationMins: window.windowDurationMins,
    resetsAt: new Date(window.resetsAt * 1_000).toISOString(),
    limitReached,
  };
};

export const normalizeCodexRateLimits = (value: unknown, observedAt: string): ProviderAllowanceSnapshot => {
  const projection = codexRateLimitsProjectionSchema.parse(value);
  const grouped = Object.values(projection.rateLimitsByLimitId ?? {}).sort((left, right) =>
    left.limitId.localeCompare(right.limitId),
  );
  const groups = grouped.length > 0 ? grouped : projection.rateLimits === null ? [] : [projection.rateLimits];
  const buckets = groups.flatMap((group) =>
    ([toBucket(group, "primary"), toBucket(group, "secondary")] as const).filter(
      (bucket): bucket is ProviderAllowanceBucket => bucket !== null,
    ),
  );

  return providerAllowanceSnapshotSchema.parse(
    buckets.length === 0
      ? {
          schemaVersion: 1,
          provider: "CODEX",
          observedAt,
          freshness: "UNAVAILABLE",
          buckets: [],
          unavailableReason: "DATA_NOT_PRESENT",
        }
      : {
          schemaVersion: 1,
          provider: "CODEX",
          observedAt,
          freshness: "LIVE",
          buckets,
          unavailableReason: null,
        },
  );
};

const allowanceEnvironment = (source: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv => {
  const keys = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
};

const validatedDuration = (value: number | undefined, fallback: number): number =>
  z
    .number()
    .int()
    .positive()
    .max(30_000)
    .parse(value ?? fallback);

type ReadState = {
  initialized: boolean;
  result: ProviderAllowanceSnapshot | null;
  failure: ProviderAllowanceUnavailableReason | null;
};

/**
 * Perform one bounded, read-only Codex App Server allowance request.
 *
 * This transport deliberately does not expose a generic JSON-RPC `send`: its complete outbound
 * vocabulary is the initialize handshake and `account/rateLimits/read`. That makes starting a
 * model turn, logging in, consuming a reset or touching a repository unrepresentable here.
 */
export const readCodexAllowance = async (
  options: ReadCodexAllowanceOptions = {},
): Promise<ProviderAllowanceSnapshot> => {
  const deadlineMs = validatedDuration(options.deadlineMs, DEFAULT_READ_DEADLINE_MS);
  const terminationGraceMs = validatedDuration(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS);
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const workingDirectory = await mkdtemp(join(tmpdir(), "loomrail-codex-allowance-"));

  try {
    return await new Promise<ProviderAllowanceSnapshot>((resolve) => {
      const state: ReadState = { initialized: false, result: null, failure: null };
      let settled = false;
      let closeObserved = false;
      let totalBytes = 0;
      let buffered: Buffer = Buffer.alloc(0);
      let discardingOverlongLine = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(
        options.command ?? "codex",
        [...(options.commandArgsPrefix ?? []), "app-server", "--listen", "stdio://"],
        {
          cwd: workingDirectory,
          env: allowanceEnvironment(options.environment ?? process.env),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const snapshotForFailure = (): ProviderAllowanceSnapshot =>
        unavailableSnapshot(observedAt, state.failure ?? "PROVIDER_UNAVAILABLE");
      const settleAfterClose = (): void => {
        if (settled || !closeObserved) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(killTimer);
        resolve(state.result ?? snapshotForFailure());
      };
      const terminate = (): void => {
        if (closeObserved) {
          settleAfterClose();
          return;
        }
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
        killTimer.unref();
      };
      const fail = (reason: ProviderAllowanceUnavailableReason): void => {
        if (state.result !== null || state.failure !== null) return;
        state.failure = reason;
        terminate();
      };
      const send = (message: unknown): void => {
        if (state.failure !== null || state.result !== null || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const acceptRateLimits = (value: unknown): void => {
        if (state.result !== null || state.failure !== null) return;
        try {
          state.result = normalizeCodexRateLimits(projectRateLimits(value), observedAt);
          terminate();
        } catch {
          fail("PROVIDER_SCHEMA_DRIFT");
        }
      };
      const onLine = (line: Buffer): void => {
        if (state.failure !== null || state.result !== null) return;
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          fail("PROVIDER_SCHEMA_DRIFT");
          return;
        }
        const message = z.record(z.string(), z.unknown()).safeParse(value);
        if (!message.success) {
          fail("PROVIDER_SCHEMA_DRIFT");
          return;
        }
        const id = message.data["id"];
        const method = message.data["method"];

        if (id === INITIALIZE_REQUEST_ID) {
          if (state.initialized) {
            fail("PROVIDER_SCHEMA_DRIFT");
            return;
          }
          if ("error" in message.data) {
            fail("PROVIDER_UNAVAILABLE");
            return;
          }
          if (!("result" in message.data)) {
            fail("PROVIDER_SCHEMA_DRIFT");
            return;
          }
          state.initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: RATE_LIMITS_REQUEST_ID, method: "account/rateLimits/read", params: null });
          return;
        }

        if (id === RATE_LIMITS_REQUEST_ID) {
          if (!state.initialized) {
            fail("PROVIDER_SCHEMA_DRIFT");
            return;
          }
          if ("error" in message.data) {
            fail("PROVIDER_UNAVAILABLE");
            return;
          }
          if (!("result" in message.data)) {
            fail("PROVIDER_SCHEMA_DRIFT");
            return;
          }
          acceptRateLimits(message.data["result"]);
          return;
        }

        if (method === "account/rateLimits/updated") {
          if (!state.initialized || !("params" in message.data)) return;
          acceptRateLimits(message.data["params"]);
          return;
        }

        if (id !== undefined) fail("PROVIDER_SCHEMA_DRIFT");
      };
      const pushOutput = (chunk: Buffer): void => {
        if (state.failure !== null || state.result !== null) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          fail("PROVIDER_SCHEMA_DRIFT");
          return;
        }
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
        let newlineIndex = buffered.indexOf(0x0a);
        while (newlineIndex !== -1) {
          const rawLine = buffered.subarray(0, newlineIndex);
          buffered = buffered.subarray(newlineIndex + 1);
          if (discardingOverlongLine) {
            discardingOverlongLine = false;
          } else if (rawLine.length <= MAX_RESPONSE_LINE_BYTES) {
            onLine(
              rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d ? rawLine.subarray(0, -1) : rawLine,
            );
          } else {
            fail("PROVIDER_SCHEMA_DRIFT");
            return;
          }
          newlineIndex = buffered.indexOf(0x0a);
        }
        if (buffered.length > MAX_RESPONSE_LINE_BYTES) {
          discardingOverlongLine = true;
          buffered = Buffer.alloc(0);
          fail("PROVIDER_SCHEMA_DRIFT");
        }
      };

      const deadlineTimer = setTimeout(() => {
        fail("PROVIDER_TIMEOUT");
      }, deadlineMs);
      deadlineTimer.unref();
      child.stdin.on("error", () => {
        fail("PROVIDER_UNAVAILABLE");
      });
      child.stdout.on("data", pushOutput);
      // Provider stderr can contain diagnostics and account-local details. Drain it so the child
      // cannot block, but never parse, persist or log it.
      child.stderr.resume();
      child.once("error", () => {
        closeObserved = true;
        fail("PROVIDER_UNAVAILABLE");
        settleAfterClose();
      });
      child.once("close", () => {
        closeObserved = true;
        if (state.result === null && state.failure === null && buffered.length > 0) {
          onLine(buffered);
        }
        settleAfterClose();
      });

      send({
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: { name: "loomrail", title: "Loomrail", version: "0.0.0" },
          capabilities: {},
        },
      });
    });
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
};
