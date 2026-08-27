import { describe, expect, it } from "vitest";

import {
  createWorkItemRequestSchema,
  daemonStatusResponseSchema,
  domainEventSchema,
  healthResponseSchema,
  registerProjectCommandSchema,
  registerRepositoryProjectRequestSchema,
  sessionExchangeRequestSchema,
} from "../src/index.js";

describe("walking-skeleton contracts", () => {
  it("accepts a versioned health response", () => {
    const result = healthResponseSchema.safeParse({
      status: "ready",
      apiVersion: "v1",
      timestamp: "2026-08-22T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  // A relative path resolves against whatever directory the daemon was launched from, which is not
  // something the owner chose and not the same on the next start. The rule lives on the command and
  // on the Project itself rather than only at the HTTP edge, so no route or fixture can put one in
  // the database by a path that skips the edge check.
  it("refuses to record a Project at a relative repository path", () => {
    const registerAt = (repositoryPath: string) =>
      registerProjectCommandSchema.safeParse({
        schemaVersion: 1,
        commandId: "command-1",
        correlationId: "correlation-1",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: { id: "project-1", fixtureId: null, name: "acme-invoicing", repositoryPath },
      });

    // The exact thing typing `.` into the Settings field used to register, and the relative forms
    // beside it.
    expect(registerAt(".").success).toBe(false);
    expect(registerAt("./repos/acme").success).toBe(false);
    expect(registerAt("../acme").success).toBe(false);
    expect(registerAt("repos/acme").success).toBe(false);
    // Both blocking platforms' spellings of an absolute path pass: the daemon runs on macOS and on
    // Windows, and this contract is read on both.
    expect(registerAt("/srv/repositories/acme-invoicing").success).toBe(true);
    expect(registerAt("C:\\repositories\\acme-invoicing").success).toBe(true);
  });

  // The request the Settings field sends is deliberately *not* held to the same rule: it accepts
  // what the owner typed so the daemon can answer which of the possible problems it is. A schema
  // refusal here would collapse "not absolute", "not a repository" and "inside a repository" into
  // one "the request payload is invalid".
  it("accepts a relative path in the register request, so the daemon can say what is wrong with it", () => {
    expect(
      registerRepositoryProjectRequestSchema.safeParse({
        schemaVersion: 1,
        commandId: "command-1",
        repositoryPath: ".",
      }).success,
    ).toBe(true);
  });

  it("rejects short bootstrap tokens", () => {
    const result = sessionExchangeRequestSchema.safeParse({ bootstrapToken: "unsafe" });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown daemon milestone", () => {
    const result = daemonStatusResponseSchema.safeParse({
      apiVersion: "v1",
      authenticated: true,
      daemon: {
        status: "online",
        version: "0.0.0",
        mode: "local",
        startedAt: "2026-08-22T12:00:00.000Z",
        platform: "darwin",
      },
      foundation: {
        phase: "phase-0",
        milestone: "M99",
        providers: "mock-only",
        persistence: "not-enabled",
      },
    });

    expect(result.success).toBe(false);
  });

  it("normalizes WorkItem request defaults", () => {
    const result = createWorkItemRequestSchema.parse({
      schemaVersion: 1,
      commandId: "command-1",
      projectId: "project-1",
      type: "TASK",
      title: "Persist the task",
    });

    expect(result).toMatchObject({
      parentId: null,
      description: "",
      priority: "MEDIUM",
      risk: "MEDIUM",
      acceptanceCriteria: [],
    });
  });

  it("rejects unknown Event types", () => {
    expect(
      domainEventSchema.safeParse({
        schemaVersion: 1,
        sequence: 1,
        id: "event-1",
        type: "PROVIDER_SAID_DONE",
      }).success,
    ).toBe(false);
  });
});
