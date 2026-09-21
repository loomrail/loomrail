import { createHash } from "node:crypto";
import {
  coordinatorPacketSchema,
  serializeCoordinatorPacket,
  type CoordinatorPacket,
} from "@loomrail/contracts";
import type { AssembleResult } from "./assemble.js";

/** A separate assembly path: no repository-bearing ContextSources or ordinary renderer is accepted. */
export const assembleCoordinatorPack = (input: {
  packet: CoordinatorPacket;
  agentRunId: string;
  discoveryCheckpoint?: { id: string; version: number };
  budgetTokens: number;
  bytesPerToken: number;
}): AssembleResult => {
  const text = serializeCoordinatorPacket(coordinatorPacketSchema.parse(input.packet));
  const bytes = Buffer.byteLength(text, "utf8");
  const budgetBytes = input.budgetTokens * input.bytesPerToken;
  if (bytes > budgetBytes) return { type: "FLOOR_EXCEEDED", requiredBytes: bytes, budgetBytes };
  return {
    type: "ASSEMBLED",
    pack: {
      schemaVersion: 1,
      text,
      contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
    recipe: {
      sections: [
        {
          id: "WORK_ITEM_BRIEF",
          sources: [
            { kind: "AGENT_RUN", id: input.agentRunId, version: 1 },
            ...(input.discoveryCheckpoint === undefined
              ? []
              : [{ kind: "CHECKPOINT" as const, ...input.discoveryCheckpoint }]),
          ],
          bytes,
        },
      ],
      omitted: [],
      estimatedTokens: Math.ceil(bytes / input.bytesPerToken),
      budgetTokens: input.budgetTokens,
    },
  };
};
