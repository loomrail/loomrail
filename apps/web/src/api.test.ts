import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocalApiError, requestLocalApi, storeCsrfToken, workItemQAAttachmentUrl } from "./api";

const passThroughSchema = { parse: (value: unknown): unknown => value };

describe("local API client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("uses same-origin credentials and validates the response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(requestLocalApi("/api/v1/example", passThroughSchema)).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/example",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("refuses mutations when the bootstrap exchange has not stored a CSRF token", async () => {
    await expect(
      requestLocalApi("/api/v1/example", passThroughSchema, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      code: "LOCAL_SESSION_REQUIRED",
      recovery: "reopen",
    } satisfies Partial<LocalApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies an expired daemon session as requiring a secure reopen", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "SESSION_REQUIRED",
            correlationId: "correlation-session-required",
            message: "A valid local session is required",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(requestLocalApi("/api/v1/status", passThroughSchema)).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
      recovery: "reopen",
      status: 401,
    } satisfies Partial<LocalApiError>);
  });

  it("classifies an unreachable daemon as retryable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(requestLocalApi("/api/v1/status", passThroughSchema)).rejects.toMatchObject({
      code: "LOCAL_DAEMON_UNAVAILABLE",
      recovery: "retry",
      status: 0,
    } satisfies Partial<LocalApiError>);
  });

  it("adds the exchanged CSRF token to mutation requests", async () => {
    storeCsrfToken("csrf-fixture-token");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestLocalApi("/api/v1/example", passThroughSchema, { method: "POST", body: "{}" });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("x-loomrail-csrf")).toBe("csrf-fixture-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps QA attachment identifiers inside the authenticated same-origin route", () => {
    expect(workItemQAAttachmentUrl("work item/1", "attachment?1")).toBe(
      "/api/v1/work-items/work%20item%2F1/qa/attachments/attachment%3F1",
    );
  });
});
