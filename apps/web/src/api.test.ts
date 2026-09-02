import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalApiError,
  requestLocalApi,
  storeCsrfToken,
  waiveQADefect,
  workItemQAAttachmentUrl,
  workItemAcceptanceExportUrl,
} from "./api";

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

  it("keeps acceptance export identifiers inside the authenticated same-origin route", () => {
    expect(workItemAcceptanceExportUrl("work item/1", "package:1")).toBe(
      "/api/v1/work-items/work%20item%2F1/acceptance/package%3A1/export",
    );
  });

  it("sends an optimistic owner waiver for the exact QA defect", async () => {
    storeCsrfToken("csrf-fixture-token");
    const defect = {
      schemaVersion: 1 as const,
      id: "defect:1",
      qaRunId: "qa-run-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      testedTree: "a".repeat(40),
      ordinal: 1,
      severity: "HIGH" as const,
      status: "OPEN" as const,
      title: "Task Cockpit overflows",
      description: "The page is wider than the viewport.",
      reproduction: ["Open the Task Cockpit at 320px."],
      targetId: "mobile-dark-ru",
      scenarioId: "task-cockpit",
      resolutionReason: null,
      resolvedByQARunId: null,
      createdAt: "2026-09-02T10:00:00.000Z",
      resolvedAt: null,
      version: 3,
    };
    const waived = {
      ...defect,
      status: "WAIVED" as const,
      resolutionReason: "The owner accepts this bounded risk.",
      resolvedByQARunId: null,
      resolvedAt: "2026-09-02T10:05:00.000Z",
      version: 4,
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          type: "QA_DEFECT_WAIVED",
          replayed: false,
          workItemId: defect.workItemId,
          defect: waived,
          event: {
            schemaVersion: 1,
            sequence: 10,
            id: "event-10",
            type: "QA_DEFECT_WAIVED",
            aggregateType: "WORK_ITEM",
            aggregateId: defect.workItemId,
            projectId: defect.projectId,
            actor: { type: "HUMAN", id: "local-owner" },
            occurredAt: waived.resolvedAt,
            correlationId: "correlation-waive-defect",
            data: { defect: waived },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(waiveQADefect(defect, waived.resolutionReason)).resolves.toEqual(waived);
    const [url, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/qa-defects/defect%3A1/waive");
    if (typeof requestInit?.body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(requestInit.body)).toMatchObject({
      schemaVersion: 1,
      expectedVersion: 3,
      reason: waived.resolutionReason,
    });
    expect(new Headers(requestInit.headers).get("x-loomrail-csrf")).toBe("csrf-fixture-token");
  });
});
