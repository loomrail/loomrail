import {
  attentionInboxResponseSchema,
  agentFleetResponseSchema,
  apiErrorResponseSchema,
  constitutionPresetsResponseSchema,
  eventsResponseSchema,
  humanRequestsResponseSchema,
  insightsResponseSchema,
  mcpProfileProposalSchema,
  mcpProfilesResponseSchema,
  projectsResponseSchema,
  projectProviderAllowanceResponseSchema,
  projectProviderSelectionResponseSchema,
  providerCapabilitiesResponseSchema,
  providerSessionsResponseSchema,
  qaDefectWaivedResultSchema,
  qaCorrectionGateResolvedResultSchema,
  qaStateResponseSchema,
  projectConstitutionSnapshotSchema,
  projectReadinessSnapshotSchema,
  reviewFindingDisposedResultSchema,
  reviewStateResponseSchema,
  proposeProjectScaffoldResponseSchema,
  scaffoldOperationResponseSchema,
  scaffoldOperationsResponseSchema,
  stateCommandResultSchema,
  workItemChangesResponseSchema,
  workItemFileDiffResponseSchema,
  workItemsResponseSchema,
  workItemWorkspaceResponseSchema,
  workflowSnapshotSchema,
  verificationPlanSettingsResponseSchema,
  verificationRunSnapshotResponseSchema,
  verificationRunsResponseSchema,
  guidedActivationContract,
  type FixtureProjectId,
  type AcceptanceAction,
  type AcceptancePackage,
  type HumanRequest,
  type HumanRequestAnswer,
  type McpProfileCandidate,
  type McpProfileProposal,
  type McpProfileRevision,
  type ModelTier,
  type ConstitutionPresetId,
  type ConstitutionProposal,
  type ConstitutionPublication,
  type ListedProject,
  type ProjectReadinessRun,
  type QADefect,
  type QACorrectionGateAction,
  type QACorrectionRun,
  type ScaffoldOperation,
  type ScaffoldProposal,
  type ProviderPreference,
  type ReadinessAttestationOutcome,
  type ReadinessCheck,
  type ReviewFinding,
  type ReviewFindingOwnerDisposition,
  type PipelineRun,
  type WorkItem,
  type WorkItemState,
  type VerificationPlanPublication,
  type VerificationPlanSettingsResponse,
  type VerificationPlan,
  type VerificationRun,
  type VerificationRunSnapshotResponse,
} from "@loomrail/contracts";

type RuntimeSchema<T> = {
  parse: (value: unknown) => T;
};

const CSRF_STORAGE_KEY = "loomrail.csrf-token";

export type LocalApiRecovery = "none" | "reopen" | "retry";

type LocalApiErrorOptions = {
  code: string;
  correlationId?: string;
  message: string;
  recovery: LocalApiRecovery;
  status: number;
};

export class LocalApiError extends Error {
  readonly code: string;
  readonly correlationId: string | undefined;
  readonly recovery: LocalApiRecovery;
  readonly status: number;

  constructor({ code, correlationId, message, recovery, status }: LocalApiErrorOptions) {
    super(message);
    this.name = "LocalApiError";
    this.code = code;
    this.correlationId = correlationId;
    this.recovery = recovery;
    this.status = status;
  }
}

const recoveryFor = (code: string, status: number): LocalApiRecovery => {
  if (["BOOTSTRAP_REJECTED", "CSRF_REJECTED", "SESSION_REQUIRED"].includes(code)) return "reopen";
  return status === 0 || status >= 500 ? "retry" : "none";
};

export const readLocalApiError = async (response: Response): Promise<LocalApiError> => {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new LocalApiError({
      code: parsed.data.error.code,
      correlationId: parsed.data.error.correlationId,
      message: parsed.data.error.message,
      recovery: recoveryFor(parsed.data.error.code, response.status),
      status: response.status,
    });
  }
  return new LocalApiError({
    code: "LOCAL_API_ERROR",
    message: `Local daemon returned HTTP ${response.status.toString()}`,
    recovery: recoveryFor("LOCAL_API_ERROR", response.status),
    status: response.status,
  });
};

export const isLocalApiError = (error: unknown): error is LocalApiError => error instanceof LocalApiError;

