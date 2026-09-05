import type { ContextSources } from "@loomrail/context-assembly";
import type {
  AttentionInboxResponse,
  AgentRun,
  AgentRunStatus,
  Checkpoint,
  ConstitutionProposal,
  ConstitutionPublication,
  ContextPackRecipe,
  ContextWindowUsage,
  DomainEvent,
  EventPageDirection,
  HumanRequest,
  HumanRequestStatus,
  McpProfileView,
  McpSessionSnapshot,
  McpToolCallRecord,
  Project,
  ProjectConstitutionSnapshot,
  ProjectConstitutionVersion,
  ProjectReadinessSnapshot,
  QAAttachmentRef,
  QACorrectionRun,
  QADefect,
  QAEvidenceBundle,
  QARetestPlan,
  QARun,
  ReviewFinding,
  ReviewFindingStatus,
  ReviewReport,
  ReportingFacts,
  ProviderSession,
  ProviderAllowanceSnapshot,
  ProviderUsageReport,
  ScaffoldOperation,
  SquadAssignment,
  StateCommand,
  StateCommandResult,
  WorkItem,
  WorkItemState,
  WorkflowDispatch,
  WorkflowSnapshot,
  WorkItemWorkspace,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationCheck,
  VerificationCorrectionRun,
  VerificationFailure,
  VerificationRun,
} from "@loomrail/contracts";
import type { WorktreeEntry } from "@loomrail/workspace";

