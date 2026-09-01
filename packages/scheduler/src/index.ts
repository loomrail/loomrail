import { providerIdSchema, type ProviderId, type WorkItem } from "@loomrail/contracts";

export const DEFAULT_GLOBAL_CONCURRENCY = 3;
export const DEFAULT_PROJECT_CONCURRENCY = 3;
export const DEFAULT_PROVIDER_CONCURRENCY = 3;
export const MAX_SCHEDULER_CANDIDATES = 200;
export const MAX_SCHEDULER_ACTIVE_RUNS = 200;
export const MAX_CONCURRENCY_LIMIT = 32;

export type SchedulerWorkspaceClaim =
  | { type: "NONE" }
  | {
      type: "WORKSPACE";
      workspaceId: string;
      access: "READ_ONLY" | "READ_WRITE";
      checkpoint: string | null;
    };

export type SchedulerCandidate = {
  dispatchId: string;
  stageAttemptId: string;
  projectId: string;
  provider: ProviderId;
  priority: WorkItem["priority"];
  createdAt: string;
  ready: boolean;
  budgetAllowed: boolean;
  requiresStableCheckpoint: boolean;
  workspace: SchedulerWorkspaceClaim;
};

export type ActiveAgentRun = {
  agentRunId: string;
  stageAttemptId: string;
  projectId: string;
  provider: ProviderId;
  workspace: SchedulerWorkspaceClaim;
};

export type SchedulerLimits = {
  global?: number;
  defaultProject?: number;
  defaultProvider?: number;
  projects?: Readonly<Record<string, number>>;
  providers?: Readonly<Partial<Record<ProviderId, number>>>;
};

export type ValidatedSchedulerLimits = {
  global: number;
  defaultProject: number;
  defaultProvider: number;
  projects: Readonly<Record<string, number>>;
  providers: Readonly<Partial<Record<ProviderId, number>>>;
};

export type AgentRunClaimLimits = {
  global: number;
  project: number;
  provider: number;
};

export type DispatchDeferralReason =
  | "NOT_READY"
  | "BUDGET_BLOCKED"
  | "CHECKPOINT_NOT_STABLE"
  | "ATTEMPT_ACTIVE"
  | "GLOBAL_LIMIT"
  | "PROJECT_LIMIT"
  | "PROVIDER_LIMIT"
  | "WORKSPACE_CONFLICT";

export type DispatchDeferral = {
  dispatchId: string;
  reason: DispatchDeferralReason;
};

export type DispatchBatchPlan = {
  selectedDispatchIds: string[];
  deferred: DispatchDeferral[];
};

export type DispatchBatchInput = {
  candidates: readonly SchedulerCandidate[];
  activeRuns: readonly ActiveAgentRun[];
  limits?: SchedulerLimits;
};

export type SchedulerPlanningErrorCode =
  | "INPUT_TOO_LARGE"
  | "DUPLICATE_CANDIDATE"
  | "DUPLICATE_ACTIVE_RUN"
  | "DUPLICATE_STAGE_ATTEMPT"
  | "INVALID_LIMIT";

export class SchedulerPlanningError extends Error {
  readonly code: SchedulerPlanningErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: SchedulerPlanningErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "SchedulerPlanningError";
    this.code = code;
    this.details = details;
  }
}

const priorityOrder: Readonly<Record<WorkItem["priority"], number>> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const assertBounded = (actual: number, maximum: number, collection: string): void => {
  if (actual > maximum) {
    throw new SchedulerPlanningError("INPUT_TOO_LARGE", `The scheduler ${collection} input is not bounded`, {
      actual,
      maximum,
    });
  }
};

const assertUnique = <T>(
  values: readonly T[],
  key: (value: T) => string,
  code: "DUPLICATE_CANDIDATE" | "DUPLICATE_ACTIVE_RUN" | "DUPLICATE_STAGE_ATTEMPT",
  label: string,
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) {
      throw new SchedulerPlanningError(code, `The scheduler received a duplicate ${label}`, { id });
    }
    seen.add(id);
  }
};

const validateLimit = (value: number, scope: string): number => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CONCURRENCY_LIMIT) {
    throw new SchedulerPlanningError("INVALID_LIMIT", "A scheduler concurrency limit is invalid", {
      scope,
      value,
    });
  }
  return value;
};

/**
 * Validates owner-supplied limits once at the daemon boundary and fills every default explicitly.
 * The returned value is safe to reuse for planning and for each transactional AgentRun claim.
 */
export const validateSchedulerLimits = (limits: SchedulerLimits = {}): ValidatedSchedulerLimits => {
  const projects: Record<string, number> = {};
  for (const [projectId, limit] of Object.entries(limits.projects ?? {})) {
    projects[projectId] = validateLimit(limit, `project:${projectId}`);
  }
  const providers: Partial<Record<ProviderId, number>> = {};
  for (const [provider, limit] of Object.entries(limits.providers ?? {})) {
    const parsedProvider = providerIdSchema.safeParse(provider);
    if (!parsedProvider.success) {
      throw new SchedulerPlanningError("INVALID_LIMIT", "A scheduler provider limit has an unknown scope", {
        scope: `provider:${provider}`,
      });
    }
    providers[parsedProvider.data] = validateLimit(limit, `provider:${provider}`);
  }
  return {
    global: validateLimit(limits.global ?? DEFAULT_GLOBAL_CONCURRENCY, "global"),
    defaultProject: validateLimit(limits.defaultProject ?? DEFAULT_PROJECT_CONCURRENCY, "project:default"),
    defaultProvider: validateLimit(
      limits.defaultProvider ?? DEFAULT_PROVIDER_CONCURRENCY,
      "provider:default",
    ),
    projects,
    providers,
  };
};

