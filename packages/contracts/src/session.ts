import { z } from "zod";

import { apiVersionSchema, correlationIdSchema, utcTimestampSchema } from "./shared.js";

export const healthResponseSchema = z
  .object({
    status: z.enum(["live", "ready"]),
    apiVersion: apiVersionSchema,
    timestamp: utcTimestampSchema,
  })
  .strict();

export const sessionExchangeRequestSchema = z
  .object({
    bootstrapToken: z.string().min(43).max(128),
  })
  .strict();

export const sessionExchangeResponseSchema = z
  .object({
    authenticated: z.literal(true),
    csrfToken: z.string().min(43).max(128),
    expiresAt: utcTimestampSchema,
  })
  .strict();

export const daemonStatusResponseSchema = z
  .object({
    apiVersion: apiVersionSchema,
    authenticated: z.literal(true),
    daemon: z
      .object({
        status: z.literal("online"),
        version: z.string(),
        mode: z.literal("local"),
        startedAt: utcTimestampSchema,
        platform: z.enum(["darwin", "win32", "linux", "other"]),
      })
      .strict(),
    foundation: z
      .object({
        phase: z.literal("phase-0"),
        milestone: z.enum(["M1", "M2", "M3", "M4"]),
        providers: z.literal("mock-only"),
        persistence: z.enum(["not-enabled", "sqlite"]),
      })
      .strict(),
  })
  .strict();

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        correlationId: correlationIdSchema,
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type SessionExchangeRequest = z.infer<typeof sessionExchangeRequestSchema>;
export type SessionExchangeResponse = z.infer<typeof sessionExchangeResponseSchema>;
export type DaemonStatusResponse = z.infer<typeof daemonStatusResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
