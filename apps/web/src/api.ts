import {
  apiErrorResponseSchema,
  eventsResponseSchema,
  projectsResponseSchema,
  stateCommandResultSchema,
  workItemsResponseSchema,
  type FixtureProjectId,
  type WorkItem,
  type WorkItemState,
} from "@loomrail/contracts";

type RuntimeSchema<T> = {
  parse: (value: unknown) => T;
};

const CSRF_STORAGE_KEY = "loomrail.csrf-token";

const readErrorMessage = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorResponseSchema.safeParse(body);
  return parsed.success
    ? parsed.data.error.message
    : `Local daemon returned HTTP ${response.status.toString()}`;
};

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
      throw new Error("The local session must be reopened before changing data");
    }
    headers.set("x-loomrail-csrf", csrfToken);
  }

  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
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
