import type {
  CompleteProjectConstitutionPublicationCommand,
  ConstitutionProposal,
  ConstitutionPublication,
  FailProjectConstitutionPublicationCommand,
  Project,
  ProjectConstitutionVersion,
  ProposeProjectConstitutionCommand,
  RequestProjectConstitutionAdoptionCommand,
  RetryProjectConstitutionPublicationCommand,
} from "@loomrail/contracts";

export type ConstitutionDomainErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_VERSION_CONFLICT"
  | "PROJECT_NOT_ACTIVE"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_VERSION_CONFLICT"
  | "PROPOSAL_NOT_PROPOSED"
  | "CONSTITUTION_TARGET_BLOCKED"
  | "CONSTITUTION_PUBLICATION_ALREADY_PENDING"
  | "CONSTITUTION_NOT_FOUND"
  | "CONSTITUTION_STATUS_INVALID"
  | "PUBLICATION_NOT_FOUND"
  | "PUBLICATION_PROJECT_MISMATCH"
  | "PUBLICATION_VERSION_CONFLICT"
  | "PUBLICATION_STATUS_INVALID";

export class ConstitutionDomainError extends Error {
  readonly code: ConstitutionDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ConstitutionDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ConstitutionDomainError";
    this.code = code;
    this.details = details;
  }
}

export type ConstitutionProposedIntent = {
  type: "PROJECT_CONSTITUTION_PROPOSED";
  data: { proposal: ConstitutionProposal };
};

export type ConstitutionPublicationRequestedIntent = {
  type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED";
  data: {
    proposal: ConstitutionProposal;
    constitution: ProjectConstitutionVersion;
    publication: ConstitutionPublication;
  };
};

export type ConstitutionActivatedIntent = {
  type: "PROJECT_CONSTITUTION_ACTIVATED";
  data: {
    proposal: ConstitutionProposal;
    constitution: ProjectConstitutionVersion;
    publication: ConstitutionPublication;
  };
};

export type ConstitutionPublicationFailedIntent = {
  type: "PROJECT_CONSTITUTION_PUBLICATION_FAILED";
  data: {
    constitution: ProjectConstitutionVersion;
    publication: ConstitutionPublication;
  };
};

const requireProject = (project: Project | undefined, expectedVersion: number): Project => {
  if (!project) throw new ConstitutionDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  if (project.version !== expectedVersion) {
    throw new ConstitutionDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after the Constitution operation was loaded",
      { expectedVersion, actualVersion: project.version },
    );
  }
  if (project.status !== "ACTIVE") {
    throw new ConstitutionDomainError("PROJECT_NOT_ACTIVE", "Only an active Project can be onboarded");
  }
  return project;
};

const requireProposal = (
  proposal: ConstitutionProposal | undefined,
  projectId: string,
  expectedVersion: number,
): ConstitutionProposal => {
  if (proposal?.projectId !== projectId) {
    throw new ConstitutionDomainError("PROPOSAL_NOT_FOUND", "The Constitution Proposal does not exist");
  }
  if (proposal.version !== expectedVersion) {
    throw new ConstitutionDomainError(
      "PROPOSAL_VERSION_CONFLICT",
      "The Constitution Proposal changed after it was loaded",
      { expectedVersion, actualVersion: proposal.version },
    );
  }
  return proposal;
};

export const decideProjectConstitutionProposal = (
  command: ProposeProjectConstitutionCommand,
  context: { now: string; newProposalId: string; project?: Project },
): { proposal: ConstitutionProposal; event: ConstitutionProposedIntent } => {
  const project = requireProject(context.project, command.payload.expectedProjectVersion);
  const proposal: ConstitutionProposal = {
    schemaVersion: 1,
    id: context.newProposalId,
    projectId: project.id,
    projectVersion: project.version,
    status: "PROPOSED",
    presetId: command.payload.presetId,
    presetVersion: 1,
    recommendedPresetId: command.payload.recommendedPresetId,
    scan: command.payload.scan,
    sections: [...command.payload.sections],
    renderedMarkdown: command.payload.renderedMarkdown,
    contentDigest: command.payload.contentDigest,
    version: 1,
    createdAt: context.now,
    adoptedAt: null,
  };
  return {
    proposal,
    event: { type: "PROJECT_CONSTITUTION_PROPOSED", data: { proposal } },
  };
};