export const createDaemonUnavailableError = (): LocalApiError =>
  new LocalApiError({
    code: "LOCAL_DAEMON_UNAVAILABLE",
    message: "The local Loomrail daemon could not be reached",
    recovery: "retry",
    status: 0,
  });

const readCsrfToken = (): string | undefined => window.sessionStorage.getItem(CSRF_STORAGE_KEY) ?? undefined;

export const storeCsrfToken = (csrfToken: string): void => {
  window.sessionStorage.setItem(CSRF_STORAGE_KEY, csrfToken);
};

const fetchLocalApi = async (
  path: string,
  init: RequestInit = {},
  accept = "application/json",
): Promise<Response> => {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", accept);

  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCsrfToken();
    if (!csrfToken) {
      throw new LocalApiError({
        code: "LOCAL_SESSION_REQUIRED",
        message: "The local session must be reopened before changing data",
        recovery: "reopen",
        status: 0,
      });
    }
    headers.set("x-loomrail-csrf", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw createDaemonUnavailableError();
  }

  if (!response.ok) {
    throw await readLocalApiError(response);
  }

  return response;
};

export const requestLocalApi = async <T>(
  path: string,
  schema: RuntimeSchema<T>,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetchLocalApi(path, init);

  return schema.parse(await response.json());
};

export const listProjects = async () => requestLocalApi("/api/v1/projects", projectsResponseSchema);

export const getInsights = async () => requestLocalApi("/api/v1/insights", insightsResponseSchema);

export const listConstitutionPresets = async () =>
  requestLocalApi("/api/v1/constitution-presets", constitutionPresetsResponseSchema);

export const getProjectConstitution = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/constitution`,
    projectConstitutionSnapshotSchema,
  );

export const scanProjectConstitution = async (
  project: ListedProject,
  presetId?: ConstitutionPresetId,
): Promise<ConstitutionProposal> => {
  const result = await requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(project.id)}/constitution/scan`,
    stateCommandResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: project.version,
        ...(presetId === undefined ? {} : { presetId }),
      }),
    },
  );
  if (result.type !== "PROJECT_CONSTITUTION_PROPOSED") {
    throw new Error("The local daemon returned an unexpected Constitution Proposal result");
  }
  return result.proposal;
};

export const adoptProjectConstitution = async (project: ListedProject, proposal: ConstitutionProposal) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(project.id)}/constitution/adopt`,
    projectConstitutionSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        proposalId: proposal.id,
        expectedProjectVersion: project.version,
        expectedProposalVersion: proposal.version,
      }),
    },
  );

export const retryProjectConstitutionPublication = async (
  projectId: string,
  publication: ConstitutionPublication,
) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/constitution/publication/retry`,
    projectConstitutionSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        publicationId: publication.id,
        expectedVersion: publication.version,
      }),
    },
  );

export const getVerificationPlanSettings = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/verification-plan`,
    verificationPlanSettingsResponseSchema,
  );

export const adoptVerificationPlan = async (settings: VerificationPlanSettingsResponse) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(settings.projectId)}/verification-plan/adopt`,
    verificationPlanSettingsResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: settings.projectVersion,
        proposalHash: settings.proposal.proposalHash,
      }),
    },
  );

export const retryVerificationPlanPublication = async (
  projectId: string,
  publication: VerificationPlanPublication,
) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/verification-plan/publication/retry`,
    verificationPlanSettingsResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        publicationId: publication.id,
        expectedVersion: publication.version,
      }),
    },
  );

export const getProjectReadiness = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/readiness`,
    projectReadinessSnapshotSchema,
  );

export const runProjectReadiness = async (project: ListedProject) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(project.id)}/readiness/run`,
    projectReadinessSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: project.version,
      }),
    },
  );

export const attestProjectReadiness = async (
  projectId: string,
  run: ProjectReadinessRun,
  check: ReadinessCheck,
  outcome: ReadinessAttestationOutcome,
  rationale: string,
) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/readiness/attest`,
    projectReadinessSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        runId: run.id,
        checkId: check.id,
        expectedRunVersion: run.version,
        outcome,
        rationale,
      }),
    },
  );

