import type {
  ConstitutionProposal,
  ConstitutionPublication,
  ProjectConstitutionVersion,
  RetryProjectConstitutionPublicationCommand,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { ConstitutionDomainError, decideProjectConstitutionPublicationRetry } from "../src/index.js";

const now = "2026-08-30T12:00:00.000Z";
const digest = "a".repeat(64);

const proposal: ConstitutionProposal = {
  schemaVersion: 1,
  id: "proposal-1",
  projectId: "project-1",
  projectVersion: 1,
  status: "ADOPTION_REQUESTED",
  presetId: "repository-baseline",
  presetVersion: 1,
  recommendedPresetId: "repository-baseline",
  scan: {
    schemaVersion: 1,
    sourceDigest: digest,
    targetConstitution: { state: "ABSENT", digest: null },
    files: [],
    warnings: [],
    packageManager: "UNKNOWN",
    languages: [],
    workspace: false,
    verificationCommands: [],
    instructionPaths: [],
    architecturePaths: [],
    ciPaths: [],
    configPaths: [],
  },
  sections: [],
  renderedMarkdown: "# Constitution\n",
  contentDigest: digest,
  version: 2,
  createdAt: now,
  adoptedAt: null,
};

const constitution: ProjectConstitutionVersion = {
  schemaVersion: 1,
  id: "constitution-1",
  projectId: "project-1",
  proposalId: proposal.id,
  ordinal: 1,
  presetId: proposal.presetId,
  presetVersion: 1,
  sourceDigest: digest,
  contentDigest: digest,
  renderedMarkdown: proposal.renderedMarkdown,
  status: "FAILED",
  version: 2,
  createdAt: now,
  activatedAt: null,
};

const publication: ConstitutionPublication = {
  schemaVersion: 1,
  id: "publication-1",
  projectId: "project-1",
  constitutionVersionId: constitution.id,
  targetPath: ".loomrail/constitution.md",
  expectedTargetDigest: null,
  contentDigest: digest,
  status: "FAILED",
  attempts: 1,
  lastErrorCode: "CONSTITUTION_TARGET_CHANGED",
  version: 2,
  createdAt: now,
  updatedAt: now,
  appliedAt: null,
};

const command: RetryProjectConstitutionPublicationCommand = {
  schemaVersion: 1,
  commandId: "retry-publication",
  correlationId: "correlation-retry",
  actor: { type: "HUMAN", id: "local-owner" },
  type: "RETRY_PROJECT_CONSTITUTION_PUBLICATION",
  payload: {
    projectId: "project-1",
    publicationId: publication.id,
    expectedVersion: publication.version,
  },
};

describe("Project Constitution publication retry", () => {
  it("returns the latest failed publication to the durable pending queue", () => {
    const decision = decideProjectConstitutionPublicationRetry(command, {
      now,
      publication,
      constitution,
      proposal,
      latestConstitutionOrdinal: constitution.ordinal,
    });

    expect(decision).toMatchObject({
      publication: { status: "PENDING", version: 3, lastErrorCode: null },
      constitution: { status: "PUBLISHING", version: 3 },
      event: { type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED" },
    });
  });

  it("refuses to reactivate a failed version after a newer Constitution exists", () => {
    expect(() =>
      decideProjectConstitutionPublicationRetry(command, {
        now,
        publication,
        constitution,
        proposal,
        latestConstitutionOrdinal: constitution.ordinal + 1,
      }),
    ).toThrow(
      expect.objectContaining<Partial<ConstitutionDomainError>>({
        code: "CONSTITUTION_STATUS_INVALID",
      }),
    );
  });
});
