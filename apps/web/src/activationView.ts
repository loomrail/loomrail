import {
  guidedActivationContract,
  type ListedProject,
  type ProjectProviderSelectionResponse,
  type WorkItem,
  type WorkflowSnapshot,
} from "@loomrail/contracts";

export const guidedActivationPhases = [
  "WORKSPACE",
  "PROVIDER",
  "TASK",
  "READY",
  "RUN",
  "REQUEST",
  "REVIEW",
  "QA",
  "ACCEPTANCE",
  "COMPLETE",
] as const;

export type GuidedActivationPhase = (typeof guidedActivationPhases)[number];

export type GuidedActivationProjection = {
  completed: readonly GuidedActivationPhase[];
  current: GuidedActivationPhase;
};

export const isGuidedActivationTask = (workItem: WorkItem): boolean => {
  const recipe = guidedActivationContract.task;
  return (
    workItem.title === recipe.title &&
    workItem.description === recipe.description &&
    workItem.priority === recipe.priority &&
    workItem.risk === recipe.risk &&
    workItem.type === recipe.type &&
    workItem.acceptanceCriteria.length === recipe.acceptanceCriteria.length &&
    workItem.acceptanceCriteria.every((criterion, index) => criterion === recipe.acceptanceCriteria[index])
  );
};

export const selectGuidedActivationTask = (
  workItems: readonly WorkItem[],
  requestedTaskId?: string,
): WorkItem | null => {
  const candidates = workItems.filter(
    (workItem) => workItem.state !== "CANCELLED" && isGuidedActivationTask(workItem),
  );
  const requested = candidates.find(({ id }) => id === requestedTaskId);
  if (requested !== undefined) return requested;
  return [...candidates].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).at(0) ?? null;
};

const completedBefore = (current: GuidedActivationPhase): readonly GuidedActivationPhase[] =>
  guidedActivationPhases.slice(0, guidedActivationPhases.indexOf(current));

export const projectGuidedActivation = (
  project: ListedProject | null,
  providerSelection: ProjectProviderSelectionResponse | null,
  workItem: WorkItem | null,
  workflow: WorkflowSnapshot | null,
): GuidedActivationProjection => {
  const run = workflow?.run ?? null;
  const acceptancePackage = workflow?.acceptancePackage ?? null;
  const currentAttempt = workflow?.stageAttempts.find(({ id }) => id === run?.currentStageAttemptId) ?? null;
  let current: GuidedActivationPhase;
  if (project?.repositoryStatus !== "READY") current = "WORKSPACE";
  else if (providerSelection?.selection.preference !== "MOCK") current = "PROVIDER";
  else if (workItem === null) current = "TASK";
  else if (workItem.state === "BACKLOG") current = "READY";
  else if (run === null) current = "RUN";
  else if (acceptancePackage !== null && acceptancePackage.status !== "PENDING") {
    current = "COMPLETE";
  } else if (acceptancePackage?.status === "PENDING") current = "ACCEPTANCE";
  else if (currentAttempt?.stage === "QA" || currentAttempt?.stage === "ACCEPTANCE") current = "QA";
  else if (currentAttempt?.stage === "REVIEW") current = "REVIEW";
  else current = "REQUEST";
  return { current, completed: completedBefore(current) };
};
