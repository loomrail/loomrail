import type { McpProfileCandidate, McpProfileProposal } from "@loomrail/contracts";
import { mcpProfileProposalSchema } from "@loomrail/contracts";

const DEFAULT_PROPOSAL_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_PROPOSAL_LIMIT = 128;

export type McpProposalErrorCode =
  | "MCP_PROPOSAL_NOT_FOUND"
  | "MCP_PROPOSAL_EXPIRED"
  | "MCP_PROPOSAL_CONSUMED"
  | "MCP_PROPOSAL_MISMATCH"
  | "MCP_PROPOSAL_LIMIT_REACHED";

export class McpProposalError extends Error {
  readonly code: McpProposalErrorCode;

  constructor(code: McpProposalErrorCode, message: string) {
    super(message);
    this.name = "McpProposalError";
    this.code = code;
  }
}

type ProposalEntry = { proposal: McpProfileProposal; consumed: boolean };

export type McpProposalChallengeStore = {
  issue: (input: {
    projectId: string;
    expectedProjectVersion: number;
    candidate: McpProfileCandidate;
    canonicalDigest: string;
  }) => McpProfileProposal;
  consume: (input: {
    projectId: string;
    expectedProjectVersion: number;
    challengeId: string;
    canonicalDigest: string;
  }) => McpProfileProposal;
};

/**
 * Ephemeral authority for exact-command consent. A proposal is display data, never durable state
 * and never spawn permission. `consume` burns a valid challenge before the caller writes anything,
 * so concurrent/replayed confirmations cannot both reach the state store.
 */
export const createMcpProposalChallengeStore = (options: {
  now: () => Date;
  createId: () => string;
  ttlMs?: number;
  limit?: number;
}): McpProposalChallengeStore => {
  const entries = new Map<string, ProposalEntry>();
  const ttlMs = options.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const limit = options.limit ?? DEFAULT_PROPOSAL_LIMIT;

  const removeExpired = (): void => {
    const currentTime = options.now().getTime();
    for (const [id, entry] of entries) {
      if (Date.parse(entry.proposal.expiresAt) <= currentTime) entries.delete(id);
    }
  };

  return {
    issue(input) {
      removeExpired();
      if (entries.size >= limit) {
        throw new McpProposalError(
          "MCP_PROPOSAL_LIMIT_REACHED",
          "Too many unexpired MCP consent proposals are open",
        );
      }
      const createdAt = options.now();
      const proposal = mcpProfileProposalSchema.parse({
        schemaVersion: 1,
        challengeId: options.createId(),
        projectId: input.projectId,
        expectedProjectVersion: input.expectedProjectVersion,
        candidate: input.candidate,
        canonicalDigest: input.canonicalDigest,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      });
      entries.set(proposal.challengeId, { proposal, consumed: false });
      return proposal;
    },

    consume(input) {
      const entry = entries.get(input.challengeId);
      if (!entry) {
        throw new McpProposalError("MCP_PROPOSAL_NOT_FOUND", "The MCP consent proposal does not exist");
      }
      if (entry.consumed) {
        throw new McpProposalError("MCP_PROPOSAL_CONSUMED", "The MCP consent proposal was already used");
      }
      if (Date.parse(entry.proposal.expiresAt) <= options.now().getTime()) {
        entry.consumed = true;
        throw new McpProposalError("MCP_PROPOSAL_EXPIRED", "The MCP consent proposal has expired");
      }
      if (
        entry.proposal.projectId !== input.projectId ||
        entry.proposal.expectedProjectVersion !== input.expectedProjectVersion ||
        entry.proposal.canonicalDigest !== input.canonicalDigest
      ) {
        entry.consumed = true;
        throw new McpProposalError(
          "MCP_PROPOSAL_MISMATCH",
          "The MCP confirmation does not match the exact proposed command and Project version",
        );
      }
      entry.consumed = true;
      return entry.proposal;
    },
  };
};