export const decideProjectConstitutionAdoption = (
  command: RequestProjectConstitutionAdoptionCommand,
  context: {
    now: string;
    newConstitutionId: string;
    newPublicationId: string;
    nextOrdinal: number;
    project?: Project;
    proposal?: ConstitutionProposal;
    pendingConstitution?: ProjectConstitutionVersion;
  },
): {
  proposal: ConstitutionProposal;
  constitution: ProjectConstitutionVersion;
  publication: ConstitutionPublication;
  event: ConstitutionPublicationRequestedIntent;
} => {
  const project = requireProject(context.project, command.payload.expectedProjectVersion);
  const currentProposal = requireProposal(
    context.proposal,
    project.id,
    command.payload.expectedProposalVersion,
  );
  if (currentProposal.status !== "PROPOSED") {
    throw new ConstitutionDomainError("PROPOSAL_NOT_PROPOSED", "Only a proposed Constitution can be adopted");
  }
  if (currentProposal.scan.targetConstitution.state === "BLOCKED") {
    throw new ConstitutionDomainError(
      "CONSTITUTION_TARGET_BLOCKED",
      "The existing Constitution target could not be reviewed safely",
    );
  }
  if (context.pendingConstitution?.status === "PUBLISHING") {
    throw new ConstitutionDomainError(
      "CONSTITUTION_PUBLICATION_ALREADY_PENDING",
      "This Project already has a Constitution publication in progress",
    );
  }

  const proposal: ConstitutionProposal = {
    ...currentProposal,
    status: "ADOPTION_REQUESTED",
    version: currentProposal.version + 1,
  };
  const constitution: ProjectConstitutionVersion = {
    schemaVersion: 1,
    id: context.newConstitutionId,
    projectId: project.id,
    proposalId: proposal.id,
    ordinal: context.nextOrdinal,
    presetId: proposal.presetId,
    presetVersion: proposal.presetVersion,
    sourceDigest: proposal.scan.sourceDigest,
    contentDigest: proposal.contentDigest,
    renderedMarkdown: proposal.renderedMarkdown,
    status: "PUBLISHING",
    version: 1,
    createdAt: context.now,
    activatedAt: null,
  };
  const publication: ConstitutionPublication = {
    schemaVersion: 1,
    id: context.newPublicationId,
    projectId: project.id,
    constitutionVersionId: constitution.id,
    targetPath: ".loomrail/constitution.md",
    expectedTargetDigest:
      proposal.scan.targetConstitution.state === "PRESENT" ? proposal.scan.targetConstitution.digest : null,
    contentDigest: constitution.contentDigest,
    status: "PENDING",
    attempts: 0,
    lastErrorCode: null,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    proposal,
    constitution,
    publication,
    event: {
      type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED",
      data: { proposal, constitution, publication },
    },
  };
};

const requirePublication = (
  publication: ConstitutionPublication | undefined,
  expectedVersion: number,
): ConstitutionPublication => {
  if (!publication) {
    throw new ConstitutionDomainError("PUBLICATION_NOT_FOUND", "The Constitution publication does not exist");
  }
  if (publication.version !== expectedVersion) {
    throw new ConstitutionDomainError(
      "PUBLICATION_VERSION_CONFLICT",
      "The Constitution publication changed after it was loaded",
      { expectedVersion, actualVersion: publication.version },
    );
  }
  return publication;
};

const requireConstitution = (
  constitution: ProjectConstitutionVersion | undefined,
  publication: ConstitutionPublication,
): ProjectConstitutionVersion => {
  if (constitution?.id !== publication.constitutionVersionId) {
    throw new ConstitutionDomainError(
      "CONSTITUTION_NOT_FOUND",
      "The Constitution version backing the publication does not exist",
    );
  }
  return constitution;
};

export const decideProjectConstitutionPublicationCompleted = (
  command: CompleteProjectConstitutionPublicationCommand,
  context: {
    now: string;
    publication?: ConstitutionPublication;
    constitution?: ProjectConstitutionVersion;
    proposal?: ConstitutionProposal;
    activeConstitution?: ProjectConstitutionVersion;
  },
): {
  proposal: ConstitutionProposal;
  constitution: ProjectConstitutionVersion;
  publication: ConstitutionPublication;
  supersededConstitution: ProjectConstitutionVersion | null;
  event: ConstitutionActivatedIntent;
} => {
  const currentPublication = requirePublication(context.publication, command.payload.expectedVersion);
  if (currentPublication.status !== "PENDING") {
    throw new ConstitutionDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending Constitution publication can complete",
    );
  }
  const currentConstitution = requireConstitution(context.constitution, currentPublication);
  if (currentConstitution.status !== "PUBLISHING") {
    throw new ConstitutionDomainError(
      "CONSTITUTION_STATUS_INVALID",
      "Only a publishing Constitution can become active",
    );
  }
  const currentProposal = context.proposal;
  if (currentProposal?.id !== currentConstitution.proposalId) {
    throw new ConstitutionDomainError("PROPOSAL_NOT_FOUND", "The adopted Constitution Proposal is missing");
  }
  if (currentProposal.status !== "ADOPTION_REQUESTED") {
    throw new ConstitutionDomainError(
      "PROPOSAL_NOT_PROPOSED",
      "The Constitution Proposal is not awaiting publication",
    );
  }

  const publication: ConstitutionPublication = {
    ...currentPublication,
    status: "APPLIED",
    attempts: currentPublication.attempts + 1,
    lastErrorCode: null,
    version: currentPublication.version + 1,
    updatedAt: context.now,
    appliedAt: context.now,
  };
  const constitution: ProjectConstitutionVersion = {
    ...currentConstitution,
    status: "ACTIVE",
    version: currentConstitution.version + 1,
    activatedAt: context.now,
  };
  const proposal: ConstitutionProposal = {
    ...currentProposal,
    status: "ADOPTED",
    version: currentProposal.version + 1,
    adoptedAt: context.now,
  };
  const supersededConstitution = context.activeConstitution
    ? {
        ...context.activeConstitution,
        status: "SUPERSEDED" as const,
        version: context.activeConstitution.version + 1,
      }
    : null;
  return {
    proposal,
    constitution,
    publication,
    supersededConstitution,
    event: {
      type: "PROJECT_CONSTITUTION_ACTIVATED",
      data: { proposal, constitution, publication },
    },
  };
};

