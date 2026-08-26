import type { ContextSources } from "@loomrail/context-assembly";
import type {
  Checkpoint,
  ContextPackRecipe,
  ContextWindowUsage,
  DomainEvent,
  EventPageDirection,
  HumanRequest,
  HumanRequestStatus,
  Project,
  ProviderSession,
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
  | "STATE_CLOSED"
  // Storage invariant, not a domain decision (spec §6.1 step 4 / this package's Task 7 boundary):
  // a StageAttempt must never have two RUNNING ProviderSessions at once, since that would mean two
  // agents working the same StageAttempt's workspace concurrently.
  | "PROVIDER_SESSION_ALREADY_RUNNING"
  // Guards PUBLISH_CHECKPOINT/END_PROVIDER_SESSION against acting on a session that already ended.
  | "PROVIDER_SESSION_NOT_RUNNING";

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
      direction?: EventPageDirection;
      afterSequence?: number;
      beforeSequence?: number;
      projectId?: string;
      aggregateId?: string;
      limit?: number;
    }
  | {
      // Spec §6.1 step 1: every context source read together, as one consistent snapshot, so the
      // recipe's per-section sourceVersion describes a pack that actually existed.
      type: "READ_CONTEXT_SOURCES";
      stageAttemptId: string;
      sessionOrdinal: number;
    }
  | {
      // Spec §D5: an attempt's sessions, the recipe each was assembled from, and the checkpoints
      // published under it. Separate from GET_WORKFLOW_SNAPSHOT because session history grows
      // within a single attempt and the snapshot is read on every board render.
      type: "LIST_PROVIDER_SESSIONS";
      stageAttemptId: string;
    };

export type StateQueryResult =
  | { type: "PROJECTS"; projects: Project[] }
  | { type: "PROJECT"; project: Project | null }
  | { type: "WORK_ITEM"; workItem: WorkItem | null }
  | { type: "WORKFLOW_SNAPSHOT"; snapshot: WorkflowSnapshot }
  | { type: "HUMAN_REQUESTS"; humanRequests: HumanRequest[] }
  | { type: "WORKFLOW_DISPATCHES"; dispatches: WorkflowDispatch[] }
  | { type: "WORK_ITEMS"; workItems: WorkItem[] }
  | { type: "EVENTS"; events: DomainEvent[]; nextSequence: number; hasMore: boolean }
  | { type: "CONTEXT_SOURCES"; sources: ContextSources }
  | {
      type: "PROVIDER_SESSIONS";
      sessions: ProviderSession[];
      recipes: ContextPackRecipe[];
      checkpoints: Checkpoint[];
      // Spec §6.2: the latest window occupancy each session was able to act on, read from the
      // session's own columns (migration 0009) rather than replayed out of the audit log. Keyed by
      // ProviderSession id; a session that never received a report has no entry, which is a
      // different fact from a session reported at zero.
      contextWindowUsage: Record<string, ContextWindowUsage>;
    };

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
  | "acceptancePackage"
  | "providerSession"
  | "contextPackRecipe"
  | "checkpoint";

export type OpenLocalStateOptions = {
  databasePath: string;
  backupsDirectory?: string;
  migrationsDirectory?: string;
  now?: () => Date;
  createId?: (kind: LocalStateIdKind) => string;
  // Test-only instrumentation, in the same spirit as `now`/`createId` above: called synchronously
  // right after READ_CONTEXT_SOURCES's snapshot transaction takes its first read (of the
  // StageAttempt row), before it reads any other source. A test can use this moment to commit a
  // write through a second connection to the same database file and then assert that the rest of
  // this same READ_CONTEXT_SOURCES call still reflects the pre-write snapshot -- the one
  // observable difference between "wrapped in one transaction" and "read as independent
  // statements". Never set outside tests; a no-op when absent.
  onContextSourcesSnapshotStarted?: () => void;
};