export const agentRunClaimLimits = (
  limits: ValidatedSchedulerLimits,
  projectId: string,
  provider: ProviderId,
): AgentRunClaimLimits => ({
  global: limits.global,
  project: limits.projects[projectId] ?? limits.defaultProject,
  provider: limits.providers[provider] ?? limits.defaultProvider,
});

const increment = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const workspaceClaimsConflict = (left: SchedulerWorkspaceClaim, right: SchedulerWorkspaceClaim): boolean => {
  if (left.type === "NONE" || right.type === "NONE" || left.workspaceId !== right.workspaceId) return false;
  if (left.access === "READ_WRITE" || right.access === "READ_WRITE") return true;
  return left.checkpoint === null || right.checkpoint === null || left.checkpoint !== right.checkpoint;
};

const compareCandidates = (left: SchedulerCandidate, right: SchedulerCandidate): number =>
  priorityOrder[left.priority] - priorityOrder[right.priority] ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.dispatchId.localeCompare(right.dispatchId);

/**
 * Plans a bounded scheduling batch without mutating workflow state.
 *
 * The result is deliberately advisory: persistence must repeat capacity and lease checks when it
 * atomically claims an AgentRun. Keeping ordering and explanations here still removes them from
 * the daemon loop, while the transaction remains the authority against concurrent wakes.
 */
export const planDispatchBatch = (input: DispatchBatchInput): DispatchBatchPlan => {
  assertBounded(input.candidates.length, MAX_SCHEDULER_CANDIDATES, "candidate");
  assertBounded(input.activeRuns.length, MAX_SCHEDULER_ACTIVE_RUNS, "active-run");
  assertUnique(input.candidates, ({ dispatchId }) => dispatchId, "DUPLICATE_CANDIDATE", "dispatch");
  assertUnique(input.activeRuns, ({ agentRunId }) => agentRunId, "DUPLICATE_ACTIVE_RUN", "AgentRun");
  assertUnique(
    input.candidates,
    ({ stageAttemptId }) => stageAttemptId,
    "DUPLICATE_STAGE_ATTEMPT",
    "candidate StageAttempt",
  );
  assertUnique(
    input.activeRuns,
    ({ stageAttemptId }) => stageAttemptId,
    "DUPLICATE_STAGE_ATTEMPT",
    "active StageAttempt",
  );

  const limits = validateSchedulerLimits(input.limits);

  const activeAttempts = new Set(input.activeRuns.map(({ stageAttemptId }) => stageAttemptId));
  const projectCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const workspaceClaims = input.activeRuns.map(({ workspace }) => workspace);
  for (const run of input.activeRuns) {
    increment(projectCounts, run.projectId);
    increment(providerCounts, run.provider);
  }

  let activeCount = input.activeRuns.length;
  const selectedDispatchIds: string[] = [];
  const deferred: DispatchDeferral[] = [];
  const defer = (dispatchId: string, reason: DispatchDeferralReason): void => {
    deferred.push({ dispatchId, reason });
  };

  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    if (!candidate.ready) {
      defer(candidate.dispatchId, "NOT_READY");
      continue;
    }
    if (!candidate.budgetAllowed) {
      defer(candidate.dispatchId, "BUDGET_BLOCKED");
      continue;
    }
    if (
      candidate.requiresStableCheckpoint &&
      (candidate.workspace.type !== "WORKSPACE" || candidate.workspace.checkpoint === null)
    ) {
      defer(candidate.dispatchId, "CHECKPOINT_NOT_STABLE");
      continue;
    }
    if (activeAttempts.has(candidate.stageAttemptId)) {
      defer(candidate.dispatchId, "ATTEMPT_ACTIVE");
      continue;
    }
    if (activeCount >= limits.global) {
      defer(candidate.dispatchId, "GLOBAL_LIMIT");
      continue;
    }

    const projectLimit = limits.projects[candidate.projectId] ?? limits.defaultProject;
    if ((projectCounts.get(candidate.projectId) ?? 0) >= projectLimit) {
      defer(candidate.dispatchId, "PROJECT_LIMIT");
      continue;
    }

    const providerLimit = limits.providers[candidate.provider] ?? limits.defaultProvider;
    if ((providerCounts.get(candidate.provider) ?? 0) >= providerLimit) {
      defer(candidate.dispatchId, "PROVIDER_LIMIT");
      continue;
    }

    if (workspaceClaims.some((claim) => workspaceClaimsConflict(candidate.workspace, claim))) {
      defer(candidate.dispatchId, "WORKSPACE_CONFLICT");
      continue;
    }

    selectedDispatchIds.push(candidate.dispatchId);
    activeAttempts.add(candidate.stageAttemptId);
    activeCount += 1;
    increment(projectCounts, candidate.projectId);
    increment(providerCounts, candidate.provider);
    workspaceClaims.push(candidate.workspace);
  }

  return { selectedDispatchIds, deferred };
};
