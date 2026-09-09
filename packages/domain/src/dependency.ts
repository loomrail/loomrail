import {
  MAX_DEPENDENCY_GRAPH_EDGES,
  MAX_DEPENDENCY_GRAPH_WORK_ITEMS,
  MAX_WORK_ITEM_BLOCKERS,
  type SetWorkItemDependenciesCommand,
  type WorkItem,
  type WorkItemDependency,
} from "@loomrail/contracts";

export type WorkItemDependencyErrorCode =
  | "DEPENDENCY_ACTOR_FORBIDDEN"
  | "DEPENDENCY_TARGET_NOT_FOUND"
  | "DEPENDENCY_VERSION_CONFLICT"
  | "DEPENDENCY_TARGET_ACTIVE"
  | "DEPENDENCY_TARGET_TERMINAL"
  | "DEPENDENCY_DUPLICATE"
  | "DEPENDENCY_SELF_REFERENCE"
  | "DEPENDENCY_WORK_ITEM_NOT_FOUND"
  | "DEPENDENCY_PROJECT_MISMATCH"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_GRAPH_LIMIT"
  | "DEPENDENCY_GRAPH_INVALID"
  | "DEPENDENCY_NO_CHANGES";

export class WorkItemDependencyError extends Error {
  readonly code: WorkItemDependencyErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkItemDependencyErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "WorkItemDependencyError";
    this.code = code;
    this.details = details;
  }
}

export type SetWorkItemDependenciesContext = {
  now: string;
  target?: WorkItem;
  projectWorkItems: readonly WorkItem[];
  dependencies: readonly WorkItemDependency[];
  hasActiveWorkflow: boolean;
};

export type SetWorkItemDependenciesDecision = {
  blockedWorkItem: WorkItem;
  dependencies: readonly WorkItemDependency[];
  addedBlockerWorkItemIds: readonly string[];
  removedBlockerWorkItemIds: readonly string[];
  event: {
    type: "WORK_ITEM_DEPENDENCIES_SET";
    data: {
      blockedWorkItemId: string;
      previousBlockerWorkItemIds: readonly string[];
      blockerWorkItemIds: readonly string[];
      workItemVersion: number;
    };
  };
};

export type WorkItemDependencyEventIntent = SetWorkItemDependenciesDecision["event"];

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const canonicalIds = (ids: readonly string[]): string[] => [...ids].sort(compareIds);

const hasCycle = (workItemIds: readonly string[], dependencies: readonly WorkItemDependency[]): boolean => {
  const successors = new Map(workItemIds.map((id) => [id, [] as string[]]));
  const indegree = new Map(workItemIds.map((id) => [id, 0]));
  for (const dependency of dependencies) {
    const targets = successors.get(dependency.blockerWorkItemId);
    if (targets === undefined || !indegree.has(dependency.blockedWorkItemId)) {
      throw new WorkItemDependencyError(
        "DEPENDENCY_GRAPH_INVALID",
        "The persisted dependency graph references an unknown WorkItem",
      );
    }
    targets.push(dependency.blockedWorkItemId);
    indegree.set(dependency.blockedWorkItemId, (indegree.get(dependency.blockedWorkItemId) ?? 0) + 1);
  }

  const ready = canonicalIds(
    [...indegree.entries()].filter(([, count]) => count === 0).map(([workItemId]) => workItemId),
  );
  let visited = 0;
  // Array iterators observe values appended during traversal, so this remains a bounded queue
  // without repeatedly shifting a 10,000-item array.
  for (const workItemId of ready) {
    visited += 1;
    for (const successor of successors.get(workItemId) ?? []) {
      const next = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, next);
      if (next === 0) ready.push(successor);
    }
  }
  return visited !== workItemIds.length;
};

