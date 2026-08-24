import {
  apiErrorResponseSchema,
  daemonStatusResponseSchema,
  sessionExchangeResponseSchema,
  type DaemonStatusResponse,
} from "@loomrail/contracts";
import { queryOptions } from "@tanstack/react-query";

import { requestLocalApi, storeCsrfToken } from "./api";

export type ConnectionResult =
  { status: "connected"; daemon: DaemonStatusResponse } | { status: "error"; message: string };

const readErrorMessage = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorResponseSchema.safeParse(body);
  return parsed.success
    ? parsed.data.error.message
    : `Local daemon returned HTTP ${response.status.toString()}`;
};

const exchangeBootstrapToken = async (bootstrapToken: string): Promise<void> => {
  const response = await fetch("/api/session/exchange", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
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
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      await exchangeBootstrapToken(bootstrapToken);
    }

    return { status: "connected", daemon: await fetchDaemonStatus() };
  } catch (error: unknown) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not connect to the local Loomrail daemon",
    };
  }
};

export const localConnectionQuery = queryOptions({
  queryKey: ["local-daemon", "connection"],
  queryFn: connectToLocalDaemon,
  staleTime: Number.POSITIVE_INFINITY,
});
