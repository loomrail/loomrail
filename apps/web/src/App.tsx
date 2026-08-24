import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router";
import { I18nProvider } from "./i18n";
import { WorkspaceProvider } from "./workspace";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 30_000,
    },
  },
});

export const App = (): React.JSX.Element => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <WorkspaceProvider>
        <RouterProvider router={router} />
      </WorkspaceProvider>
    </I18nProvider>
  </QueryClientProvider>
);
