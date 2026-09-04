import { z } from "zod";

import source from "./guided-activation.v1.json" with { type: "json" };
import { modelTierSchema, opaqueIdSchema, schemaVersionSchema } from "./shared.js";
import { fixtureProjectIdSchema, prioritySchema, riskSchema, workItemTypeSchema } from "./work-management.js";

export const guidedActivationInstallCommands = [
  "mkdir loomrail-evaluation",
  "cd loomrail-evaluation",
  "npm install --ignore-scripts loomrail@next",
  "npx playwright install chromium",
  "npx loomrail try",
] as const;

export const guidedActivationContractSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: z.literal("guided-mock-v1"),
    fixtureId: fixtureProjectIdSchema,
    createCommandId: opaqueIdSchema,
    task: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(20_000),
        priority: prioritySchema,
        risk: riskSchema,
        type: workItemTypeSchema,
        acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
      })
      .strict(),
    policy: z
      .object({
        maxEstimatedTokens: z.number().int().min(100).max(10_000_000),
        agentRunMaxEstimatedTokensOverride: z.number().int().min(100).max(1_000_000),
        modelTierOverride: modelTierSchema,
      })
      .strict()
      .refine(
        (policy) => policy.agentRunMaxEstimatedTokensOverride <= policy.maxEstimatedTokens,
        "The per-agent ceiling cannot exceed the whole guided run budget",
      ),
    install: z
      .object({
        commands: z
          .array(z.enum(guidedActivationInstallCommands))
          .length(guidedActivationInstallCommands.length),
      })
      .strict(),
  })
  .strict()
  .superRefine((contract, context) => {
    if (new Set(contract.install.commands).size !== contract.install.commands.length) {
      context.addIssue({ code: "custom", message: "Activation install commands must be unique" });
    }
    if (new Set(contract.task.acceptanceCriteria).size !== contract.task.acceptanceCriteria.length) {
      context.addIssue({ code: "custom", message: "Activation acceptance criteria must be unique" });
    }
    if (
      contract.install.commands.some((command, index) => command !== guidedActivationInstallCommands[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Activation install commands must keep the reviewed order",
      });
    }
  });

export const guidedActivationContract = guidedActivationContractSchema.parse(source);

export type GuidedActivationContract = z.infer<typeof guidedActivationContractSchema>;
