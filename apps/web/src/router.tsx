import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppFrame } from "./shell/AppFrame";
import { WorkbenchPage } from "./views/WorkbenchPage";

const rootRoute = createRootRoute({ component: AppFrame });

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkbenchPage,
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
