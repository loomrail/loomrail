import { z } from "zod";

const proxyToolSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().min(1).max(256).optional(),
    description: z.string().max(2_048).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const proxyRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("AUTH"), token: z.string().min(32).max(256) }).strict(),
  z
    .object({
      type: z.literal("CALL"),
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export const proxyResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("READY"), tools: z.array(proxyToolSchema).max(64) }).strict(),
  z.object({ type: z.literal("RESULT"), id: z.string().min(1).max(128), result: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("ERROR"),
      id: z.string().min(1).max(128).nullable(),
      code: z.enum([
        "AUTH_REJECTED",
        "INVALID_REQUEST",
        "TOOL_NOT_GRANTED",
        "GRANT_REVOKED",
        "ARGUMENTS_INVALID",
        "SERVER_UNAVAILABLE",
        "CONNECTION_LOST",
      ]),
      message: z.string().min(1).max(512),
    })
    .strict(),
]);

export type ProxyTool = z.infer<typeof proxyToolSchema>;
export type ProxyRequest = z.infer<typeof proxyRequestSchema>;
export type ProxyResponse = z.infer<typeof proxyResponseSchema>;
