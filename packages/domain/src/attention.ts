import {
  attentionInboxResponseSchema,
  maxAttentionItems,
  maxAttentionProjectionSources,
  type AttentionCategory,
  type AttentionInboxResponse,
  type AttentionSection,
  type HumanRequest,
  type Project,
  type StageAttempt,
  type WorkItem,
} from "@loomrail/contracts";

import { isSessionPauseFailureCode } from "./session-pause.js";

export type AttentionProjectionSource = {
  request: HumanRequest;
  project: Project;
  workItem: WorkItem;
  stageAttempt: StageAttempt;
  acceptancePackageId: string | null;
};

export class AttentionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttentionProjectionError";
  }
}

// Code-unit order, never `localeCompare`: the inbox order must not depend on the host's collation.
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sectionOrder: Readonly<Record<AttentionSection, number>> = {
  BLOCKING_NOW: 0,
  APPROVALS: 1,
  QUESTIONS: 2,
  MANUAL_ACTIONS: 3,
  SOON: 4,
};

const priorityOrder: Readonly<Record<WorkItem["priority"], number>> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const requireConsistentSource = (source: AttentionProjectionSource): void => {
  const { acceptancePackageId, project, request, stageAttempt, workItem } = source;
  if (request.status !== "OPEN") {
    throw new AttentionProjectionError("Attention Inbox can only project open HumanRequests");
  }
  if (
    request.projectId !== project.id ||
    request.projectId !== workItem.projectId ||
    request.projectId !== stageAttempt.projectId
  ) {
    throw new AttentionProjectionError("The Attention source crosses Project identities");
  }
  if (request.workItemId !== workItem.id || request.workItemId !== stageAttempt.workItemId) {
    throw new AttentionProjectionError("The Attention source crosses WorkItem identities");
  }
  if (request.stageAttemptId !== stageAttempt.id) {
    throw new AttentionProjectionError("The HumanRequest is not attached to the projected StageAttempt");
  }
  if (workItem.currentStage !== stageAttempt.stage) {
    throw new AttentionProjectionError("The Attention source does not describe the current WorkItem stage");
  }
  if (acceptancePackageId !== null && stageAttempt.stage !== "ACCEPTANCE") {
    throw new AttentionProjectionError("An AcceptancePackage must belong to the Acceptance stage");
  }
};

const categoryFor = (source: AttentionProjectionSource): AttentionCategory => {
  if (source.acceptancePackageId !== null) return "APPROVAL";
  if (source.stageAttempt.failureCode === "PROVIDER_RATE_LIMITED") return "MANUAL_ACTION";
  if (
    source.stageAttempt.status === "HARD_PAUSED" &&
    isSessionPauseFailureCode(source.stageAttempt.failureCode)
  ) {
    return "MANUAL_ACTION";
  }
  return "QUESTION";
};

const sectionFor = (request: HumanRequest, category: AttentionCategory): AttentionSection => {
  if (request.blocking) return "BLOCKING_NOW";
  switch (category) {
    case "APPROVAL":
      return "APPROVALS";
    case "QUESTION":
      return "QUESTIONS";
    case "MANUAL_ACTION":
      return "MANUAL_ACTIONS";
  }
};

/**
 * Builds the complete owner-facing Attention projection behind one deterministic interface.
 *
 * Persistence supplies at most `maxAttentionItems + 1` consistent local records. This module owns
 * their referential checks, classification, stable ordering and truncation; daemon and web only
 * parse and render its closed output.
 */
export const buildAttentionInbox = (
  sources: readonly AttentionProjectionSource[],
): AttentionInboxResponse => {
  if (sources.length > maxAttentionProjectionSources) {
    throw new AttentionProjectionError(
      `Attention projection received more than ${maxAttentionProjectionSources.toString()} bounded sources`,
    );
  }

  const ordered = sources
    .map((source) => {
      requireConsistentSource(source);
      const category = categoryFor(source);
      return {
        schemaVersion: 1 as const,
        id: source.request.id,
        request: source.request,
        project: { id: source.project.id, name: source.project.name },
        workItem: {
          id: source.workItem.id,
          title: source.workItem.title,
          priority: source.workItem.priority,
          state: source.workItem.state,
        },
        stage: {
          id: source.stageAttempt.id,
          name: source.stageAttempt.stage,
          status: source.stageAttempt.status,
        },
        section: sectionFor(source.request, category),
        category,
        reason:
          source.stageAttempt.failureCode === "PROVIDER_RATE_LIMITED"
            ? ("PROVIDER_RATE_LIMITED" as const)
            : null,
        action:
          source.acceptancePackageId === null ? ("ANSWER_REQUEST" as const) : ("REVIEW_ACCEPTANCE" as const),
        acceptancePackageId: source.acceptancePackageId,
        affectedStages: [source.stageAttempt.stage],
      };
    })
    .sort((left, right) => {
      const section = sectionOrder[left.section] - sectionOrder[right.section];
      if (section !== 0) return section;
      const priority = priorityOrder[left.workItem.priority] - priorityOrder[right.workItem.priority];
      if (priority !== 0) return priority;
      const age = compareText(left.request.createdAt, right.request.createdAt);
      return age !== 0 ? age : compareText(left.id, right.id);
    });

  return attentionInboxResponseSchema.parse({
    schemaVersion: 1,
    items: ordered.slice(0, maxAttentionItems),
    hasMore: ordered.length > maxAttentionItems,
  });
};
