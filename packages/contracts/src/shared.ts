import { z } from "zod";

export const schemaVersionSchema = z.literal(1);
export const apiVersionSchema = z.literal("v1");
export const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const correlationIdSchema = opaqueIdSchema;
export const utcTimestampSchema = z.iso.datetime({ offset: true });

export const actorSchema = z
  .object({
    type: z.enum(["HUMAN", "SYSTEM"]),
    id: opaqueIdSchema,
  })
  .strict();

export type Actor = z.infer<typeof actorSchema>;
