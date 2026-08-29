/* eslint-disable react-refresh/only-export-components -- workspace hooks intentionally share their provider module */
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcceptanceAction,
  AcceptancePackage,
  HumanRequest,
  FixtureProjectId,
  HumanRequestAnswer,
  ListedProject,
  PipelineRun,
  WorkItem,
  WorkItemState,
} from "@loomrail/contracts";

import {
  approveBudgetOverride,
  answerHumanRequest,
  controlPipeline,
  createWorkItem,
  getProviderCapabilities,
  getWorkItemChanges,
  getWorkItemFileDiff,
  getWorkItemWorkflow,
  getWorkItemWorkspace,
  listOpenHumanRequests,
  listProjects,
  listProjectWorkItems,
  listProviderSessions,
  listWorkItemEvents,
  moveWorkItem,
  registerFixtureProject,
  registerRepositoryProject,
  resolveAcceptance,
  startMockPipeline,
  updateWorkItem,
  type CreateWorkItemInput,
  type PipelineControlAction,
  type UpdateWorkItemPatch,
} from "./api";
import { localConnectionQuery, type ConnectionResult } from "./session";
import { useEventStream } from "./useEventStream";

const projectsKey = ["projects"] as const;
const projectWorkItemsKey = (projectId: string) => ["projects", projectId, "work-items"] as const;
const workItemEventsKey = (projectId: string, workItemId: string) =>
  ["projects", projectId, "work-items", workItemId, "events"] as const;
const workItemWorkflowKey = (workItemId: string) => ["work-items", workItemId, "workflow"] as const;
// Nested under the same `["work-items", <id>]` prefix the event channel invalidates for a WORK_ITEM
// signal (eventStream.ts, scopesForSignal), so a stage that cuts a workspace refreshes the card
// without a reload and without a second entry in that mapping.
const workItemWorkspaceKey = (workItemId: string) => ["work-items", workItemId, "workspace"] as const;
// Both change keys sit under that same `["work-items", <id>]` prefix. The event bridge deliberately
// excludes this subtree from its immediate 50 ms invalidation and refreshes it on the separately
// measured SUMMARY_REFRESH_DEBOUNCE_MS cadence (useEventStream.ts): an open card rereads the
// summary, and only the one body query mounted for an expanded file. An inactive query is marked
// stale but not fetched, so a closed card does no work.
const workItemChangesKey = (workItemId: string) => ["work-items", workItemId, "changes"] as const;
const workItemFileDiffKey = (workItemId: string, path: string) =>
  ["work-items", workItemId, "changes", "diff", path] as const;
const projectHumanRequestsKey = (projectId: string) =>
  ["projects", projectId, "human-requests", "OPEN"] as const;
const stageAttemptSessionsKey = (stageAttemptId: string) =>
  ["stage-attempts", stageAttemptId, "sessions"] as const;
const providerCapabilitiesKey = ["provider", "capabilities"] as const;

