import {
  daemonStatusResponseSchema,
  sessionExchangeResponseSchema,
  type DaemonStatusResponse,
} from "@loomrail/contracts";
import { queryOptions } from "@tanstack/react-query";

import {
  createDaemonUnavailableError,
  isLocalApiError,
  readLocalApiError,
  requestLocalApi,
  storeCsrfToken,
} from "./api";

export type ConnectionResult =
  { status: "connected"; daemon: DaemonStatusResponse } | { status: "error"; error: Error; message: string };

let pendingBootstrapToken: string | null = null;

const exchangeBootstrapToken = async (bootstrapToken: string): Promise<void> => {
  let response: Response;
  try {
    response = await fetch("/api/session/exchange", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrapToken }),
    });
  } catch {
    throw createDaemonUnavailableError();
  }

  if (!response.ok) {
    throw await readLocalApiError(response);
  }

  const session = sessionExchangeResponseSchema.parse(await response.json());
  storeCsrfToken(session.csrfToken);
};

const fetchDaemonStatus = async (): Promise<DaemonStatusResponse> => {
  return requestLocalApi("/api/v1/status", daemonStatusResponseSchema);
};

export const connectToLocalDaemon = async (): Promise<ConnectionResult> => {
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const bootstrapToken = fragment.get("bootstrap");
    if (bootstrapToken) {
      pendingBootstrapToken = bootstrapToken;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (pendingBootstrapToken) {
      await exchangeBootstrapToken(pendingBootstrapToken);
      pendingBootstrapToken = null;
    }

    return { status: "connected", daemon: await fetchDaemonStatus() };
  } catch (error: unknown) {
    if (isLocalApiError(error) && error.recovery === "reopen") pendingBootstrapToken = null;
    const connectionError = error instanceof Error ? error : new Error("Could not connect to Loomrail");
    return {
      status: "error",
      error: connectionError,
      message: connectionError.message,
    };
  }
};

export const localConnectionQuery = queryOptions({
  queryKey: ["local-daemon", "connection"],
  queryFn: connectToLocalDaemon,
  staleTime: Number.POSITIVE_INFINITY,
});
