export * from "./attention.js";
export * from "./acceptance.js";
export * from "./agents.js";
export * from "./constitution.js";
export * from "./mcp.js";
export * from "./readiness.js";
export * from "./review.js";
export * from "./scaffolding.js";
export * from "./provider-selection.js";
export * from "./provider-allowance.js";
export * from "./qa.js";
export * from "./qa-correction.js";
export * from "./reporting.js";

import type {
  CreateWorkItemCommand,
  MoveWorkItemCommand,
  UpdateWorkItemCommand,
  WorkItem,
  WorkItemChangedField,
  WorkItemState,
} from "@loomrail/contracts";

export type WorkItemDomainErrorCode =
  | "WORK_ITEM_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "PARENT_PROJECT_MISMATCH"
  | "PARENT_CYCLE"
  | "PARENT_IN_PROGRESS"
  | "VERSION_CONFLICT"
  | "NO_CHANGES"
  | "INVALID_TRANSITION"
  | "ACCEPTANCE_REQUIRED"
  | "TERMINAL_STATE"
  | "WORK_ITEM_HAS_CHILDREN"
  | "ACTIVE_WORKFLOW_CONTROLS_STATE";

export class WorkItemDomainError extends Error {
  readonly code: WorkItemDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkItemDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "WorkItemDomainError";
    this.code = code;
    this.details = details;
  }
}

export type WorkItemCommand = CreateWorkItemCommand | UpdateWorkItemCommand | MoveWorkItemCommand;

export type WorkItemDecisionContext = {
  now: string;
  newWorkItemId?: string;
  current?: WorkItem;
  parent?: WorkItem;
  hasChildren?: boolean;
};

export type WorkItemEventIntent =
  | { type: "WORK_ITEM_CREATED"; data: { workItem: WorkItem } }
  | {
      type: "WORK_ITEM_UPDATED";
      data: { workItem: WorkItem; changedFields: WorkItemChangedField[] };
    }
  | {
      type: "WORK_ITEM_STATE_CHANGED";
      data: { workItem: WorkItem; previousState: WorkItemState };
    };

export type WorkItemDecision = {
  workItem: WorkItem;
  event: WorkItemEventIntent;
};

const allowedTransitions: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

const requireCurrent = (context: WorkItemDecisionContext): WorkItem => {
  if (!context.current) {
    throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
  }
  return context.current;
};

const verifyVersion = (workItem: WorkItem, expectedVersion: number): void => {
  if (workItem.version !== expectedVersion) {
    throw new WorkItemDomainError("VERSION_CONFLICT", "The WorkItem changed after it was loaded", {
      expectedVersion,
      actualVersion: workItem.version,
    });
  }
};

const arraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const decideCreate = (command: CreateWorkItemCommand, context: WorkItemDecisionContext): WorkItemDecision => {
  if (!context.newWorkItemId) {
    throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "A new WorkItem ID was not supplied");
  }

  const parentId = command.payload.parentId;
  if (parentId !== null) {
    if (!context.parent) {
      throw new WorkItemDomainError("PARENT_NOT_FOUND", "The parent WorkItem does not exist");
    }
    if (context.parent.projectId !== command.payload.projectId) {
      throw new WorkItemDomainError(
        "PARENT_PROJECT_MISMATCH",
        "A parent WorkItem must belong to the same Project",
      );
    }
    if (context.parent.id === context.newWorkItemId) {
      throw new WorkItemDomainError("PARENT_CYCLE", "A WorkItem cannot be its own parent");
    }
    if (context.parent.state === "IN_PROGRESS") {
      throw new WorkItemDomainError(
        "PARENT_IN_PROGRESS",
        "A child cannot be added while its parent WorkItem is in progress",
      );
    }
  }

  const workItem: WorkItem = {
    schemaVersion: 1,
    id: context.newWorkItemId,
    projectId: command.payload.projectId,
    parentId,
    type: command.payload.type,
    title: command.payload.title,
    description: command.payload.description,
    state: "BACKLOG",
    currentStage: null,
    priority: command.payload.priority,
    risk: command.payload.risk,
    acceptanceCriteria: [...command.payload.acceptanceCriteria],
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
  };

  return { workItem, event: { type: "WORK_ITEM_CREATED", data: { workItem } } };
};

const decideUpdate = (command: UpdateWorkItemCommand, context: WorkItemDecisionContext): WorkItemDecision => {
  const current = requireCurrent(context);
  verifyVersion(current, command.payload.expectedVersion);

  const changedFields: WorkItemChangedField[] = [];
  const patch = command.payload.patch;
  if (patch.title !== undefined && patch.title !== current.title) changedFields.push("title");
  if (patch.description !== undefined && patch.description !== current.description)
    changedFields.push("description");
  if (patch.priority !== undefined && patch.priority !== current.priority) changedFields.push("priority");
  if (patch.risk !== undefined && patch.risk !== current.risk) changedFields.push("risk");
  if (
    patch.acceptanceCriteria !== undefined &&
    !arraysEqual(patch.acceptanceCriteria, current.acceptanceCriteria)
  )
    changedFields.push("acceptanceCriteria");

  if (changedFields.length === 0) {
    throw new WorkItemDomainError("NO_CHANGES", "The WorkItem update does not change any field");
  }

  const workItem: WorkItem = {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.risk === undefined ? {} : { risk: patch.risk }),
    ...(patch.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: [...patch.acceptanceCriteria] }),
    version: current.version + 1,
    updatedAt: context.now,
  };

  return {
    workItem,
    event: { type: "WORK_ITEM_UPDATED", data: { workItem, changedFields } },
  };
};

const decideMove = (command: MoveWorkItemCommand, context: WorkItemDecisionContext): WorkItemDecision => {
  const current = requireCurrent(context);
  verifyVersion(current, command.payload.expectedVersion);
  const targetState = command.payload.targetState;

  if (current.state === "DONE" || current.state === "CANCELLED") {
    throw new WorkItemDomainError("TERMINAL_STATE", "A terminal WorkItem cannot be moved", {
      state: current.state,
    });
  }
  if (targetState === "DONE") {
    throw new WorkItemDomainError("ACCEPTANCE_REQUIRED", "Done requires a recorded final human acceptance");
  }
  if (!allowedTransitions[current.state].includes(targetState)) {
    throw new WorkItemDomainError("INVALID_TRANSITION", "The requested WorkItem transition is not allowed", {
      from: current.state,
      to: targetState,
    });
  }
  if (targetState === "IN_PROGRESS" && context.hasChildren) {
    throw new WorkItemDomainError("WORK_ITEM_HAS_CHILDREN", "Only leaf WorkItems can enter execution");
  }

  const workItem: WorkItem = {
    ...current,
    state: targetState,
    version: current.version + 1,
    updatedAt: context.now,
  };

  return {
    workItem,
    event: {
      type: "WORK_ITEM_STATE_CHANGED",
      data: { workItem, previousState: current.state },
    },
  };
};

export const decideWorkItemCommand = (
  command: WorkItemCommand,
  context: WorkItemDecisionContext,
): WorkItemDecision => {
  switch (command.type) {
    case "CREATE_WORK_ITEM":
      return decideCreate(command, context);
    case "UPDATE_WORK_ITEM":
      return decideUpdate(command, context);
    case "MOVE_WORK_ITEM":
      return decideMove(command, context);
  }
};

export * from "./workflow.js";
export * from "./session-pause.js";
export * from "./session.js";
export * from "./workspace.js";