type WorkspaceContextValue = {
  connection: ConnectionResult | undefined;
  connectionPending: boolean;
  error: Error | null;
  projects: readonly ListedProject[];
  projectsPending: boolean;
  selectedProject: ListedProject | null;
  retryConnection: () => void;
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
  // Nothing is returned: the channel's only effect on this component tree is the invalidation it
  // performs through the query client (see useEventStream), not a status anything renders.
  useEventStream(connected);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      connection: connectionQuery.data,
      connectionPending: connectionQuery.isPending,
      error:
        connectionQuery.data?.status === "error"
          ? connectionQuery.data.error
          : connectionQuery.error instanceof Error
            ? connectionQuery.error
            : projectsQuery.error instanceof Error
              ? projectsQuery.error
              : null,
      projects,
      projectsPending: connected && projectsQuery.isPending,
      retryConnection: () => {
        void connectionQuery.refetch().then((result) => {
          if (result.data?.status === "connected") void projectsQuery.refetch();
        });
      },
      selectedProject,
      selectProject: setRequestedProjectId,
    }),
    [
      connected,
      connectionQuery.data,
      connectionQuery.error,
      connectionQuery.isPending,
      connectionQuery.refetch,
      projects,
      projectsQuery.error,
      projectsQuery.isPending,
      projectsQuery.refetch,
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

/**
 * Activity is append-only and read newest first, so pages are cursors into the past. Refetching
 * re-derives every cursor from the page before it, which keeps Events that arrive while older
 * pages are open from falling into the gap between two page boundaries.
 */
export const useWorkItemEvents = (projectId: string | undefined, workItemId: string | undefined) =>
  useInfiniteQuery({
    queryKey:
      projectId && workItemId
        ? workItemEventsKey(projectId, workItemId)
        : ["projects", "none", "work-items", "none", "events"],
    queryFn: ({ pageParam }) => {
      if (!projectId || !workItemId) throw new Error("A project and work item are required to list activity");
      return listWorkItemEvents(projectId, workItemId, pageParam);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextSequence : undefined),
    enabled: projectId !== undefined && workItemId !== undefined,
  });

export const useWorkItemWorkflow = (workItemId: string | undefined) =>
  useQuery({
    queryKey: workItemId ? workItemWorkflowKey(workItemId) : ["work-items", "none", "workflow"],
    queryFn: () => {
      if (!workItemId) throw new Error("A work item is required to load its workflow");
      return getWorkItemWorkflow(workItemId);
    },
    enabled: workItemId !== undefined,
  });

/**
 * Where this work item's agent writes, or `null` when it has never needed a repository.
 *
 * Separate from `useWorkItemWorkflow` because a workspace outlives the run that cut it: the
 * workflow snapshot is empty once no PipelineRun is current, and folding the workspace into it
 * would make the worktree path disappear from the card exactly when the owner goes looking for it.
 */
export const useWorkItemWorkspace = (workItemId: string | undefined) =>
  useQuery({
    queryKey: workItemId ? workItemWorkspaceKey(workItemId) : ["work-items", "none", "workspace"],
    queryFn: () => {
      if (!workItemId) throw new Error("A work item is required to load its workspace");
      return getWorkItemWorkspace(workItemId);
    },
    enabled: workItemId !== undefined,
  });

/**
 * What this work item changed in its worktree, or `null` when it has no workspace to change.
 *
 * Separate from `useWorkItemWorkspace` even though both answer for the same worktree: the workspace
 * row is state the daemon already holds, while this is a reading it performs on demand -- four git
 * processes over a temporary index -- and folding the expensive one into the cheap one would make
 * every card that only wants a worktree path pay for a diff.
 */
export const useWorkItemChanges = (workItemId: string) =>
  useQuery({
    queryKey: workItemChangesKey(workItemId),
    queryFn: () => getWorkItemChanges(workItemId),
  });

/**
 * One file's unified diff, kept a query of its own so it is fetched only while that file is
 * expanded (spec D5).
 *
 * Both arguments are required rather than optional-with-`enabled`, unlike the hooks above: the only
 * caller mounts this at all when the owner has expanded a specific file, so there is no "no file
 * chosen yet" state for it to represent -- and an `enabled: false` variant would be a way to fetch
 * bodies for files nobody asked for.
 */
export const useWorkItemFileDiff = (workItemId: string, path: string) =>
  useQuery({
    queryKey: workItemFileDiffKey(workItemId, path),
    queryFn: () => getWorkItemFileDiff(workItemId, path),
  });

/**
 * Spec §D5's nesting, read back for the Task Cockpit: the sessions inside a stage attempt, the
 * checkpoints published under it, and the highest window occupancy each session was measured at.
 */
export const useStageAttemptSessions = (stageAttemptId: string | undefined) =>
  useQuery({
    queryKey: stageAttemptId
      ? stageAttemptSessionsKey(stageAttemptId)
      : ["stage-attempts", "none", "sessions"],
    queryFn: () => {
      if (!stageAttemptId) throw new Error("A stage attempt is required to list its sessions");
      return listProviderSessions(stageAttemptId);
    },
    enabled: stageAttemptId !== undefined,
  });

/** The provider a session would run on right now (spec §7): whether it can wind down on request. */
export const useProviderCapabilities = () =>
  useQuery({ queryKey: providerCapabilitiesKey, queryFn: getProviderCapabilities });

export const useProjectHumanRequests = (projectId: string | undefined) =>
  useQuery({
    queryKey: projectId ? projectHumanRequestsKey(projectId) : ["projects", "none", "human-requests", "OPEN"],
    queryFn: () => {
      if (!projectId) throw new Error("A project is required to list HumanRequests");
      return listOpenHumanRequests(projectId);
    },
    enabled: projectId !== undefined,
  });

export const useInitializeFixtureWorkspace = () => {
  const queryClient = useQueryClient();
  const { projects } = useWorkspace();
  return useMutation({
    mutationFn: async () => {
      // A demo fixture is registered when it is absent, and again when the Project that records it
      // no longer points at a repository. The second half is the one that was missing: this used to
      // skip any `fixtureId` already present, so on a database that predates E1 -- where both demo
      // Projects record a directory inside Loomrail's own checkout, carried across verbatim by
      // migration 0012 -- pressing this did nothing at all, and the repair route it is the only
      // caller of was unreachable from the product.
      const usable = new Set(
        projects
          .filter(({ repositoryStatus }) => repositoryStatus === "READY")
          .map(({ fixtureId }) => fixtureId),
      );
      if (!usable.has("web-app-a")) await registerFixtureProject("web-app-a");
      if (!usable.has("api-service-b")) await registerFixtureProject("api-service-b");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
};

/**
 * Repairs one demo Project whose recorded path is no longer a repository (spec §4).
 *
 * The same route `useInitializeFixtureWorkspace` calls, aimed at a single fixture rather than at
 * both -- because this is reached from the Projects list, where the owner is looking at one
 * Project and its path. `POST /api/v1/projects/fixtures/register` materialises the fixture under
 * the daemon's data directory and moves the Project onto it (REPOINT_FIXTURE_PROJECT), so the
 * button does exactly what "initialize the demo workspace" does, for the Project the owner picked.
 *
 * There is deliberately no equivalent for a Project the owner registered by path: Loomrail does not
 * know where they moved their repository to, and inventing a path for them is not a repair. That
 * one is fixed by registering the new path, which the field below already does.
 */
export const useRepairFixtureProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fixtureId: FixtureProjectId) => registerFixtureProject(fixtureId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
};

/** Spec §4: the owner registers a local Git repository by path, alongside the bundled demo. */
export const useRegisterRepositoryProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryPath: string) => registerRepositoryProject(repositoryPath),
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

export const useUpdateWorkItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, workItem }: { patch: UpdateWorkItemPatch; workItem: WorkItem }) =>
      updateWorkItem(workItem, patch),
    onSuccess: async (workItem) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
      ]);
    },
  });
};

