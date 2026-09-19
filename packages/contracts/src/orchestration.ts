import { z } from "zod";

export const coordinatorProfileId = "builtin.code-blind-coordinator";
export const coordinatorModelId = "gpt-6-astra";
export const economyModelIds = { CODEX: "gpt-5.6-luna", CLAUDE_CODE: "claude-sonnet-5" } as const;

// Separate owner-authored input, never copied from repository or provider-authored artifacts.
export const codeBlindOrchestrationSchema = z
  .object({
    mode: z.literal("CODE_BLIND"),
    ownerOutcome: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const stageExecutionPolicySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("CODE_BLIND_MANAGER"),
      ownerOutcome: codeBlindOrchestrationSchema.shape.ownerOutcome,
    })
    .strict(),
  z.object({ kind: z.literal("ECONOMY_WORKER") }).strict(),
]);

export const coordinatorPacketSchema = z
  .object({
    version: z.literal(1),
    ownerOutcome: codeBlindOrchestrationSchema.shape.ownerOutcome,
    discovery: z.enum(["COMPLETED", "UNKNOWN"]),
    unresolvedQuestions: z.number().int().min(0).max(20),
    attempt: z.number().int().positive(),
    sessionOrdinal: z.number().int().positive(),
  })
  .strict();

export const coordinatorPlanSchema = z
  .object({
    type: z.literal("PLAN"),
    orders: z
      .array(
        z
          .object({
            outcome: z.string().trim().min(10).max(400),
            verification: z.string().trim().min(10).max(400),
            // Earlier ordinals only: the ordered list cannot form a cycle or invent a reference.
            dependsOn: z.array(z.number().int().min(0).max(5)).max(5),
            stopCondition: z.enum([
              "SCOPE_CHANGE",
              "MISSING_INFORMATION",
              "PERMISSION_REQUIRED",
              "VERIFICATION_FAILED",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((plan, context) => {
    plan.orders.forEach((order, index) => {
      if (
        new Set(order.dependsOn).size !== order.dependsOn.length ||
        order.dependsOn.some((ref) => ref >= index)
      ) {
        context.addIssue({
          code: "custom",
          path: ["orders", index, "dependsOn"],
          message: "Dependencies must uniquely reference earlier work orders",
        });
      }
    });
  });

export type CodeBlindOrchestration = z.infer<typeof codeBlindOrchestrationSchema>;
export type StageExecutionPolicy = z.infer<typeof stageExecutionPolicySchema>;
export type CoordinatorPacket = z.infer<typeof coordinatorPacketSchema>;

/** Canonical wire text; schema parsing drops no unknown fields and fixes key order. */
export const serializeCoordinatorPacket = (input: unknown): string =>
  JSON.stringify(coordinatorPacketSchema.parse(input));
