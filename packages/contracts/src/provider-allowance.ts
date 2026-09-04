import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { providerIdSchema } from "./workflow.js";

export const providerAllowanceFreshnessSchema = z.enum(["LIVE", "STALE", "UNAVAILABLE"]);
export const providerAllowanceBucketKindSchema = z.enum([
  "PRIMARY",
  "SECONDARY",
  "FIVE_HOUR",
  "SEVEN_DAY",
  "SPEND_LIMIT",
]);
export const providerAllowanceUnavailableReasonSchema = z.enum([
  "PROVIDER_UNSUPPORTED",
  "TARGET_UNVERIFIED",
  "NOT_AUTHENTICATED",
  "DATA_NOT_PRESENT",
  "PROVIDER_SCHEMA_DRIFT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
]);

const allowancePercentSchema = z.number().min(0).max(1_000);

export const providerAllowanceBucketSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    name: z.string().trim().min(1).max(96).nullable(),
    kind: providerAllowanceBucketKindSchema,
    usedPercent: allowancePercentSchema,
    remainingPercent: z.number().min(0).max(100),
    windowDurationMins: z.number().int().positive().max(527_040),
    resetsAt: utcTimestampSchema,
    limitReached: z.boolean(),
  })
  .strict()
  .superRefine((bucket, context) => {
    if (bucket.kind !== "SPEND_LIMIT" && bucket.usedPercent > 100) {
      context.addIssue({
        code: "custom",
        path: ["usedPercent"],
        message: "A provider consumption window cannot exceed 100 percent",
      });
    }

    const expectedRemaining = Math.max(0, 100 - bucket.usedPercent);
    if (Math.abs(bucket.remainingPercent - expectedRemaining) > 0.000_001) {
      context.addIssue({
        code: "custom",
        path: ["remainingPercent"],
        message: "Remaining provider allowance must be derived from used percent",
      });
    }

    if (bucket.usedPercent >= 100 && !bucket.limitReached) {
      context.addIssue({
        code: "custom",
        path: ["limitReached"],
        message: "An exhausted provider allowance must be marked as reached",
      });
    }
  });

const snapshotBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  provider: providerIdSchema,
  observedAt: utcTimestampSchema,
});

const presentProviderAllowanceSnapshotSchema = snapshotBaseSchema
  .extend({
    freshness: z.enum(["LIVE", "STALE"]),
    buckets: z.array(providerAllowanceBucketSchema).min(1).max(16),
    unavailableReason: z.null(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.provider === "MOCK") {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Mock has no external provider allowance",
      });
    }
    if (new Set(snapshot.buckets.map((bucket) => bucket.id)).size !== snapshot.buckets.length) {
      context.addIssue({
        code: "custom",
        path: ["buckets"],
        message: "Provider allowance bucket ids must be unique",
      });
    }
  });

const unavailableProviderAllowanceSnapshotSchema = snapshotBaseSchema
  .extend({
    freshness: z.literal("UNAVAILABLE"),
    buckets: z.array(z.never()).length(0),
    unavailableReason: providerAllowanceUnavailableReasonSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.provider === "MOCK" && snapshot.unavailableReason !== "PROVIDER_UNSUPPORTED") {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "Mock allowance is unavailable because the provider is unsupported",
      });
    }
  });

export const providerAllowanceSnapshotSchema = z.discriminatedUnion("freshness", [
  presentProviderAllowanceSnapshotSchema,
  unavailableProviderAllowanceSnapshotSchema,
]);

export const providerAllowanceAdvisorySchema = z
  .object({
    status: z.enum(["CAPACITY_AVAILABLE", "LOW_CAPACITY", "LIMIT_REACHED", "UNKNOWN"]),
    deferUntil: utcTimestampSchema.nullable(),
  })
  .strict();

export const projectProviderAllowanceResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: z.string().min(1).max(128),
    effectiveProvider: providerIdSchema,
    current: providerAllowanceSnapshotSchema,
    advisory: providerAllowanceAdvisorySchema,
    providers: z.array(providerAllowanceSnapshotSchema).length(2),
  })
  .strict()
  .superRefine((response, context) => {
    const expectedProviders = ["CODEX", "CLAUDE_CODE"] as const;
    if (response.providers.some((snapshot, index) => snapshot.provider !== expectedProviders[index])) {
      context.addIssue({
        code: "custom",
        path: ["providers"],
        message: "Provider allowance snapshots must use canonical provider order",
      });
    }
    if (response.current.provider !== response.effectiveProvider) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "Current provider allowance must match the effective provider",
      });
    }
  });

export const refreshProviderAllowanceRequestSchema = z
  .object({ schemaVersion: schemaVersionSchema })
  .strict();

export const providerAllowanceQuerySchema = z.object({ projectId: opaqueIdSchema }).strict();

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const recordProviderAllowanceCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_PROVIDER_ALLOWANCE"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      snapshot: providerAllowanceSnapshotSchema,
    })
    .strict(),
});

const eventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateType: z.literal("PROJECT"),
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const providerAllowanceRecordedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROVIDER_ALLOWANCE_RECORDED"),
  data: z.object({ snapshot: providerAllowanceSnapshotSchema }).strict(),
});

export const providerAllowanceRecordedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("PROVIDER_ALLOWANCE_RECORDED"),
    snapshot: providerAllowanceSnapshotSchema,
    event: providerAllowanceRecordedEventSchema,
  })
  .strict();

export type ProviderAllowanceFreshness = z.infer<typeof providerAllowanceFreshnessSchema>;
export type ProviderAllowanceBucketKind = z.infer<typeof providerAllowanceBucketKindSchema>;
export type ProviderAllowanceUnavailableReason = z.infer<typeof providerAllowanceUnavailableReasonSchema>;
export type ProviderAllowanceBucket = z.infer<typeof providerAllowanceBucketSchema>;
export type ProviderAllowanceSnapshot = z.infer<typeof providerAllowanceSnapshotSchema>;
export type ProviderAllowanceAdvisory = z.infer<typeof providerAllowanceAdvisorySchema>;
export type ProjectProviderAllowanceResponse = z.infer<typeof projectProviderAllowanceResponseSchema>;
export type RecordProviderAllowanceCommand = z.infer<typeof recordProviderAllowanceCommandSchema>;
export type ProviderAllowanceRecordedEvent = z.infer<typeof providerAllowanceRecordedEventSchema>;
export type ProviderAllowanceRecordedResult = z.infer<typeof providerAllowanceRecordedResultSchema>;