export const useStartMockPipeline = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItem: WorkItem) => startMockPipeline(workItem),
    onSuccess: async (_, workItem) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemWorkflowKey(workItem.id) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
        queryClient.invalidateQueries({ queryKey: projectHumanRequestsKey(workItem.projectId) }),
      ]);
    },
  });
};

export const useAnswerHumanRequest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ answer, request }: { answer: HumanRequestAnswer; request: HumanRequest }) =>
      answerHumanRequest(request, answer),
    onSuccess: async (_, { request }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(request.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemWorkflowKey(request.workItemId) }),
        queryClient.invalidateQueries({
          queryKey: workItemEventsKey(request.projectId, request.workItemId),
        }),
        queryClient.invalidateQueries({ queryKey: projectHumanRequestsKey(request.projectId) }),
        queryClient.invalidateQueries({ queryKey: stageAttemptSessionsKey(request.stageAttemptId) }),
      ]);
    },
  });
};

export const usePipelineControl = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      action,
      run,
      workItem,
    }: {
      action: PipelineControlAction;
      run: PipelineRun;
      workItem: WorkItem;
    }) => controlPipeline(workItem.id, run, action),
    onSuccess: async (_, { run, workItem }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemWorkflowKey(workItem.id) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
        queryClient.invalidateQueries({ queryKey: projectHumanRequestsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: stageAttemptSessionsKey(run.currentStageAttemptId) }),
      ]);
    },
  });
};

export const useApproveBudgetOverride = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      maxEstimatedTokens,
      run,
      workItem,
    }: {
      maxEstimatedTokens: number;
      run: PipelineRun;
      workItem: WorkItem;
    }) => approveBudgetOverride(workItem.id, run, maxEstimatedTokens),
    onSuccess: async (_, { run, workItem }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemWorkflowKey(workItem.id) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
        queryClient.invalidateQueries({ queryKey: projectHumanRequestsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: stageAttemptSessionsKey(run.currentStageAttemptId) }),
      ]);
    },
  });
};

export const useResolveAcceptance = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      acceptancePackage,
      action,
      run,
      workItem,
    }: {
      acceptancePackage: AcceptancePackage;
      action: AcceptanceAction;
      run: PipelineRun;
      workItem: WorkItem;
    }) => resolveAcceptance(workItem.id, run, acceptancePackage, action),
    onSuccess: async (_, { workItem }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectWorkItemsKey(workItem.projectId) }),
        queryClient.invalidateQueries({ queryKey: workItemWorkflowKey(workItem.id) }),
        queryClient.invalidateQueries({ queryKey: workItemEventsKey(workItem.projectId, workItem.id) }),
        queryClient.invalidateQueries({ queryKey: projectHumanRequestsKey(workItem.projectId) }),
      ]);
    },
  });
};