export type StateStoreErrorCode =
  | "COMMAND_ID_REUSED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ALREADY_REGISTERED"
  // REPOINT_FIXTURE_PROJECT declined: the Project is not the fixture-backed one it named, no longer
  // records the path the command expected, or already has a workspace cut from it. Distinct from
  // PROJECT_ALREADY_REGISTERED because the two say opposite things -- that one refuses because a
  // Project exists, this one refuses although one does, and only its narrow preconditions failed.
  | "PROJECT_REPOINT_REFUSED"
  | "MIGRATION_DRIFT"
  | "MIGRATION_FAILED"
  | "PERSISTENCE_FAILURE"
  | "STATE_CLOSED"
  // Storage invariant, not a domain decision (spec §6.1 step 4 / this package's Task 7 boundary):
  // a StageAttempt must never have two RUNNING ProviderSessions at once, since that would mean two
  // agents working the same StageAttempt's workspace concurrently.
  | "PROVIDER_SESSION_ALREADY_RUNNING"
  // Guards PUBLISH_CHECKPOINT/END_PROVIDER_SESSION against acting on a session that already ended.
  | "PROVIDER_SESSION_NOT_RUNNING"
  | "PROVIDER_USAGE_ACTOR_FORBIDDEN"
  | "PROVIDER_USAGE_ALREADY_RECORDED"
  // START_AGENT_RUN is daemon-internal. Keeping the actor refusal distinct prevents a browser or
  // future API handler from learning to manufacture capacity/workspace claims by copying payloads.
  | "AGENT_RUN_ACTOR_FORBIDDEN"
  | "AGENT_RUN_ALREADY_ACTIVE"
  | "AGENT_RUN_NOT_ACTIVE"
  | "AGENT_RUN_CAPACITY_EXHAUSTED"
  | "AGENT_RUN_BUDGET_EXHAUSTED"
  | "QA_RUN_ALREADY_EXISTS"
  | "QA_RUN_NOT_FOUND"
  | "QA_STABLE_TREE_MISSING"
  | "QA_ATTACHMENT_NOT_FOUND"
  | "QA_RETENTION_ACTOR_FORBIDDEN"
  | "VERIFICATION_RUN_ALREADY_ACTIVE"
  | "VERIFICATION_RUN_NOT_FOUND"
  | "VERIFICATION_CHECK_NOT_FOUND"
  | "VERIFICATION_OUTPUT_NOT_FOUND"
  | "VERIFICATION_RETENTION_ACTOR_FORBIDDEN"
  | "WORKSPACE_VERIFICATION_HELD"
  | "WORKSPACE_NOT_FOUND"
  // Storage invariant (migration 0011's UNIQUE on work_item_id, spec D1): the workspace belongs to
  // the WorkItem, and a second row for the same WorkItem would mean two writers past the lease.
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_VERSION_CONFLICT"
  // ACQUIRE_WORKSPACE_LEASE refuses to hand a workspace another StageAttempt is already writing in.
  | "WORKSPACE_LEASE_HELD"
  // RELEASE_WORKSPACE_LEASE is only ever valid from the attempt currently holding the lease (spec
  // D6); anyone else is refused rather than trusted.
  | "WORKSPACE_LEASE_NOT_OWNED"
  // MARK_WORKSPACE_ORPHANED is only ever taken from READY (spec §6, "Восстановление") -- an
  // ORPHANED or REMOVED workspace has already left the state this transition assumes.
  | "WORKSPACE_NOT_READY";

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
  | { type: "GET_REPORTING_FACTS" }
  | { type: "GET_PROJECT"; projectId: string }
  | { type: "GET_PROVIDER_ALLOWANCES"; projectId: string }
  // Reads the raw `projects` row for a path, PROVISIONING included -- unlike LIST_PROJECTS, which
  // hides a Project whose repository the scaffold publisher has not verified yet. A caller about to
  // claim a path has to see exactly what the UNIQUE index and REGISTER_PROJECT see.
  | { type: "GET_PROJECT_BY_REPOSITORY_PATH"; repositoryPath: string }
  | { type: "GET_PROJECT_CONSTITUTION_SNAPSHOT"; projectId: string }
  | { type: "GET_PROJECT_VERIFICATION_PLAN"; projectId: string }
  | { type: "GET_VERIFICATION_RUN"; runId: string }
  | { type: "GET_VERIFICATION_RUN_CONTEXT"; runId: string }
  | { type: "LIST_WORK_ITEM_VERIFICATION_RUNS"; workItemId: string; limit?: number }
  | { type: "LIST_WORK_ITEM_VERIFICATION_FAILURES"; workItemId: string; limit?: number }
  | { type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS"; workItemId: string; limit?: number }
  | { type: "LIST_ACTIVE_VERIFICATION_RUNS" }
  | { type: "GET_VERIFICATION_OUTPUT_ARTIFACT"; checkId: string }
  | { type: "LIST_EXPIRED_VERIFICATION_OUTPUTS"; closedBefore: string; limit?: number }
  | { type: "GET_PROJECT_READINESS_SNAPSHOT"; projectId: string }
  | { type: "GET_PROJECT_MCP_PROFILES"; projectId: string }
  | { type: "LIST_PROVIDER_SESSION_MCP_SNAPSHOTS"; providerSessionId: string }
  | { type: "LIST_MCP_TOOL_CALLS"; providerSessionId: string }
  | { type: "LIST_PENDING_CONSTITUTION_PUBLICATIONS" }
  | { type: "LIST_PENDING_VERIFICATION_PLAN_PUBLICATIONS" }
  | { type: "GET_SCAFFOLD_OPERATION"; operationId: string }
  | { type: "LIST_PENDING_SCAFFOLD_OPERATIONS" }
  | { type: "LIST_OPEN_SCAFFOLD_OPERATIONS" }
  | { type: "GET_WORK_ITEM"; workItemId: string }
  | { type: "GET_WORKFLOW_SNAPSHOT"; workItemId: string }
  | { type: "GET_ATTENTION_INBOX" }
  | {
      type: "LIST_HUMAN_REQUESTS";
      projectId?: string;
      status?: HumanRequestStatus;
    }
  | { type: "LIST_PENDING_DISPATCHES" }
  | { type: "GET_SQUAD_ASSIGNMENT"; pipelineRunId: string }
  | { type: "GET_AGENT_RUN"; agentRunId: string }
  | { type: "GET_QA_RUN"; qaRunId: string }
  | { type: "GET_QA_STATE"; pipelineRunId: string }
  | { type: "LIST_EXPIRED_QA_ATTACHMENTS"; closedBefore: string; limit?: number }
  | { type: "GET_LATEST_SUCCEEDED_DEVELOPER_AGENT_RUN"; pipelineRunId: string }
  | { type: "LIST_AGENT_RUNS"; status?: AgentRunStatus; limit?: number }
  | {
      type: "LIST_REVIEW_REPORTS";
      pipelineRunId: string;
      limit?: number;
    }
  | {
      type: "LIST_REVIEW_FINDINGS";
      pipelineRunId: string;
      status?: ReviewFindingStatus;
      limit?: number;
    }
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
    }
  | {
      // The workspace belongs to the WorkItem (migration 0011's UNIQUE on work_item_id), so this is
      // the one read a caller needs to find the worktree a WorkItem is being edited in.
      type: "GET_WORKSPACE_BY_WORK_ITEM";
      workItemId: string;
    };

