import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { providerIdSchema, workflowStageSchema } from "./workflow.js";

export const providerPreferenceSchema = z.enum(["AUTO", "CODEX", "CLAUDE_CODE", "MOCK"]);

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
    provider: providerIdSchema,
    installed: z.boolean(),
    authentication: providerAuthenticationSchema,
    version: z.string().min(1).max(48).nullable(),
    compatibility: providerCompatibilitySchema,
    ready: z.boolean(),
    stages: z.array(workflowStageSchema).min(1).max(20),
    checkpointOnRequest: z.boolean(),
    contextWindowReporting: z.boolean(),
    costReporting: z.boolean(),
    models: providerModelMappingSchema.nullable(),
  })
  .strict()
  .superRefine((availability, context) => {
    if (availability.provider === "MOCK") {
      if (
        !availability.installed ||
        availability.authentication !== "AUTHENTICATED" ||
        availability.version !== null ||
        availability.compatibility !== "BUILT_IN" ||
        !availability.ready ||
        availability.models !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "The Mock provider is always ready and has no live model mapping",
        });
      }
      return;
    }
    if (availability.models === null) {
      context.addIssue({ code: "custom", message: "A live provider must expose its model mapping" });
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
    if (availability.compatibility !== "VERIFIED" && availability.authentication !== "UNKNOWN") {
      context.addIssue({
        code: "custom",
        message: "Authentication is observed only for an exact verified live provider",
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
    effectiveProvider: providerIdSchema,
    source: providerSelectionSourceSchema,
    fallbackReason: providerFallbackReasonSchema,
    environmentOverride: providerIdSchema.nullable(),
    environmentOverrideLocked: z.boolean(),
    environmentOverrideInvalid: z.boolean(),
    providers: z.array(providerAvailabilitySchema).length(3),
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
