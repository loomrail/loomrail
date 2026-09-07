import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { providerTokenBudgetEnforcementSchema, workflowStageSchema } from "./workflow.js";

// MOCK remains a readable historical ProviderId in append-only audit records, but it is no longer
// an active Project preference. New selection can target only the two real API adapters.
export const liveProviderIdSchema = z.enum(["CODEX", "CLAUDE_CODE"]);
export const providerPreferenceSchema = z.enum(["AUTO", ...liveProviderIdSchema.options]);

export const projectProviderSelectionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    preference: providerPreferenceSchema,
    projectVersion: z.number().int().positive(),
    updatedAt: utcTimestampSchema,
  })
  .strict();

export const providerAuthenticationSchema = z.enum(["AUTHENTICATED", "REQUIRED", "UNKNOWN"]);
export const providerCompatibilitySchema = z.enum([
  "BUILT_IN",
  "MISSING",
  "UNLAUNCHABLE",
  "VERSION_UNREADABLE",
  "TOO_OLD",
  "VERIFIED",
  "UNVERIFIED",
]);
export const providerSelectionSourceSchema = z.enum(["AUTO", "PROJECT_PREFERENCE", "ENVIRONMENT_OVERRIDE"]);
export const providerFallbackReasonSchema = z
  .enum(["NO_READY_LIVE_PROVIDER", "LIVE_PROVIDER_UNAVAILABLE"])
  .nullable();

export const providerModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const providerModelMappingSchema = z
  .object({
    FAST: providerModelIdSchema,
    STANDARD: providerModelIdSchema,
    DEEP: providerModelIdSchema,
  })
  .strict();

export const providerAvailabilitySchema = z
  .object({
    provider: liveProviderIdSchema,
    installed: z.boolean(),
    authentication: providerAuthenticationSchema,
    version: z.string().min(1).max(48).nullable(),
    compatibility: providerCompatibilitySchema,
    ready: z.boolean(),
    stages: z.array(workflowStageSchema).min(1).max(20),
    checkpointOnRequest: z.boolean(),
    contextWindowReporting: z.boolean(),
    costReporting: z.boolean(),
    tokenBudgetEnforcement: providerTokenBudgetEnforcementSchema,
    canReportRateLimits: z.boolean().default(false),
    models: providerModelMappingSchema.nullable(),
  })
  .strict()
  .superRefine((availability, context) => {
    if (availability.models === null) {
      context.addIssue({ code: "custom", message: "A real provider must expose its model mapping" });
    }
    if (availability.compatibility === "BUILT_IN") {
      if (
        !availability.installed ||
        availability.version !== null ||
        availability.ready !== (availability.authentication === "AUTHENTICATED")
      ) {
        context.addIssue({
          code: "custom",
          message: "A built-in API adapter is ready exactly when its credential is configured",
        });
      }
      return;
    }
    if (!availability.installed && availability.compatibility !== "MISSING") {
      context.addIssue({ code: "custom", message: "A missing live provider must report MISSING" });
    }
    const reportsVersion = ["TOO_OLD", "VERIFIED", "UNVERIFIED"].includes(availability.compatibility);
    if (reportsVersion !== (availability.version !== null)) {
      context.addIssue({
        code: "custom",
        message: "Live provider version presence must match its compatibility state",
      });
    }
    if (
      availability.authentication !== "UNKNOWN" &&
      (!availability.installed || availability.version === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Authentication is observed only for an installed, versioned live provider target",
      });
    }
    if (
      availability.ready !==
      (availability.installed &&
        availability.compatibility === "VERIFIED" &&
        availability.authentication === "AUTHENTICATED")
    ) {
      context.addIssue({
        code: "custom",
        message: "Live provider readiness must match install, compatibility and auth state",
      });
    }
  });

export const projectProviderSelectionResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    selection: projectProviderSelectionSchema,
    effectiveProvider: liveProviderIdSchema,
    source: providerSelectionSourceSchema,
    fallbackReason: providerFallbackReasonSchema,
    environmentOverride: liveProviderIdSchema.nullable(),
    environmentOverrideLocked: z.boolean(),
    environmentOverrideInvalid: z.boolean(),
    providers: z.array(providerAvailabilitySchema).length(2),
  })
  .strict();

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

export const projectProviderPreferenceChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_PROVIDER_PREFERENCE_CHANGED"),
  data: z
    .object({
      selection: projectProviderSelectionSchema,
      previousPreference: providerPreferenceSchema,
    })
    .strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const setProjectProviderPreferenceCommandSchema = commandBaseSchema.extend({
  type: z.literal("SET_PROJECT_PROVIDER_PREFERENCE"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      preference: providerPreferenceSchema,
    })
    .strict(),
});

export const projectProviderPreferenceChangedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("PROJECT_PROVIDER_PREFERENCE_CHANGED"),
    selection: projectProviderSelectionSchema,
    event: projectProviderPreferenceChangedEventSchema,
  })
  .strict();

export const setProjectProviderPreferenceRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    preference: providerPreferenceSchema,
  })
  .strict();

export const refreshProviderAvailabilityRequestSchema = z
  .object({ schemaVersion: schemaVersionSchema })
  .strict();

export type ProviderPreference = z.infer<typeof providerPreferenceSchema>;
export type LiveProviderId = z.infer<typeof liveProviderIdSchema>;
export type ProjectProviderSelection = z.infer<typeof projectProviderSelectionSchema>;
export type ProviderAuthentication = z.infer<typeof providerAuthenticationSchema>;
export type ProviderCompatibility = z.infer<typeof providerCompatibilitySchema>;
export type ProviderSelectionSource = z.infer<typeof providerSelectionSourceSchema>;
export type ProviderModelMapping = z.infer<typeof providerModelMappingSchema>;
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;
export type ProjectProviderSelectionResponse = z.infer<typeof projectProviderSelectionResponseSchema>;
export type ProjectProviderPreferenceChangedEvent = z.infer<
  typeof projectProviderPreferenceChangedEventSchema
>;
export type SetProjectProviderPreferenceCommand = z.infer<typeof setProjectProviderPreferenceCommandSchema>;
export type ProjectProviderPreferenceChangedResult = z.infer<
  typeof projectProviderPreferenceChangedResultSchema
>;