export type StateQueryResult =
  | { type: "PROJECTS"; projects: Project[] }
  | { type: "REPORTING_FACTS"; facts: ReportingFacts }
  | { type: "PROJECT"; project: Project | null }
  | { type: "PROVIDER_ALLOWANCES"; snapshots: ProviderAllowanceSnapshot[] }
  | { type: "PROJECT_CONSTITUTION_SNAPSHOT"; snapshot: ProjectConstitutionSnapshot }
  | {
      type: "PROJECT_VERIFICATION_PLAN";
      project: Project;
      plan: VerificationPlan | null;
      publication: VerificationPlanPublication | null;
    }
  | { type: "VERIFICATION_RUN"; run: VerificationRun | null; checks: VerificationCheck[] }
  | {
      type: "VERIFICATION_RUN_CONTEXT";
      run: VerificationRun;
      checks: VerificationCheck[];
      plan: VerificationPlan;
      workspace: WorkItemWorkspace;
    }
  | { type: "VERIFICATION_RUNS"; runs: VerificationRun[] }
  | { type: "VERIFICATION_FAILURES"; failures: VerificationFailure[] }
  | { type: "VERIFICATION_CORRECTIONS"; correctionRuns: VerificationCorrectionRun[] }
  | {
      type: "VERIFICATION_OUTPUT_ARTIFACT";
      artifact: { artifactId: string; checkId: string; runId: string; storageKey: string } | null;
    }
  | {
      type: "VERIFICATION_OUTPUTS";
      artifacts: { artifactId: string; storageKey: string }[];
    }
  | { type: "PROJECT_READINESS_SNAPSHOT"; snapshot: ProjectReadinessSnapshot }
  | { type: "PROJECT_MCP_PROFILES"; project: Project; profiles: McpProfileView[] }
  | { type: "MCP_SESSION_SNAPSHOTS"; snapshots: McpSessionSnapshot[] }
  | { type: "MCP_TOOL_CALLS"; calls: McpToolCallRecord[] }
  | { type: "SCAFFOLD_OPERATION"; operation: ScaffoldOperation | null }
  | { type: "SCAFFOLD_OPERATIONS"; operations: ScaffoldOperation[] }
  | {
      type: "CONSTITUTION_PUBLICATIONS";
      publications: {
        proposal: ConstitutionProposal;
        constitution: ProjectConstitutionVersion;
        publication: ConstitutionPublication;
      }[];
    }
  | {
      type: "VERIFICATION_PLAN_PUBLICATIONS";
      publications: { plan: VerificationPlan; publication: VerificationPlanPublication }[];
    }
  | { type: "WORK_ITEM"; workItem: WorkItem | null }
  | { type: "WORKFLOW_SNAPSHOT"; snapshot: WorkflowSnapshot }
  | { type: "ATTENTION_INBOX"; inbox: AttentionInboxResponse }
  | { type: "HUMAN_REQUESTS"; humanRequests: HumanRequest[] }
  | { type: "WORKFLOW_DISPATCHES"; dispatches: WorkflowDispatch[] }
  | { type: "SQUAD_ASSIGNMENT"; assignment: SquadAssignment | null }
  | { type: "AGENT_RUNS"; runs: AgentRun[] }
  | { type: "QA_RUN"; qaRun: QARun | null }
  | {
      type: "QA_STATE";
      runs: QARun[];
      evidence: QAEvidenceBundle[];
      attachments: QAAttachmentRef[];
      defects: QADefect[];
      correctionRuns: QACorrectionRun[];
      retestPlans: QARetestPlan[];
    }
  | { type: "QA_ATTACHMENTS"; attachments: QAAttachmentRef[] }
  | { type: "REVIEW_REPORTS"; reports: ReviewReport[] }
  | { type: "REVIEW_FINDINGS"; findings: ReviewFinding[] }
  | { type: "WORK_ITEMS"; workItems: WorkItem[] }
  | { type: "EVENTS"; events: DomainEvent[]; nextSequence: number; hasMore: boolean }
  | { type: "CONTEXT_SOURCES"; sources: ContextSources }
  | {
      type: "PROVIDER_SESSIONS";
      sessions: ProviderSession[];
      recipes: ContextPackRecipe[];
      checkpoints: Checkpoint[];
      usageReports: ProviderUsageReport[];
      // Spec §6.2: the highest window occupancy each session has been observed at, read from the
      // session's own columns (migration 0009) rather than replayed out of the audit log. The peak
      // rather than the current reading -- it is what "how full did this session get" asks, and it
      // is what survives a provider that compacts its own window. Keyed by ProviderSession id; a
      // session never measured has no entry, which is a different fact from one measured at zero.
      //
      // One state where "peak" is imprecise, and deliberately so: once a session has asked to wind
      // down, apps/daemon stops reporting (`live.handoffRequested`) and this command refuses a
      // later report anyway, so occupancy that keeps climbing after the threshold never reaches
      // here. The field then holds the reading AT HANDOFF, which is a floor on the true peak
      // rather than the peak itself. Nothing user-visible lies -- the cockpit labels exactly that
      // session "N% of the window at handoff" and never the peak wording -- but a reader reaching
      // for a true high-water mark should know this is where it stops being one.
      peakContextWindowUsage: Record<string, ContextWindowUsage>;
    }
  | { type: "WORKSPACE"; workspace: WorkItemWorkspace | null };

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
  | "project"
  | "projectScaffold"
  | "workItem"
  | "event"
  | "pipelineRun"
  | "stageAttempt"
  | "workflowDispatch"
  | "humanRequest"
  | "humanRequestOption"
  | "decision"
  | "budgetPolicy"
  | "usageRecord"
  | "recoveryReport"
  | "evidenceArtifact"
  | "acceptancePackage"
  | "providerSession"
  | "providerUsageReport"
  | "squadAssignment"
  | "agentRun"
  | "qaRun"
  | "qaEvidenceBundle"
  | "qaAttachment"
  | "qaDefect"
  | "qaCorrectionRun"
  | "qaRetestPlan"
  | "reviewReport"
  | "reviewFinding"
  | "contextPackRecipe"
  | "checkpoint"
  | "workItemWorkspace"
  | "constitutionProposal"
  | "projectConstitutionVersion"
  | "constitutionPublication"
  | "verificationPlan"
  | "verificationPlanPublication"
  | "verificationRun"
  | "verificationCheck"
  | "verificationFailure"
  | "verificationCorrectionRun"
  | "projectReadinessRun"
  | "readinessCheck"
  | "securityFinding"
  | "readinessAttestation"
  | "mcpProfile"
  | "mcpProfileRevision"
  | "mcpConsent"
  | "mcpCapabilitySnapshot"
  | "mcpGrant"
  | "mcpSessionSnapshot"
  | "mcpToolCall";

