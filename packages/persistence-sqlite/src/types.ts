import type {
  DomainEvent,
  HumanRequest,
  HumanRequestStatus,
  Project,
  StateCommand,
  StateCommandResult,
  WorkItem,
  WorkItemState,
  WorkflowDispatch,
  WorkflowSnapshot,
} from "@loomrail/contracts";

export type StateStoreErrorCode =
  | "COMMAND_ID_REUSED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ALREADY_REGISTERED"
  | "MIGRATION_DRIFT"
  | "MIGRATION_FAILED"
  | "PERSISTENCE_FAILURE"
  | "STATE_CLOSED";

export class StateStoreError extends Error {
  readonly code: StateStoreErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: StateStoreErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StateStoreError";
    this.code = code;
    this.details = details;
  }
}

export type StateQuery =
  | { type: "LIST_PROJECTS" }
  | { type: "GET_PROJECT"; projectId: string }
  | { type: "GET_WORK_ITEM"; workItemId: string }
  | { type: "GET_WORKFLOW_SNAPSHOT"; workItemId: string }
  | {
      type: "LIST_HUMAN_REQUESTS";
      projectId?: string;
      status?: HumanRequestStatus;
    }
  | { type: "LIST_PENDING_DISPATCHES" }
  | {
      type: "LIST_WORK_ITEMS";
      projectId: string;
      state?: WorkItemState;
    }
  | {
      type: "LIST_EVENTS";
      afterSequence?: number;
      projectId?: string;
      aggregateId?: string;
      limit?: number;
    };

export type StateQueryResult =
  | { type: "PROJECTS"; projects: Project[] }
  | { type: "PROJECT"; project: Project | null }
  | { type: "WORK_ITEM"; workItem: WorkItem | null }
  | { type: "WORKFLOW_SNAPSHOT"; snapshot: WorkflowSnapshot }
  | { type: "HUMAN_REQUESTS"; humanRequests: HumanRequest[] }
  | { type: "WORKFLOW_DISPATCHES"; dispatches: WorkflowDispatch[] }
  | { type: "WORK_ITEMS"; workItems: WorkItem[] }
  | { type: "EVENTS"; events: DomainEvent[]; nextSequence: number };

export type StateStoreStartup = {
  appliedMigrations: number[];
  backupPath?: string;
};

export type LocalState = {
  readonly startup: StateStoreStartup;
  execute: (command: StateCommand) => StateCommandResult;
  query: (query: StateQuery) => StateQueryResult;
  close: () => void;
};

export type LocalStateIdKind =
  | "workItem"
  | "event"
  | "pipelineRun"
  | "stageAttempt"
  | "workflowDispatch"
  | "humanRequest"
  | "decision"
  | "budgetPolicy"
  | "usageRecord"
  | "recoveryReport"
  | "evidenceArtifact"
  | "acceptancePackage";

export type OpenLocalStateOptions = {
  databasePath: string;
  backupsDirectory?: string;
  migrationsDirectory?: string;
  now?: () => Date;
  createId?: (kind: LocalStateIdKind) => string;
};