export const listProjectWorkItems = async (projectId: string) =>
  requestLocalApi(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items`, workItemsResponseSchema);

export const activityPageSize = 30;

/** Reads one page of an item's activity newest first; `before` continues from a page's `nextSequence`. */
export const listWorkItemEvents = async (projectId: string, workItemId: string, before?: number) => {
  const query = new URLSearchParams({
    aggregateId: workItemId,
    limit: activityPageSize.toString(),
    order: "DESC",
    projectId,
    ...(before === undefined ? {} : { before: before.toString() }),
  });
  return requestLocalApi(`/api/v1/events?${query.toString()}`, eventsResponseSchema);
};

export const getWorkItemWorkflow = async (workItemId: string) =>
  requestLocalApi(`/api/v1/work-items/${encodeURIComponent(workItemId)}/workflow`, workflowSnapshotSchema);

export const listWorkItemVerificationRuns = async (workItemId: string) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/verification-runs`,
    verificationRunsResponseSchema,
  );

export const startWorkItemVerificationRun = async (input: {
  workItem: WorkItem;
  plan: VerificationPlan;
  retryOf?: VerificationRun;
}): Promise<VerificationRunSnapshotResponse> =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(input.workItem.id)}/verification-runs`,
    verificationRunSnapshotResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedWorkItemVersion: input.workItem.version,
        expectedPlanRevision: input.plan.revision,
        expectedPlanContentHash: input.plan.contentHash,
        ...(input.retryOf === undefined
          ? {}
          : {
              retryOfRunId: input.retryOf.id,
              expectedRetryOfRunVersion: input.retryOf.version,
            }),
      }),
    },
  );

export const cancelVerificationRun = async (run: VerificationRun): Promise<VerificationRunSnapshotResponse> =>
  requestLocalApi(
    `/api/v1/verification-runs/${encodeURIComponent(run.id)}/cancel`,
    verificationRunSnapshotResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: run.version,
      }),
    },
  );

export const getVerificationCheckOutput = async (checkId: string): Promise<string> =>
  (
    await fetchLocalApi(`/api/v1/verification-checks/${encodeURIComponent(checkId)}/output`, {}, "text/plain")
  ).text();

/** Where this work item's agent writes (spec §4): repository branch, base commit and worktree path. */
export const getWorkItemWorkspace = async (workItemId: string) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/workspace`,
    workItemWorkspaceResponseSchema,
  );

/**
 * What this work item's agent changed in its worktree (spec E1.5 §5): one record per file, with
 * status and line counts, and the flag saying whether the list itself was cut.
 *
 * Answers `changes: null` -- with 200 -- for a work item that has no workspace, which is the
 * ordinary state of every prose-only stage rather than a failure, exactly as `getWorkItemWorkspace`
 * above answers `workspace: null` for the same condition.
 */
export const getWorkItemChanges = async (workItemId: string) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/changes`,
    workItemChangesResponseSchema,
  );

/**
 * The unified diff of ONE file in that worktree.
 *
 * A second call rather than a field on the summary above, because spec D5 makes them two handles on
 * purpose: the summary is cheap and reread while a stage runs, a body is expensive and wanted only
 * for the file the owner expanded. A client that fetched every body to render a list would undo
 * that split at the one layer it is visible from.
 *
 * The path is a value read out of the summary and sent back, so it is encoded rather than
 * interpolated: a changed path may legally contain `&`, `#`, `+` or a space, and any of those
 * unencoded would arrive at the daemon as a different path -- or as a second query parameter.
 */
export const getWorkItemFileDiff = async (workItemId: string, path: string) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/changes/diff?path=${encodeURIComponent(path)}`,
    workItemFileDiffResponseSchema,
  );

export const listProviderSessions = async (stageAttemptId: string) =>
  requestLocalApi(
    `/api/v1/stage-attempts/${encodeURIComponent(stageAttemptId)}/sessions`,
    providerSessionsResponseSchema,
  );

export const getProviderCapabilities = async () =>
  requestLocalApi("/api/v1/provider/capabilities", providerCapabilitiesResponseSchema);

export const getProjectProviderSelection = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/provider-selection`,
    projectProviderSelectionResponseSchema,
  );

export const setProjectProviderPreference = async (project: ListedProject, preference: ProviderPreference) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(project.id)}/provider-selection`,
    projectProviderSelectionResponseSchema,
    {
      method: "PUT",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: project.version,
        preference,
      }),
    },
  );

export const refreshProjectProviderAvailability = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/provider-selection/refresh`,
    projectProviderSelectionResponseSchema,
    { method: "POST", body: JSON.stringify({ schemaVersion: 1 }) },
  );