/**
 * What startup reconciliation did about the process an orphaned ProviderSession left behind.
 *
 * A SIGKILL to a process on the owner's machine used to leave no record anywhere that it happened.
 * This is that record. `action: "SKIPPED"` is reported just as loudly as a kill, because "an orphan
 * is still running and Loomrail chose not to signal it" is a fact the owner has to be able to find.
 */
export type OrphanProcessEvent = {
  pid: number;
  sessionId: string;
  /**
   * `KILLED` is reported only once the signal was actually delivered, never on the intention to
   * send it: the identity probe between the liveness check and the signal is a real window, and a
   * kill that threw inside it used to be logged as a kill that happened.
   */
  action: "KILLED" | "SKIPPED" | "FAILED";
  reason:
    /** The pid is not alive at all; there was nothing to signal. */
    | "ALREADY_GONE"
    /** The process started no later than its session did, so it is plausibly the one we recorded. */
    | "IDENTITY_CONFIRMED"
    /** The probe could not say when the process started, so the kill was not attempted. */
    | "START_TIME_UNKNOWN"
    /** The process started after its session did: the pid was reused, and this is not our child. */
    | "STARTED_AFTER_SESSION"
    /** The process exited between the liveness check and the signal (ESRCH). Nothing was killed. */
    | "VANISHED_BEFORE_SIGNAL"
    /**
     * The kernel refused the signal for some other reason -- EPERM above all, which means the pid
     * now belongs to a process this daemon may not signal, i.e. the identity guard was wrong.
     */
    | "SIGNAL_REFUSED"
    /** The probe itself threw. Nothing was killed, and the failure was contained here. */
    | "PROBE_FAILED";
};

