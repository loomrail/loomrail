import type { Project, ProviderAllowanceSnapshot, RecordProviderAllowanceCommand } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideRecordProviderAllowance, ProviderAllowanceDomainError } from "../src/index.js";

const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-local",
  fixtureId: null,
  name: "Project",
  repositoryPath: "/tmp/project",
  providerPreference: "CODEX",
  status: "ACTIVE",
  version: 1,
  createdAt: "2026-09-04T19:00:00.000Z",
  updatedAt: "2026-09-04T19:00:00.000Z",
};

const snapshot = (observedAt = "2026-09-04T20:00:00.000Z"): ProviderAllowanceSnapshot => ({
  schemaVersion: 1,
  provider: "CODEX",
  observedAt,
  freshness: "LIVE",
  buckets: [
    {
      id: "codex:primary",
      name: "Codex",
      kind: "PRIMARY",
      usedPercent: 25,
      remainingPercent: 75,
      windowDurationMins: 300,
      resetsAt: "2026-09-05T00:00:00.000Z",
      limitReached: false,
    },
  ],
  unavailableReason: null,
});

const command = (value = snapshot()): RecordProviderAllowanceCommand => ({
  schemaVersion: 1,
  commandId: "command-1",
  correlationId: "correlation-1",
  actor: { type: "SYSTEM", id: "provider-allowance" },
  type: "RECORD_PROVIDER_ALLOWANCE",
  payload: { projectId: project.id, snapshot: value },
});

describe("provider allowance recording", () => {
  it("returns only the normalized snapshot and a matching audit intent", () => {
    expect(decideRecordProviderAllowance(command(), { project })).toEqual({
      snapshot: snapshot(),
      event: { type: "PROVIDER_ALLOWANCE_RECORDED", data: { snapshot: snapshot() } },
    });
  });

  it.each([
    ["2026-09-04T19:59:59.999Z", "PROVIDER_ALLOWANCE_STALE"],
    ["2026-09-04T20:00:00.000Z", "PROVIDER_ALLOWANCE_STALE"],
    ["2026-09-04T21:00:00.000+01:00", "PROVIDER_ALLOWANCE_STALE"],
  ] as const)("refuses an out-of-order observation at %s", (observedAt, code) => {
    expect(() =>
      decideRecordProviderAllowance(command(snapshot(observedAt)), { project, current: snapshot() }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("orders valid ISO offsets by instant rather than by their text", () => {
    const later = snapshot("2026-09-04T21:00:00.001+01:00");

    expect(decideRecordProviderAllowance(command(later), { project, current: snapshot() }).snapshot).toEqual(
      later,
    );
  });

  it("refuses a browser-authored observation", () => {
    const human = { ...command(), actor: { type: "HUMAN" as const, id: "owner" } };
    expect(() => decideRecordProviderAllowance(human, { project })).toThrow(
      expect.objectContaining({ code: "PROVIDER_ALLOWANCE_ACTOR_FORBIDDEN" }),
    );
  });

  it("refuses an inactive or missing Project", () => {
    expect(() => decideRecordProviderAllowance(command(), {})).toThrow(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
    );
    expect(() =>
      decideRecordProviderAllowance(command(), { project: { ...project, status: "ARCHIVED" } }),
    ).toThrow(expect.objectContaining({ code: "PROJECT_NOT_ACTIVE" }));
  });

  it("uses typed domain errors", () => {
    try {
      decideRecordProviderAllowance(command(), {});
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProviderAllowanceDomainError);
      return;
    }
    throw new Error("expected recording to fail");
  });
});