export const getProjectProviderAllowance = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/provider/allowance?projectId=${encodeURIComponent(projectId)}`,
    projectProviderAllowanceResponseSchema,
  );

export const refreshProjectProviderAllowance = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/provider-allowance/refresh`,
    projectProviderAllowanceResponseSchema,
    { method: "POST", body: JSON.stringify({ schemaVersion: 1 }) },
  );

export const getProjectMcpProfiles = async (projectId: string) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/mcp-profiles`,
    mcpProfilesResponseSchema,
  );

export const proposeMcpProfile = async (
  projectId: string,
  expectedProjectVersion: number,
  candidate: McpProfileCandidate,
) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/mcp-profile-proposals`,
    mcpProfileProposalSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        expectedProjectVersion,
        candidate,
      }),
    },
  );

export const proposeContext7Preset = async (projectId: string, expectedProjectVersion: number) =>
  requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/mcp-presets/context7/proposal`,
    mcpProfileProposalSchema,
    {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, expectedProjectVersion }),
    },
  );

export const confirmMcpProfile = async (proposal: McpProfileProposal) => {
  const result = await requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(proposal.projectId)}/mcp-profile-proposals/${encodeURIComponent(proposal.challengeId)}/confirm`,
    stateCommandResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: proposal.expectedProjectVersion,
        challengeId: proposal.challengeId,
        canonicalDigest: proposal.canonicalDigest,
      }),
    },
  );
  if (result.type !== "MCP_PROFILE_CONSENTED") {
    throw new Error("The local daemon returned an unexpected MCP consent result");
  }
  return result;
};

export const probeMcpProfile = async (projectId: string, revision: McpProfileRevision) => {
  const result = await requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(projectId)}/mcp-profiles/${encodeURIComponent(revision.id)}/probe`,
    stateCommandResultSchema,
    {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID() }),
    },
  );
  if (result.type !== "MCP_CAPABILITY_RECORDED") {
    throw new Error("The local daemon returned an unexpected MCP probe result");
  }
  return result.snapshot;
};

export const grantMcpProfile = async (input: {
  projectId: string;
  expectedProjectVersion: number;
  revision: McpProfileRevision;
  expectedGrantVersion: number | null;
  tools: string[];
}) => {
  const result = await requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(input.projectId)}/mcp-profiles/${encodeURIComponent(input.revision.id)}/grant`,
    stateCommandResultSchema,
    {
      method: "PUT",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: input.expectedProjectVersion,
        expectedGrantVersion: input.expectedGrantVersion,
        tools: input.tools,
        ownerAttestsReadOnly: true,
      }),
    },
  );
  if (result.type !== "MCP_GRANT_CHANGED") {
    throw new Error("The local daemon returned an unexpected MCP grant result");
  }
  return result;
};

export const revokeMcpProfile = async (input: {
  projectId: string;
  expectedProjectVersion: number;
  revision: McpProfileRevision;
  expectedGrantVersion: number;
}) => {
  const result = await requestLocalApi(
    `/api/v1/projects/${encodeURIComponent(input.projectId)}/mcp-profiles/${encodeURIComponent(input.revision.id)}/grant`,
    stateCommandResultSchema,
    {
      method: "DELETE",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedProjectVersion: input.expectedProjectVersion,
        expectedGrantVersion: input.expectedGrantVersion,
      }),
    },
  );
  if (result.type !== "MCP_GRANT_CHANGED") {
    throw new Error("The local daemon returned an unexpected MCP revoke result");
  }
  return result;
};

export const listOpenHumanRequests = async (projectId: string) => {
  const query = new URLSearchParams({ projectId, status: "OPEN" });
  return requestLocalApi(`/api/v1/human-requests?${query.toString()}`, humanRequestsResponseSchema);
};

export const getAttentionInbox = async () =>
  requestLocalApi("/api/v1/attention", attentionInboxResponseSchema);

export const getAgentFleet = async () => requestLocalApi("/api/v1/agent-fleet", agentFleetResponseSchema);

export const getWorkItemReviews = async (workItemId: string) =>
  requestLocalApi(`/api/v1/work-items/${encodeURIComponent(workItemId)}/reviews`, reviewStateResponseSchema);

