import type {
  AgentRun,
  ProviderSession,
  StageAttempt,
  WorkspaceToolCallRecord,
  WorkspaceToolTerminalOutcome,
} from "@loomrail/contracts";

export type WorkspaceToolDomainErrorCode =
  | "PROVIDER_SESSION_NOT_RUNNING"
  | "AGENT_RUN_NOT_RUNNING"
  | "WORKSPACE_ACCESS_DENIED"
  | "TOOL_CALL_ID_REUSED"
  | "TOOL_CALL_NOT_STARTED"
  | "TOOL_CALL_OUTCOME_CONFLICT";

export class WorkspaceToolDomainError extends Error {
  readonly code: WorkspaceToolDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkspaceToolDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "WorkspaceToolDomainError";
    this.code = code;
    this.details = details;
  }
}

type StartInput = {
  now: string;
  newCallId: string;
  providerCallKey: string;
  operation: WorkspaceToolCallRecord["operation"];
  target: string;
  policyDigest: string;
  inputDigest: string;
  providerSession: ProviderSession;
  agentRun: AgentRun;
  stageAttempt: StageAttempt;
  existing?: WorkspaceToolCallRecord;
};

const startIdentityMatches = (call: WorkspaceToolCallRecord, input: StartInput): boolean =>
  call.providerSessionId === input.providerSession.id &&
  call.providerCallKey === input.providerCallKey &&
  call.operation === input.operation &&
  call.target === input.target &&
  call.policyDigest === input.policyDigest &&
  call.inputDigest === input.inputDigest;

export const decideWorkspaceToolCallStart = (input: StartInput): WorkspaceToolCallRecord => {
  if (input.existing !== undefined) {
    if (!startIdentityMatches(input.existing, input)) {
      throw new WorkspaceToolDomainError(
        "TOOL_CALL_ID_REUSED",
        "The provider reused a workspace tool call identifier with different input",
      );
    }
    return input.existing;
  }
  if (input.providerSession.status !== "RUNNING") {
    throw new WorkspaceToolDomainError(
      "PROVIDER_SESSION_NOT_RUNNING",
      "A workspace tool call requires a running ProviderSession",
    );
  }
  if (
    input.agentRun.status !== "RUNNING" ||
    input.providerSession.agentRunId !== input.agentRun.id ||
    input.agentRun.stageAttemptId !== input.stageAttempt.id ||
    input.providerSession.stageAttemptId !== input.stageAttempt.id
  ) {
    throw new WorkspaceToolDomainError(
      "AGENT_RUN_NOT_RUNNING",
      "A workspace tool call requires the active AgentRun that owns the ProviderSession",
    );
  }
  // Reserve first even when the executor will deny the operation. The effective access decision
  // still comes from this AgentRun's immutable policy snapshot, but a refusal is itself a durable
  // security fact and therefore needs a STARTED -> DENIED audit transition.
  return {
    schemaVersion: 1,
    id: input.newCallId,
    projectId: input.agentRun.projectId,
    workItemId: input.agentRun.workItemId,
    stageAttemptId: input.stageAttempt.id,
    agentRunId: input.agentRun.id,
    providerSessionId: input.providerSession.id,
    providerCallKey: input.providerCallKey,
    operation: input.operation,
    target: input.target,
    policyDigest: input.policyDigest,
    inputDigest: input.inputDigest,
    status: "STARTED",
    failureCode: null,
    outputDigest: null,
    outputBytes: null,
    exitCode: null,
    startedAt: input.now,
    finishedAt: null,
  };
};

const outcomeMatches = (call: WorkspaceToolCallRecord, outcome: WorkspaceToolTerminalOutcome): boolean =>
  call.status === outcome.status &&
  call.failureCode === (outcome.status === "SUCCEEDED" ? null : outcome.failureCode) &&
  call.outputDigest === outcome.outputDigest &&
  call.outputBytes === outcome.outputBytes &&
  call.exitCode === outcome.exitCode;

export const decideWorkspaceToolCallFinish = (
  current: WorkspaceToolCallRecord,
  outcome: WorkspaceToolTerminalOutcome,
  now: string,
): WorkspaceToolCallRecord => {
  if (current.status !== "STARTED") {
    if (outcomeMatches(current, outcome)) return current;
    throw new WorkspaceToolDomainError(
      "TOOL_CALL_OUTCOME_CONFLICT",
      "The workspace tool call already has a different terminal outcome",
    );
  }
  return {
    ...current,
    status: outcome.status,
    failureCode: outcome.status === "SUCCEEDED" ? null : outcome.failureCode,
    outputDigest: outcome.outputDigest,
    outputBytes: outcome.outputBytes,
    exitCode: outcome.exitCode,
    finishedAt: now,
  };
};

export const interruptWorkspaceToolCall = (
  current: WorkspaceToolCallRecord,
  now: string,
): WorkspaceToolCallRecord => {
  if (current.status !== "STARTED") return current;
  return decideWorkspaceToolCallFinish(
    current,
    {
      status: "UNKNOWN_OUTCOME",
      failureCode: "DAEMON_RESTART",
      outputDigest: null,
      outputBytes: null,
      exitCode: null,
    },
    now,
  );
};
