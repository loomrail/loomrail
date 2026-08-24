import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppFrame } from "./shell/AppFrame";
import { WorkbenchPage } from "./views/WorkbenchPage";

const rootRoute = createRootRoute({ component: AppFrame });

const summaryFilters = new Set(["active", "atRisk", "needsYou"]);
const workItemFilters = new Set([
  "priority-high",
  "priority-low",
  "priority-medium",
  "priority-urgent",
  "status-backlog",
  "status-blocked",
  "status-in_progress",
  "status-ready",
]);

export type SummaryFilter = "active" | "atRisk" | "needsYou";

export type WorkbenchSearch = {
  filters?: string;
  summary?: SummaryFilter;
};

const validateWorkbenchSearch = (search: Record<string, unknown>): WorkbenchSearch => {
  const rawFilters = search["filters"];
  const rawSummary = search["summary"];
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

  return {
    ...(filters.length > 0 ? { filters } : {}),
    ...(summary === undefined ? {} : { summary }),
  };
};

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkbenchPage,
  validateSearch: validateWorkbenchSearch,
});

const routeTree = rootRoute.addChildren([workbenchRoute]);

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