export const getWorkItemQA = async (workItemId: string) =>
  requestLocalApi(`/api/v1/work-items/${encodeURIComponent(workItemId)}/qa`, qaStateResponseSchema);

export const workItemQAAttachmentUrl = (workItemId: string, attachmentId: string): string =>
  `/api/v1/work-items/${encodeURIComponent(workItemId)}/qa/attachments/${encodeURIComponent(attachmentId)}`;

export const workItemAcceptanceExportUrl = (workItemId: string, acceptancePackageId: string): string =>
  `/api/v1/work-items/${encodeURIComponent(workItemId)}/acceptance/${encodeURIComponent(acceptancePackageId)}/export`;

export const registerFixtureProject = async (fixtureId: FixtureProjectId): Promise<void> => {
  await requestLocalApi("/api/v1/projects/fixtures/register", stateCommandResultSchema, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID(), fixtureId }),
  });
};

/**
 * Registers a local Git repository the owner named as a Project (spec §4).
 *
 * Answers nothing on success for the same reason `registerFixtureProject` does not: the caller
 * refetches the Project list, which is where the new Project has to appear anyway. A refusal --
 * the path is not a repository, or it is a directory inside one -- arrives as an Error carrying the
 * daemon's own wording, which names the path and says what to do about it, and the caller shows
 * that rather than a sentence of its own.
 */
export const registerRepositoryProject = async (repositoryPath: string): Promise<void> => {
  await requestLocalApi("/api/v1/projects/register", stateCommandResultSchema, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID(), repositoryPath }),
  });
};

export const proposeNewProjectScaffold = async (targetPath: string): Promise<ScaffoldProposal> => {
  const result = await requestLocalApi("/api/v1/scaffolds/propose", proposeProjectScaffoldResponseSchema, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, recipeId: "typescript-node", targetPath }),
  });
  return result.proposal;
};

export const listOpenProjectScaffolds = async (): Promise<ScaffoldOperation[]> => {
  const result = await requestLocalApi("/api/v1/scaffolds", scaffoldOperationsResponseSchema);
  return result.operations;
};

export const publishNewProjectScaffold = async (proposal: ScaffoldProposal): Promise<ScaffoldOperation> => {
  const result = await requestLocalApi("/api/v1/scaffolds/publish", scaffoldOperationResponseSchema, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID(), proposal }),
  });
  if (result.operation === null) throw new Error("The local daemon did not return the scaffold operation");
  return result.operation;
};

export const retryNewProjectScaffold = async (operation: ScaffoldOperation): Promise<ScaffoldOperation> => {
  const result = await requestLocalApi(
    `/api/v1/scaffolds/${encodeURIComponent(operation.id)}/retry`,
    scaffoldOperationResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: operation.version,
      }),
    },
  );
  if (result.operation === null) throw new Error("The local daemon did not return the scaffold operation");
  return result.operation;
};

export type CreateWorkItemInput = {
  acceptanceCriteria: readonly string[];
  description: string;
  priority: WorkItem["priority"];
  projectId: string;
  risk: WorkItem["risk"];
  title: string;
  type: WorkItem["type"];
};

export const createWorkItem = async (
  input: CreateWorkItemInput,
  commandId: string = crypto.randomUUID(),
): Promise<WorkItem> => {
  const result = await requestLocalApi("/api/v1/work-items", stateCommandResultSchema, {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      commandId,
      projectId: input.projectId,
      parentId: null,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority,
      risk: input.risk,
      acceptanceCriteria: input.acceptanceCriteria,
    }),
  });

  if (result.type !== "WORK_ITEM_CREATED") {
    throw new Error("The local daemon returned an unexpected create result");
  }
  return result.workItem;
};

export const guidedActivationCreateCommandId = async (projectId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${guidedActivationContract.createCommandId}:${projectId}`),
  );
  const projectDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${guidedActivationContract.createCommandId}:${projectDigest}`;
};

export const createGuidedActivationWorkItem = async (projectId: string): Promise<WorkItem> =>
  createWorkItem(
    {
      ...guidedActivationContract.task,
      projectId,
    },
    await guidedActivationCreateCommandId(projectId),
  );