export const decideSetWorkItemDependencies = (
  command: SetWorkItemDependenciesCommand,
  context: SetWorkItemDependenciesContext,
): SetWorkItemDependenciesDecision => {
  if (command.actor.type !== "HUMAN") {
    throw new WorkItemDependencyError(
      "DEPENDENCY_ACTOR_FORBIDDEN",
      "Only the owner can change WorkItem dependencies",
    );
  }
  const target = context.target;
  if (target?.id !== command.payload.workItemId) {
    throw new WorkItemDependencyError("DEPENDENCY_TARGET_NOT_FOUND", "The blocked WorkItem does not exist");
  }
  if (target.version !== command.payload.expectedVersion) {
    throw new WorkItemDependencyError(
      "DEPENDENCY_VERSION_CONFLICT",
      "The blocked WorkItem changed after it was loaded",
      { expectedVersion: command.payload.expectedVersion, actualVersion: target.version },
    );
  }
  if (context.hasActiveWorkflow) {
    throw new WorkItemDependencyError(
      "DEPENDENCY_TARGET_ACTIVE",
      "Dependencies cannot change while the WorkItem has an active workflow",
    );
  }
  if (target.state === "DONE" || target.state === "CANCELLED") {
    throw new WorkItemDependencyError(
      "DEPENDENCY_TARGET_TERMINAL",
      "Dependencies cannot change after the WorkItem is terminal",
      { state: target.state },
    );
  }
  if (context.projectWorkItems.length > MAX_DEPENDENCY_GRAPH_WORK_ITEMS) {
    throw new WorkItemDependencyError(
      "DEPENDENCY_GRAPH_LIMIT",
      "The Project dependency graph is too large to validate safely",
      { workItems: context.projectWorkItems.length },
    );
  }
  if (context.dependencies.length > MAX_DEPENDENCY_GRAPH_EDGES) {
    throw new WorkItemDependencyError(
      "DEPENDENCY_GRAPH_LIMIT",
      "The Project dependency graph is too large to validate safely",
      { dependencies: context.dependencies.length },
    );
  }

  const requested = command.payload.blockerWorkItemIds;
  if (requested.length > MAX_WORK_ITEM_BLOCKERS) {
    throw new WorkItemDependencyError("DEPENDENCY_GRAPH_LIMIT", "A WorkItem has too many incoming blockers", {
      dependencies: requested.length,
    });
  }
  if (new Set(requested).size !== requested.length) {
    throw new WorkItemDependencyError(
      "DEPENDENCY_DUPLICATE",
      "A blocker may appear only once for one WorkItem",
    );
  }
  if (requested.includes(target.id)) {
    throw new WorkItemDependencyError("DEPENDENCY_SELF_REFERENCE", "A WorkItem cannot block itself");
  }

  const workItemsById = new Map(context.projectWorkItems.map((workItem) => [workItem.id, workItem]));
  if (!workItemsById.has(target.id)) workItemsById.set(target.id, target);
  for (const blockerWorkItemId of requested) {
    const blocker = workItemsById.get(blockerWorkItemId);
    if (blocker === undefined) {
      throw new WorkItemDependencyError(
        "DEPENDENCY_WORK_ITEM_NOT_FOUND",
        "A requested blocker WorkItem does not exist",
      );
    }
    if (blocker.projectId !== target.projectId) {
      throw new WorkItemDependencyError(
        "DEPENDENCY_PROJECT_MISMATCH",
        "A dependency must stay inside one Project",
      );
    }
  }

  for (const dependency of context.dependencies) {
    if (dependency.projectId !== target.projectId) {
      throw new WorkItemDependencyError(
        "DEPENDENCY_GRAPH_INVALID",
        "The dependency graph crosses the Project boundary",
      );
    }
  }

  const previousIncoming = context.dependencies.filter(
    ({ blockedWorkItemId }) => blockedWorkItemId === target.id,
  );
  const previousIds = canonicalIds(previousIncoming.map(({ blockerWorkItemId }) => blockerWorkItemId));
  const nextIds = canonicalIds(requested);
  if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) {
    throw new WorkItemDependencyError("DEPENDENCY_NO_CHANGES", "The requested blockers are already current");
  }

  const retainedByBlocker = new Map(
    previousIncoming.map((dependency) => [dependency.blockerWorkItemId, dependency]),
  );
  const nextIncoming = nextIds.map(
    (blockerWorkItemId): WorkItemDependency =>
      retainedByBlocker.get(blockerWorkItemId) ?? {
        schemaVersion: 1,
        projectId: target.projectId,
        kind: "BLOCKS",
        blockerWorkItemId,
        blockedWorkItemId: target.id,
        createdAt: context.now,
      },
  );
  const nextGraph = [
    ...context.dependencies.filter(({ blockedWorkItemId }) => blockedWorkItemId !== target.id),
    ...nextIncoming,
  ];
  if (hasCycle([...workItemsById.keys()], nextGraph)) {
    throw new WorkItemDependencyError("DEPENDENCY_CYCLE", "The requested dependencies would create a cycle");
  }

  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);
  const blockedWorkItem: WorkItem = {
    ...target,
    version: target.version + 1,
    updatedAt: context.now,
  };
  return {
    blockedWorkItem,
    dependencies: nextIncoming,
    addedBlockerWorkItemIds: nextIds.filter((id) => !previousSet.has(id)),
    removedBlockerWorkItemIds: previousIds.filter((id) => !nextSet.has(id)),
    event: {
      type: "WORK_ITEM_DEPENDENCIES_SET",
      data: {
        blockedWorkItemId: target.id,
        previousBlockerWorkItemIds: previousIds,
        blockerWorkItemIds: nextIds,
        workItemVersion: blockedWorkItem.version,
      },
    },
  };
};
