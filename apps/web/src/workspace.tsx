/* eslint-disable react-refresh/only-export-components -- workspace hooks intentionally share their provider module */
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, WorkItem, WorkItemState } from "@loomrail/contracts";

import {
  createWorkItem,
  listProjects,
  listProjectWorkItems,
  listWorkItemEvents,
  moveWorkItem,
  registerFixtureProject,
  type CreateWorkItemInput,
} from "./api";
import { localConnectionQuery, type ConnectionResult } from "./session";

const projectsKey = ["projects"] as const;
const projectWorkItemsKey = (projectId: string) => ["projects", projectId, "work-items"] as const;
const workItemEventsKey = (projectId: string, workItemId: string) =>
  ["projects", projectId, "work-items", workItemId, "events"] as const;

type WorkspaceContextValue = {
  connection: ConnectionResult | undefined;
  connectionPending: boolean;
  error: Error | null;
  projects: readonly Project[];
  projectsPending: boolean;
  selectedProject: Project | null;
  selectProject: (projectId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const connectionQuery = useQuery(localConnectionQuery);
  const connected = connectionQuery.data?.status === "connected";
  const projectsQuery = useQuery({
    queryKey: projectsKey,
    queryFn: listProjects,
    enabled: connected,
  });
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
  const projects = projectsQuery.data?.projects ?? [];
  const selectedProject =
    projects.find((project) => project.id === requestedProjectId) ?? projects.at(0) ?? null;

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      connection: connectionQuery.data,
      connectionPending: connectionQuery.isPending,
      error:
        connectionQuery.data?.status === "error"
          ? new Error(connectionQuery.data.message)
          : connectionQuery.error instanceof Error
            ? connectionQuery.error
            : projectsQuery.error instanceof Error
              ? projectsQuery.error
              : null,
      projects,
      projectsPending: connected && projectsQuery.isPending,
      selectedProject,
      selectProject: setRequestedProjectId,
    }),
    [
      connected,
      connectionQuery.data,
      connectionQuery.error,
      connectionQuery.isPending,
      projects,
      projectsQuery.error,
      projectsQuery.isPending,
      selectedProject,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
};

export const useWorkspace = (): WorkspaceContextValue => {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be rendered inside WorkspaceProvider");
  return value;
};

export const useProjectWorkItems = (projectId: string | undefined) =>
  useQuery({
    queryKey: projectId ? projectWorkItemsKey(projectId) : ["projects", "none", "work-items"],
    queryFn: () => {
      if (!projectId) throw new Error("A project is required to list work items");
      return listProjectWorkItems(projectId);
    },
    enabled: projectId !== undefined,
  });

export const useWorkItemEvents = (projectId: string | undefined, workItemId: string | undefined) =>
  useQuery({
    queryKey:
      projectId && workItemId
        ? workItemEventsKey(projectId, workItemId)
        : ["projects", "none", "work-items", "none", "events"],
    queryFn: () => {
      if (!projectId || !workItemId) throw new Error("A project and work item are required to list activity");
      return listWorkItemEvents(projectId, workItemId);
    },
    enabled: projectId !== undefined && workItemId !== undefined,
  });

export const useInitializeFixtureWorkspace = () => {
  const queryClient = useQueryClient();
  const { projects } = useWorkspace();
  return useMutation({
    mutationFn: async () => {
      const registered = new Set(projects.map((project) => project.fixtureId));
      if (!registered.has("web-app-a")) await registerFixtureProject("web-app-a");
      if (!registered.has("api-service-b")) await registerFixtureProject("api-service-b");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
};

export const useCreateWorkItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkItemInput) => createWorkItem(input),
    onSuccess: async (workItem) => {
      await queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) });
    },
  });
};

export const useMoveWorkItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetState, workItem }: { targetState: WorkItemState; workItem: WorkItem }) =>
      moveWorkItem(workItem, targetState),
    onSuccess: async (workItem) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
      ]);
    },
  });
};