export const moveWorkItem = async (workItem: WorkItem, targetState: WorkItemState): Promise<WorkItem> => {
  const result = await requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItem.id)}/move`,
    stateCommandResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: workItem.version,
        targetState,
      }),
    },
  );

  if (result.type !== "WORK_ITEM_MOVED") {
    throw new Error("The local daemon returned an unexpected move result");
  }
  return result.workItem;
};

export type UpdateWorkItemPatch = Partial<
  Pick<WorkItem, "acceptanceCriteria" | "description" | "priority" | "risk" | "title">
>;

export const updateWorkItem = async (workItem: WorkItem, patch: UpdateWorkItemPatch): Promise<WorkItem> => {
  const result = await requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItem.id)}`,
    stateCommandResultSchema,
    {
      method: "PATCH",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: workItem.version,
        patch,
      }),
    },
  );

  if (result.type !== "WORK_ITEM_UPDATED") {
    throw new Error("The local daemon returned an unexpected update result");
  }
  return result.workItem;
};

export type PipelineStartPolicy = {
  maxEstimatedTokens: number;
  modelTierOverride: ModelTier | null;
  agentRunMaxEstimatedTokensOverride: number | null;
};

export const startMockPipeline = async (workItem: WorkItem, policy: PipelineStartPolicy) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItem.id)}/pipeline/start`,
    workflowSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: workItem.version,
        maxEstimatedTokens: policy.maxEstimatedTokens,
        modelTierOverride: policy.modelTierOverride,
        agentRunMaxEstimatedTokensOverride: policy.agentRunMaxEstimatedTokensOverride,
      }),
    },
  );

export const answerHumanRequest = async (request: HumanRequest, answer: HumanRequestAnswer) =>
  requestLocalApi(`/api/v1/human-requests/${encodeURIComponent(request.id)}/answer`, workflowSnapshotSchema, {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      expectedVersion: request.version,
      answer,
    }),
  });

export const disposeReviewFinding = async (
  finding: ReviewFinding,
  disposition: ReviewFindingOwnerDisposition,
  reason: string,
): Promise<ReviewFinding> => {
  const result = await requestLocalApi(
    `/api/v1/review-findings/${encodeURIComponent(finding.id)}/disposition`,
    reviewFindingDisposedResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: finding.version,
        disposition,
        reason,
      }),
    },
  );
  return result.finding;
};

export const waiveQADefect = async (defect: QADefect, reason: string): Promise<QADefect> => {
  const result = await requestLocalApi(
    `/api/v1/qa-defects/${encodeURIComponent(defect.id)}/waive`,
    qaDefectWaivedResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: defect.version,
        reason,
      }),
    },
  );
  return result.defect;
};

export const resolveQACorrectionGate = async (
  request: HumanRequest,
  correctionRun: QACorrectionRun,
  run: PipelineRun,
  action: QACorrectionGateAction,
) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(request.workItemId)}/qa/correction-gate/${encodeURIComponent(request.id)}`,
    qaCorrectionGateResolvedResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedRequestVersion: request.version,
        correctionRunId: correctionRun.id,
        expectedCorrectionVersion: correctionRun.version,
        expectedPipelineRunVersion: run.version,
        action,
      }),
    },
  );

export type PipelineControlAction = "pause" | "resume" | "cancel";

export const controlPipeline = async (workItemId: string, run: PipelineRun, action: PipelineControlAction) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/pipeline/${action}`,
    workflowSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: run.version,
      }),
    },
  );

export const approveBudgetOverride = async (
  workItemId: string,
  run: PipelineRun,
  maxEstimatedTokens: number,
  modelTierOverride: ModelTier | null,
  agentRunMaxEstimatedTokensOverride: number | null,
) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/pipeline/budget-override`,
    workflowSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: run.version,
        maxEstimatedTokens,
        modelTierOverride,
        agentRunMaxEstimatedTokensOverride,
      }),
    },
  );

export const resolveAcceptance = async (
  workItemId: string,
  run: PipelineRun,
  acceptancePackage: AcceptancePackage,
  action: AcceptanceAction,
  reason: string | null = null,
) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/acceptance/${encodeURIComponent(acceptancePackage.id)}/resolve`,
    workflowSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: acceptancePackage.version,
        expectedRunVersion: run.version,
        action,
        reason,
      }),
    },
  );
