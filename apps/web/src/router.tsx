import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { opaqueIdSchema } from "@loomrail/contracts";

import {
  defaultBoardView,
  isBoardDirection,
  isBoardOrdering,
  isBoardScope,
  type BoardDirection,
  type BoardOrdering,
  type BoardScope,
} from "./boardView";
import { AppFrame } from "./shell/AppFrame";
import { WorkbenchPage } from "./views/WorkbenchPage";
import { AttentionPage } from "./views/AttentionPage";
import { AgentFleetPage } from "./views/AgentFleetPage";

const rootRoute = createRootRoute({ component: AppFrame });

// The board retains one bounded summary filter for links shared before the global Inbox existed.
const summaryFilters = new Set(["needsYou"]);
const workItemFilters = new Set([
  "priority-high",
  "priority-low",
  "priority-medium",
  "priority-urgent",
  "risk-critical",
  "risk-high",
  "risk-low",
  "risk-medium",
  "status-backlog",
  "status-blocked",
  "status-cancelled",
  "status-done",
  "status-in_progress",
  "status-ready",
]);

export type SummaryFilter = "needsYou";

export type WorkbenchSearch = {
  dir?: BoardDirection;
  filters?: string;
  hideEmpty?: true;
  order?: BoardOrdering;
  scope?: Exclude<BoardScope, "active">;
  summary?: SummaryFilter;
  project?: string;
  task?: string;
};

const validateWorkbenchSearch = (search: Record<string, unknown>): WorkbenchSearch => {
  const rawFilters = search["filters"];
  const rawSummary = search["summary"];
  const project = opaqueIdSchema.safeParse(search["project"]);
  const task = opaqueIdSchema.safeParse(search["task"]);
  const filters =
    typeof rawFilters === "string"
      ? rawFilters
          .split(",")
          .filter((filter) => workItemFilters.has(filter))
          .join(",")
      : "";
  const summary =
    typeof rawSummary === "string" && summaryFilters.has(rawSummary)
      ? (rawSummary as SummaryFilter)
      : undefined;

  const rawOrder = search["order"];
  const rawDirection = search["dir"];
  const order = isBoardOrdering(rawOrder) && rawOrder !== defaultBoardView.ordering ? rawOrder : undefined;
  const dir =
    isBoardDirection(rawDirection) && rawDirection !== defaultBoardView.direction ? rawDirection : undefined;
  const hideEmpty = search["hideEmpty"] === true || search["hideEmpty"] === "true" ? true : undefined;
  const rawScope = search["scope"];
  const scope = isBoardScope(rawScope) && rawScope !== "active" ? rawScope : undefined;

  return {
    ...(filters.length > 0 ? { filters } : {}),
    ...(summary === undefined ? {} : { summary }),
    ...(order === undefined ? {} : { order }),
    ...(dir === undefined ? {} : { dir }),
    ...(hideEmpty === undefined ? {} : { hideEmpty }),
    ...(scope === undefined ? {} : { scope }),
    ...(project.success ? { project: project.data } : {}),
    ...(task.success ? { task: task.data } : {}),
  };
};

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkbenchPage,
  validateSearch: validateWorkbenchSearch,
});

const attentionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/attention",
  component: AttentionPage,
});

const agentFleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fleet",
  component: AgentFleetPage,
});

const routeTree = rootRoute.addChildren([workbenchRoute, attentionRoute, agentFleetRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  // Interface merging is the registration mechanism required by TanStack Router.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
