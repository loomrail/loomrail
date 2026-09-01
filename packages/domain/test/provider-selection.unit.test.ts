import type { Project, SetProjectProviderPreferenceCommand } from "@loomrail/contracts";
import { decideProjectProviderPreference, ProviderSelectionDomainError } from "@loomrail/domain";
import { describe, expect, it } from "vitest";

const project: Project = {
  schemaVersion: 1,
  id: "project-one",
  workspaceId: "workspace-local",
  fixtureId: null,
  name: "Project one",
  repositoryPath: "/tmp/project-one",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 3,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const command = (preference: SetProjectProviderPreferenceCommand["payload"]["preference"]) =>
  ({
    schemaVersion: 1,
    commandId: "set-provider",
    correlationId: "correlation-provider",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "SET_PROJECT_PROVIDER_PREFERENCE",
    payload: { projectId: project.id, expectedProjectVersion: project.version, preference },
  }) satisfies SetProjectProviderPreferenceCommand;

describe("Project Provider Preference", () => {
  it("advances the Project version and emits the previous preference", () => {
    const decision = decideProjectProviderPreference(command("CODEX"), {
      project,
      now: "2026-08-31T01:00:00.000Z",
    });

    expect(decision.project).toMatchObject({ providerPreference: "CODEX", version: 4 });
    expect(decision.selection).toMatchObject({ preference: "CODEX", projectVersion: 4 });
    expect(decision.event).toEqual({
      type: "PROJECT_PROVIDER_PREFERENCE_CHANGED",
      data: { selection: decision.selection, previousPreference: "AUTO" },
    });
  });

  it("refuses stale and no-op changes", () => {
    expect(() =>
      decideProjectProviderPreference(
        { ...command("CODEX"), payload: { ...command("CODEX").payload, expectedProjectVersion: 2 } },
        { project, now: "2026-08-31T01:00:00.000Z" },
      ),
    ).toThrow(ProviderSelectionDomainError);
    expect(() =>
      decideProjectProviderPreference(command("AUTO"), {
        project,
        now: "2026-08-31T01:00:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code: "PROVIDER_PREFERENCE_UNCHANGED" }));
  });
});
