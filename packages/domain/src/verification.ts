import type {
  AdoptVerificationPlanCommand,
  CompleteVerificationPlanPublicationCommand,
  FailVerificationPlanPublicationCommand,
  Project,
  RetryVerificationPlanPublicationCommand,
  VerificationPlan,
  VerificationPlanPublication,
} from "@loomrail/contracts";

export type VerificationDomainErrorCode =
  | "OWNER_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "PROPOSAL_PROJECT_MISMATCH"
  | "PROPOSAL_HASH_MISMATCH"
  | "PROPOSAL_EMPTY"
  | "PROPOSAL_TARGET_BLOCKED"
  | "CURRENT_PLAN_PROJECT_MISMATCH"
  | "SYSTEM_REQUIRED"
  | "PUBLICATION_NOT_FOUND"
  | "PUBLICATION_VERSION_CONFLICT"
  | "PUBLICATION_PLAN_MISMATCH"
  | "PUBLICATION_STATUS_INVALID"
  | "LATEST_PLAN_REQUIRED";

export class VerificationDomainError extends Error {
  readonly code: VerificationDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: VerificationDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "VerificationDomainError";
    this.code = code;
    this.details = details;
  }
}

export type VerificationPlanAdoptedIntent = {
  type: "VERIFICATION_PLAN_ADOPTED";
  data: {
    plan: VerificationPlan;
    publication: VerificationPlanPublication;
    previousPlanRevision: number | null;
  };
};

export type VerificationPlanPublicationIntent = {
  type:
    | "VERIFICATION_PLAN_PUBLICATION_APPLIED"
    | "VERIFICATION_PLAN_PUBLICATION_FAILED"
    | "VERIFICATION_PLAN_PUBLICATION_RETRIED";
  data: {
    plan: VerificationPlan;
    publication: VerificationPlanPublication;
  };
};

export const decideVerificationPlanAdoption = (
  command: AdoptVerificationPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    newPublicationId: string;
    contentHash: string;
    observedProposalHash: string;
    project: Project | undefined;
    currentPlan?: VerificationPlan;
  },
): {
  project: Project;
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanAdoptedIntent;
} => {
  if (command.actor.type !== "HUMAN") {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can adopt a verification plan");
  }
  const currentProject = context.project;
  if (currentProject === undefined) {
    throw new VerificationDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (currentProject.status !== "ACTIVE") {
    throw new VerificationDomainError(
      "PROJECT_NOT_ACTIVE",
      "Only an active Project can adopt a verification plan",
    );
  }
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new VerificationDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after the verification preview was loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: currentProject.version,
      },
    );
  }
  const proposal = command.payload.proposal;
  if (command.payload.projectId !== currentProject.id || proposal.projectId !== currentProject.id) {
    throw new VerificationDomainError(
      "PROPOSAL_PROJECT_MISMATCH",
      "The verification preview belongs to a different Project",
    );
  }
  if (proposal.proposalHash !== context.observedProposalHash) {
    throw new VerificationDomainError(
      "PROPOSAL_HASH_MISMATCH",
      "The verification preview content does not match its proposal hash",
    );
  }
  if (proposal.recipes.length === 0) {
    throw new VerificationDomainError(
      "PROPOSAL_EMPTY",
      "A warning-only verification preview cannot be adopted",
    );
  }
  if (proposal.target.state === "BLOCKED") {
    throw new VerificationDomainError(
      "PROPOSAL_TARGET_BLOCKED",
      "The verification plan target must be resolved before adoption",
    );
  }
  if (context.currentPlan !== undefined && context.currentPlan.projectId !== currentProject.id) {
    throw new VerificationDomainError(
      "CURRENT_PLAN_PROJECT_MISMATCH",
      "The current verification plan belongs to a different Project",
    );
  }

  const previousPlanRevision = context.currentPlan?.revision ?? null;
  const plan: VerificationPlan = {
    schemaVersion: 1,
    id: context.newPlanId,
    projectId: currentProject.id,
    revision: (previousPlanRevision ?? 0) + 1,
    status: "ACTIVE",
    recipes: proposal.recipes,
    sourceProposalHash: proposal.proposalHash,
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  const publication: VerificationPlanPublication = {
    schemaVersion: 1,
    id: context.newPublicationId,
    projectId: currentProject.id,
    planId: plan.id,
    targetPath: ".loomrail/verification-plan.json",
    expectedTargetDigest: proposal.target.state === "PRESENT" ? proposal.target.digest : null,
    contentHash: plan.contentHash,
    status: "PENDING",
    attempts: 0,
    lastErrorCode: null,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    appliedAt: null,
  };

  return {
    project,
    plan,
    publication,
    event: {
      type: "VERIFICATION_PLAN_ADOPTED",
      data: { plan, publication, previousPlanRevision },
    },
  };
};

const requirePublication = (
  publication: VerificationPlanPublication | undefined,
  plan: VerificationPlan | undefined,
  expectedVersion: number,
): { publication: VerificationPlanPublication; plan: VerificationPlan } => {
  if (publication === undefined) {
    throw new VerificationDomainError("PUBLICATION_NOT_FOUND", "The verification publication does not exist");
  }
  if (publication.version !== expectedVersion) {
    throw new VerificationDomainError(
      "PUBLICATION_VERSION_CONFLICT",
      "The verification publication changed after it was loaded",
      { expectedVersion, actualVersion: publication.version },
    );
  }
  if (
    plan?.id !== publication.planId ||
    publication.projectId !== plan.projectId ||
    publication.contentHash !== plan.contentHash
  ) {
    throw new VerificationDomainError(
      "PUBLICATION_PLAN_MISMATCH",
      "The verification publication does not match its immutable Plan",
    );
  }
  return { publication, plan };
};

export const decideVerificationPlanPublicationCompleted = (
  command: CompleteVerificationPlanPublicationCommand,
  context: {
    now: string;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "SYSTEM") {
    throw new VerificationDomainError("SYSTEM_REQUIRED", "Only the publisher can complete publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.status !== "PENDING") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending verification publication can complete",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "APPLIED",
    attempts: current.publication.attempts + 1,
    lastErrorCode: null,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: context.now,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_APPLIED", data: { plan: current.plan, publication } },
  };
};

export const decideVerificationPlanPublicationFailed = (
  command: FailVerificationPlanPublicationCommand,
  context: {
    now: string;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "SYSTEM") {
    throw new VerificationDomainError("SYSTEM_REQUIRED", "Only the publisher can fail publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.status !== "PENDING") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending verification publication can fail",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "FAILED",
    attempts: current.publication.attempts + 1,
    lastErrorCode: command.payload.errorCode,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_FAILED", data: { plan: current.plan, publication } },
  };
};

export const decideVerificationPlanPublicationRetry = (
  command: RetryVerificationPlanPublicationCommand,
  context: {
    now: string;
    latestPlanRevision: number;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "HUMAN") {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can retry publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.projectId !== command.payload.projectId) {
    throw new VerificationDomainError(
      "PUBLICATION_PLAN_MISMATCH",
      "The verification publication belongs to a different Project",
    );
  }
  if (current.plan.revision !== context.latestPlanRevision) {
    throw new VerificationDomainError(
      "LATEST_PLAN_REQUIRED",
      "Only the latest verification Plan publication can be retried",
    );
  }
  if (current.publication.status !== "FAILED") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a failed verification publication can be retried",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "PENDING",
    lastErrorCode: null,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_RETRIED", data: { plan: current.plan, publication } },
  };
};
