import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectToLocalDaemon } from "./session";

describe("local daemon connection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("keeps a one-time bootstrap token in memory for a retry after a network interruption", async () => {
    const bootstrapToken = "bootstrap-retry-token".padEnd(43, "x");
    const csrfToken = "csrf-retry-token".padEnd(43, "x");
    window.history.replaceState(null, "", `/#bootstrap=${bootstrapToken}`);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const interrupted = await connectToLocalDaemon();

    expect(interrupted).toMatchObject({ status: "error", error: { recovery: "retry" } });
    expect(window.location.hash).toBe("");

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            csrfToken,
            expiresAt: "2026-08-24T16:30:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            apiVersion: "v1",
            authenticated: true,
            daemon: {
              status: "online",
              version: "0.0.0",
              mode: "local",
              startedAt: "2026-08-24T16:00:00.000Z",
              platform: "darwin",
            },
            foundation: {
              phase: "phase-0",
              milestone: "M3",
              providers: "mock-only",
              persistence: "sqlite",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(connectToLocalDaemon()).resolves.toMatchObject({ status: "connected" });
    expect(window.sessionStorage.getItem("loomrail.csrf-token")).toBe(csrfToken);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
