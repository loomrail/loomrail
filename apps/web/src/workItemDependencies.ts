import type { WorkItem, WorkItemDependency } from "@loomrail/contracts";

export type WorkItemDependencyView = {
  parent: WorkItem | null;
  children: readonly WorkItem[];
  blockers: readonly WorkItem[];
  blockedWorkItems: readonly WorkItem[];
  unsatisfiedBlockers: readonly WorkItem[];
};

const compareByCreatedAtAndId = (left: WorkItem, right: WorkItem): number => {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export const deriveWorkItemDependencyView = (
  workItem: WorkItem,
  projectWorkItems: readonly WorkItem[],
  dependencies: readonly WorkItemDependency[],
): WorkItemDependencyView => {
  const byId = new Map(projectWorkItems.map((candidate) => [candidate.id, candidate]));
  const blockers = dependencies
    .filter(({ blockedWorkItemId }) => blockedWorkItemId === workItem.id)
    .map(({ blockerWorkItemId }) => byId.get(blockerWorkItemId))
    .filter((candidate): candidate is WorkItem => candidate !== undefined)
    .sort(compareByCreatedAtAndId);
  const blockedWorkItems = dependencies
    .filter(({ blockerWorkItemId }) => blockerWorkItemId === workItem.id)
    .map(({ blockedWorkItemId }) => byId.get(blockedWorkItemId))
    .filter((candidate): candidate is WorkItem => candidate !== undefined)
    .sort(compareByCreatedAtAndId);

  return {
    parent: workItem.parentId === null ? null : (byId.get(workItem.parentId) ?? null),
    children: projectWorkItems
      .filter(({ parentId }) => parentId === workItem.id)
      .sort(compareByCreatedAtAndId),
    blockers,
    blockedWorkItems,
    // A cancelled prerequisite does not satisfy delivery; only accepted Done work does.
    unsatisfiedBlockers: blockers.filter(({ state }) => state !== "DONE"),
  };
};
