import { z } from "zod";

import type { WorkspaceToolFailureCode, WorkspaceToolOperation } from "@loomrail/contracts";

export const WORKSPACE_TOOL_MAX_CALLS = 64;
export const WORKSPACE_TOOL_MAX_TURNS = 32;
export const WORKSPACE_TOOL_MAX_READ_BYTES = 65_536;
export const WORKSPACE_TOOL_MAX_WRITE_BYTES = 131_072;
export const WORKSPACE_TOOL_MAX_DIRECTORY_ENTRIES = 1_000;

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

const providerCallIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value), "Provider call id contains controls");
const untrustedTargetSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !hasControlCharacters(value), "Workspace target contains controls");
const relativePathInputSchema = untrustedTargetSchema;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const workspaceToolRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      callId: providerCallIdSchema,
      operation: z.literal("LIST_DIRECTORY"),
      path: relativePathInputSchema,
    })
    .strict(),
  z
    .object({
      callId: providerCallIdSchema,
      operation: z.literal("READ_FILE"),
      path: relativePathInputSchema,
      offsetBytes: z.number().int().nonnegative().max(2_147_483_647),
      limitBytes: z.number().int().positive().max(WORKSPACE_TOOL_MAX_READ_BYTES),
    })
    .strict(),
  z
    .object({
      callId: providerCallIdSchema,
      operation: z.literal("WRITE_FILE"),
      path: relativePathInputSchema,
      expectedSha256: sha256Schema.nullable(),
      content: z
        .string()
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= WORKSPACE_TOOL_MAX_WRITE_BYTES,
          "Workspace write exceeds the UTF-8 byte limit",
        ),
    })
    .strict(),
  z
    .object({
      callId: providerCallIdSchema,
      operation: z.literal("DELETE_FILE"),
      path: relativePathInputSchema,
      expectedSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      callId: providerCallIdSchema,
      operation: z.literal("RUN_RECIPE"),
      recipeId: untrustedTargetSchema.max(120),
    })
    .strict(),
]);

export type WorkspaceToolRequest = z.infer<typeof workspaceToolRequestSchema>;

export type WorkspaceToolPolicyDescription = {
  access: "READ_ONLY" | "READ_WRITE";
  recipes: readonly { id: string; label: string }[];
  limits: {
    maxCalls: number;
    maxReadBytes: number;
    maxWriteBytes: number;
    maxDirectoryEntries: number;
  };
};

export type WorkspaceToolSuccess = {
  status: "SUCCEEDED";
  operation: WorkspaceToolOperation;
  output:
    | {
        type: "DIRECTORY";
        entries: readonly { name: string; type: "FILE" | "DIRECTORY" }[];
        omittedSecretEntries: number;
      }
    | {
        type: "FILE";
        content: string;
        sha256: string;
        offsetBytes: number;
        returnedBytes: number;
        totalBytes: number;
        truncated: boolean;
      }
    | { type: "FILE_CHANGED"; sha256: string; bytes: number }
    | { type: "FILE_DELETED"; previousSha256: string }
    | {
        type: "RECIPE";
        recipeId: string;
        outcome: "PASSED" | "FAILED";
        exitCode: number;
        output: string;
        truncated: boolean;
        durationMs: number;
      };
};

export type WorkspaceToolFailure = {
  status: "DENIED" | "FAILED" | "UNKNOWN_OUTCOME";
  operation: WorkspaceToolOperation;
  code: WorkspaceToolFailureCode;
  message: string;
  approvalRequired: boolean;
};

export type WorkspaceToolResult = WorkspaceToolSuccess | WorkspaceToolFailure;

/**
 * The only execution seam visible to provider adapters. Native provider payloads stop at the
 * adapter; local paths, commands, audit and recovery stop behind this interface.
 */
export type WorkspaceToolExecutor = {
  describePolicy: () => WorkspaceToolPolicyDescription;
  execute: (request: WorkspaceToolRequest, signal: AbortSignal) => Promise<WorkspaceToolResult>;
};
