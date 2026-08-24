import { describe, expect, it } from "vitest";

import {
  createWorkItemRequestSchema,
  daemonStatusResponseSchema,
  domainEventSchema,
  healthResponseSchema,
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
