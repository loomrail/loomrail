import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationPlanPublication, VerificationPlanSettingsResponse } from "@loomrail/contracts";

import {
  LocalApiError,
  guidedActivationCreateCommandId,
  getProjectProviderAllowance,
  getVerificationCheckOutput,
  getVerificationPlanSettings,
  refreshProjectProviderAllowance,
  requestLocalApi,
  retryVerificationPlanPublication,
  storeCsrfToken,
  adoptVerificationPlan,
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

  it("reads measured verification output as text without treating it as JSON or markup", async () => {
    fetchMock.mockResolvedValue(
      new Response("<script>window.mustNotRun = true</script>\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );

    await expect(getVerificationCheckOutput("check / one")).resolves.toContain("<script>");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/verification-checks/check%20%2F%20one/output");
    expect(new Headers(init?.headers).get("accept")).toBe("text/plain");
    expect(init).toMatchObject({ credentials: "same-origin" });
  });

  it("reads and refreshes provider allowance through the project-scoped authenticated routes", async () => {
    const unavailable = (provider: "CODEX" | "CLAUDE_CODE" | "MOCK") => ({
      schemaVersion: 1,
      provider,
      observedAt: "2026-09-04T18:00:00.000Z",
      freshness: "UNAVAILABLE",
      buckets: [],
      unavailableReason: "PROVIDER_UNSUPPORTED",
    });
    const response = {
      schemaVersion: 1,
      projectId: "project / one",
      effectiveProvider: "MOCK",
      current: unavailable("MOCK"),
      advisory: { status: "UNKNOWN", deferUntil: null },
      providers: [unavailable("CODEX"), unavailable("CLAUDE_CODE")],
    };
    fetchMock.mockImplementation(async () =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getProjectProviderAllowance(response.projectId)).resolves.toEqual(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/provider/allowance?projectId=project%20%2F%20one");

    storeCsrfToken("csrf-fixture-token");
    await expect(refreshProjectProviderAllowance(response.projectId)).resolves.toEqual(response);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/api/v1/projects/project%20%2F%20one/provider-allowance/refresh");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-loomrail-csrf")).toBe("csrf-fixture-token");
  });

  it("reads, adopts and retries the exact project verification Plan through authenticated routes", async () => {
    const response: VerificationPlanSettingsResponse = {
      schemaVersion: 1,
      projectId: "project:one",
      projectVersion: 3,
      proposal: {
        schemaVersion: 1,
        projectId: "project:one",
        target: { state: "ABSENT", digest: null },
        recipes: [
          {
            schemaVersion: 1,
            id: "package-test",
            kind: "UNIT",
            label: "Tests",
            required: true,
            executable: "pnpm",
            argv: ["run", "test"],
            cwd: ".",
            timeoutSeconds: 300,
            outputLimitBytes: 65_536,
            environmentProfile: "VERIFICATION_BASELINE",
            networkPolicy: "INHERIT_HOST",
            provenance: {
              source: "PACKAGE_JSON_SCRIPT",
              manifestPath: "package.json",
              manifestContentHash: "a".repeat(64),
              scriptName: "test",
              scriptBodyPreview: "vitest run",
            },
          },
        ],
        warnings: [],
        proposalHash: "b".repeat(64),
      },
      plan: null,
      publication: null,
    };
    fetchMock.mockImplementation(async () =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getVerificationPlanSettings(response.projectId)).resolves.toEqual(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/projects/project%3Aone/verification-plan");

    storeCsrfToken("csrf-fixture-token");
    await expect(adoptVerificationPlan(response)).resolves.toEqual(response);
    const [adoptUrl, adoptInit] = fetchMock.mock.calls[1] ?? [];
    expect(adoptUrl).toBe("/api/v1/projects/project%3Aone/verification-plan/adopt");
    expect(adoptInit?.method).toBe("POST");
    if (typeof adoptInit?.body !== "string") throw new Error("Expected an adoption JSON body");
    expect(JSON.parse(adoptInit.body)).toMatchObject({
      schemaVersion: 1,
      expectedProjectVersion: 3,
      proposalHash: "b".repeat(64),
    });

    const publication: VerificationPlanPublication = {
      schemaVersion: 1,
      id: "verification-publication-1",
      projectId: response.projectId,
      planId: "verification-plan-1",
      targetPath: ".loomrail/verification-plan.json",
      expectedTargetDigest: null,
      contentHash: "c".repeat(64),
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "WRITE_FAILED",
      version: 2,
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:01.000Z",
      appliedAt: null,
    };
    await expect(retryVerificationPlanPublication(response.projectId, publication)).resolves.toEqual(
      response,
    );
    const [retryUrl, retryInit] = fetchMock.mock.calls[2] ?? [];
    expect(retryUrl).toBe("/api/v1/projects/project%3Aone/verification-plan/publication/retry");
    expect(retryInit?.method).toBe("POST");
    if (typeof retryInit?.body !== "string") throw new Error("Expected a retry JSON body");
    expect(JSON.parse(retryInit.body)).toMatchObject({
      publicationId: publication.id,
      expectedVersion: 2,
    });
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

  it("derives one bounded idempotency key for each guided project", async () => {
    const first = await guidedActivationCreateCommandId("project-one");
    expect(await guidedActivationCreateCommandId("project-one")).toBe(first);
    expect(await guidedActivationCreateCommandId("project-two")).not.toBe(first);
    expect(first).toMatch(/^guided-activation-v1-create-task:[a-f0-9]{64}$/);
    expect(first.length).toBeLessThanOrEqual(128);
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
