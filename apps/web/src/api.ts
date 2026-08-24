import {
  apiErrorResponseSchema,
  eventsResponseSchema,
  humanRequestsResponseSchema,
  projectsResponseSchema,
  stateCommandResultSchema,
  workItemsResponseSchema,
  workflowSnapshotSchema,
  type FixtureProjectId,
  type HumanRequest,
  type HumanRequestAnswer,
  type WorkItem,
  type WorkItemState,
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

export const requestLocalApi = async <T>(
  path: string,
  schema: RuntimeSchema<T>,
  init: RequestInit = {},
): Promise<T> => {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");

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

  return schema.parse(await response.json());
};

export const listProjects = async () => requestLocalApi("/api/v1/projects", projectsResponseSchema);

export const listProjectWorkItems = async (projectId: string) =>
  requestLocalApi(`/api/v1/projects/${encodeURIComponent(projectId)}/work-items`, workItemsResponseSchema);

export const listWorkItemEvents = async (projectId: string, workItemId: string) => {
  const query = new URLSearchParams({ after: "0", aggregateId: workItemId, limit: "100", projectId });
  return requestLocalApi(`/api/v1/events?${query.toString()}`, eventsResponseSchema);
};

export const getWorkItemWorkflow = async (workItemId: string) =>
  requestLocalApi(`/api/v1/work-items/${encodeURIComponent(workItemId)}/workflow`, workflowSnapshotSchema);

export const listOpenHumanRequests = async (projectId: string) => {
  const query = new URLSearchParams({ projectId, status: "OPEN" });
  return requestLocalApi(`/api/v1/human-requests?${query.toString()}`, humanRequestsResponseSchema);
};

export const registerFixtureProject = async (fixtureId: FixtureProjectId): Promise<void> => {
  await requestLocalApi("/api/v1/projects/fixtures/register", stateCommandResultSchema, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID(), fixtureId }),
  });
};

export type CreateWorkItemInput = {
  description: string;
  priority: WorkItem["priority"];
  projectId: string;
  risk: WorkItem["risk"];
  title: string;
  type: WorkItem["type"];
};

export const createWorkItem = async (input: CreateWorkItemInput): Promise<WorkItem> => {
  const result = await requestLocalApi("/api/v1/work-items", stateCommandResultSchema, {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      projectId: input.projectId,
      parentId: null,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority,
      risk: input.risk,
      acceptanceCriteria: [],
    }),
  });

  if (result.type !== "WORK_ITEM_CREATED") {
    throw new Error("The local daemon returned an unexpected create result");
  }
  return result.workItem;
};

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

export const startMockPipeline = async (workItem: WorkItem) =>
  requestLocalApi(
    `/api/v1/work-items/${encodeURIComponent(workItem.id)}/pipeline/start`,
    workflowSnapshotSchema,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        expectedVersion: workItem.version,
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