/**
 * What startup reconciliation did about a READY WorkItemWorkspace whose worktree directory it
 * checked (spec §6, "Восстановление").
 *
 * Only the two outcomes worth an owner's attention are reported: the workspace was found gone and
 * moved to ORPHANED, or the check itself could not be completed at all. A workspace found present
 * and not `prunable` -- the ordinary case for the large majority of workspaces at any given restart
 * -- is not reported; that silence is the point of `killOrphanedSessionProcess`'s "every ending is a
 * line the owner can find" only for endings that actually happened, not for a health check that
 * found nothing wrong.
 */
export type OrphanWorkspaceEvent = {
  workspaceId: string;
  workItemId: string;
  worktreePath: string;
  action: "ORPHANED" | "SKIPPED";
  reason:
    /** `git worktree list --porcelain` reported this path prunable: its gitdir points nowhere. */
    | "PRUNABLE"
    /** No entry for this path at all -- the administrative record itself is gone, not just the
     * directory. Treated the same as PRUNABLE (spec §6: "prunable, or gone outside Loomrail's
     * control"), because both mean the worktree cannot be written to any more. */
    | "MISSING_FROM_WORKTREE_LIST"
    /** The workspace's own Project row is gone, so there is no repository to ask `git` about. */
    | "PROJECT_NOT_FOUND"
    /** `git worktree list` itself could not be run or its output could not be read -- a missing
     * `git`, a repository path that no longer resolves, a permissions problem. FAIL SAFE: an
     * inconclusive check never orphans a workspace that might still be perfectly healthy. */
    | "WORKTREE_LIST_FAILED";
};

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
  /**
   * Test-only transaction probe called after a provider allowance snapshot row is written and
   * before its audit Event and command receipt are appended. Throwing here must roll back all
   * three durable effects; production never supplies it.
   */
  onProviderAllowanceSnapshotPersisted?: () => void;
  /**
   * Called synchronously, once per orphaned ProviderSession that carries a pid, at the moment
   * reconciliation decides what to do about that process -- BEFORE the session row is marked ENDED.
   * Injected the way `now` and `createId` are, so the daemon can route it into its own structured
   * logger; the default writes one line to stderr, because a kill that nothing recorded is the
   * defect this exists to close and an uninjected caller must not silently reopen it.
   */
  onOrphanProcess?: (event: OrphanProcessEvent) => void;
  /**
   * When the process with this pid started, or `null` if that cannot be determined. Injected only
   * so a test can drive both sides of the pid-reuse guard deterministically; production uses the
   * default synchronous OS probe (`ps` on POSIX, Win32_Process through PowerShell on Windows).
   */
  processStartedAt?: (pid: number) => Date | null;
  /**
   * Sends the final forceful signal after the liveness and pid-identity guards pass. Test-only:
   * production uses `process.kill`; injection lets the vanished-between-probe-and-signal race be
   * verified deterministically on every supported OS.
   */
  signalProcess?: (pid: number, signal: "SIGKILL") => void;
  /**
   * Called synchronously, once per READY WorkItemWorkspace found gone or found un-checkable, at
   * the moment startup reconciliation decides what to do about it. Injected the way `onOrphanProcess`
   * is, so the daemon can route it into its own structured logger; the default writes one line to
   * stderr.
   */
  onOrphanWorkspace?: (event: OrphanWorkspaceEvent) => void;
  /**
   * Lists a repository's worktrees the way `@loomrail/workspace`'s `listWorktrees` does -- same
   * entries, same `prunable` signal -- but synchronously, and returning `null` (never throwing)
   * when the listing could not be produced at all. Synchronous because `execute` runs its whole
   * transaction, RECONCILE_WORKFLOWS included, without ever awaiting anything; `null` rather than a
   * thrown error because the caller's only correct response to "the check failed" and "the
   * repository looks empty" must never be the same code path as a genuine empty answer. Injected
   * only so a test can drive the probe deterministically; production runs `git worktree list
   * --porcelain` with `execFileSync` and parses it with the same parser `listWorktrees` uses.
   */
  listProjectWorktrees?: (topLevel: string) => readonly WorktreeEntry[] | null;
};
