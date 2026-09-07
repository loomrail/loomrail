import type { Project, SetProjectWorkspaceStrategyCommand } from "@loomrail/contracts";
import { decideProjectWorkspaceStrategy, WorkspaceStrategyDomainError } from "@loomrail/domain";
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
  createdAt: "2026-09-06T09:00:00.000Z",
  updatedAt: "2026-09-06T09:00:00.000Z",
};

const command = (strategy: SetProjectWorkspaceStrategyCommand["payload"]["strategy"]) =>
  ({
    schemaVersion: 1,
    commandId: "set-workspace-strategy",
    correlationId: "correlation-workspace-strategy",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "SET_PROJECT_WORKSPACE_STRATEGY",
    payload: {
      projectId: project.id,
      expectedProjectVersion: project.version,
      strategy,
    },
  }) satisfies SetProjectWorkspaceStrategyCommand;

describe("Project Workspace Strategy", () => {
  it("advances the Project version and records the previous strategy", () => {
    const decision = decideProjectWorkspaceStrategy(command("SHARED_CURRENT_DIRECTORY"), {
      project,
      currentStrategy: "ISOLATED_WORKTREE",
      now: "2026-09-06T10:00:00.000Z",
    });

    expect(decision.project).toMatchObject({ version: 4, updatedAt: "2026-09-06T10:00:00.000Z" });
    expect(decision.selection).toMatchObject({ strategy: "SHARED_CURRENT_DIRECTORY", projectVersion: 4 });
    expect(decision.event).toEqual({
      type: "PROJECT_WORKSPACE_STRATEGY_CHANGED",
      data: { selection: decision.selection, previousStrategy: "ISOLATED_WORKTREE" },
    });
  });

  it("refuses stale, inactive and unchanged mutations", () => {
    expect(() =>
      decideProjectWorkspaceStrategy(command("SHARED_CURRENT_DIRECTORY"), {
        project,
        currentStrategy: "ISOLATED_WORKTREE",
        now: "2026-09-06T10:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      decideProjectWorkspaceStrategy(
        {
          ...command("SHARED_CURRENT_DIRECTORY"),
          payload: { ...command("SHARED_CURRENT_DIRECTORY").payload, expectedProjectVersion: 2 },
        },
        { project, currentStrategy: "ISOLATED_WORKTREE", now: "2026-09-06T10:00:00.000Z" },
      ),
    ).toThrow(expect.objectContaining({ code: "PROJECT_VERSION_CONFLICT" }));
    expect(() =>
      decideProjectWorkspaceStrategy(command("ISOLATED_WORKTREE"), {
        project,
        currentStrategy: "ISOLATED_WORKTREE",
        now: "2026-09-06T10:00:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_STRATEGY_UNCHANGED" }));
    expect(() =>
      decideProjectWorkspaceStrategy(command("SHARED_CURRENT_DIRECTORY"), {
        project: { ...project, status: "ARCHIVED" },
        currentStrategy: "ISOLATED_WORKTREE",
        now: "2026-09-06T10:00:00.000Z",
      }),
    ).toThrow(WorkspaceStrategyDomainError);
  });
});
