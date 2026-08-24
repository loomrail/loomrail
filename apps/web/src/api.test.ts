import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestLocalApi, storeCsrfToken } from "./api";

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
    ).rejects.toThrow("reopened");
    expect(fetchMock).not.toHaveBeenCalled();
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
});