export const decideProjectConstitutionPublicationFailed = (
  command: FailProjectConstitutionPublicationCommand,
  context: {
    now: string;
    publication?: ConstitutionPublication;
    constitution?: ProjectConstitutionVersion;
  },
): {
  constitution: ProjectConstitutionVersion;
  publication: ConstitutionPublication;
  event: ConstitutionPublicationFailedIntent;
} => {
  const currentPublication = requirePublication(context.publication, command.payload.expectedVersion);
  if (currentPublication.status !== "PENDING") {
    throw new ConstitutionDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending Constitution publication can fail",
    );
  }
  const currentConstitution = requireConstitution(context.constitution, currentPublication);
  if (currentConstitution.status !== "PUBLISHING") {
    throw new ConstitutionDomainError(
      "CONSTITUTION_STATUS_INVALID",
      "Only a publishing Constitution can record a publication failure",
    );
  }
  const publication: ConstitutionPublication = {
    ...currentPublication,
    status: "FAILED",
    attempts: currentPublication.attempts + 1,
    lastErrorCode: command.payload.errorCode,
    version: currentPublication.version + 1,
    updatedAt: context.now,
  };
  const constitution: ProjectConstitutionVersion = {
    ...currentConstitution,
    status: "FAILED",
    version: currentConstitution.version + 1,
  };
  return {
    constitution,
    publication,
    event: {
      type: "PROJECT_CONSTITUTION_PUBLICATION_FAILED",
      data: { constitution, publication },
    },
  };
};

export const decideProjectConstitutionPublicationRetry = (
  command: RetryProjectConstitutionPublicationCommand,
  context: {
    now: string;
    publication?: ConstitutionPublication;
    constitution?: ProjectConstitutionVersion;
    proposal?: ConstitutionProposal;
    latestConstitutionOrdinal: number;
  },
): {
  constitution: ProjectConstitutionVersion;
  publication: ConstitutionPublication;
  event: ConstitutionPublicationRequestedIntent;
} => {
  const currentPublication = requirePublication(context.publication, command.payload.expectedVersion);
  if (currentPublication.projectId !== command.payload.projectId) {
    throw new ConstitutionDomainError(
      "PUBLICATION_PROJECT_MISMATCH",
      "The Constitution publication belongs to a different Project",
    );
  }
  if (currentPublication.status !== "FAILED") {
    throw new ConstitutionDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a failed Constitution publication can be retried",
    );
  }
  const currentConstitution = requireConstitution(context.constitution, currentPublication);
  if (currentConstitution.status !== "FAILED") {
    throw new ConstitutionDomainError(
      "CONSTITUTION_STATUS_INVALID",
      "Only a failed Constitution can retry publication",
    );
  }
  if (currentConstitution.ordinal !== context.latestConstitutionOrdinal) {
    throw new ConstitutionDomainError(
      "CONSTITUTION_STATUS_INVALID",
      "A superseded Constitution publication cannot be retried",
      {
        publicationOrdinal: currentConstitution.ordinal,
        latestOrdinal: context.latestConstitutionOrdinal,
      },
    );
  }
  const proposal = context.proposal;
  if (proposal?.id !== currentConstitution.proposalId) {
    throw new ConstitutionDomainError("PROPOSAL_NOT_FOUND", "The Constitution Proposal is missing");
  }
  const publication: ConstitutionPublication = {
    ...currentPublication,
    status: "PENDING",
    lastErrorCode: null,
    version: currentPublication.version + 1,
    updatedAt: context.now,
  };
  const constitution: ProjectConstitutionVersion = {
    ...currentConstitution,
    status: "PUBLISHING",
    version: currentConstitution.version + 1,
  };
  return {
    constitution,
    publication,
    event: {
      type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED",
      data: { proposal, constitution, publication },
    },
  };
};
