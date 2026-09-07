import { describe, expect, it } from "vitest";

import {
  projectWorkspaceStrategyResponseSchema,
  setProjectWorkspaceStrategyRequestSchema,
  workspaceStrategySchema,
} from "../src/index.js";

describe("Project Workspace Strategy contracts", () => {
  it("keeps the strategy vocabulary closed", () => {
    expect(workspaceStrategySchema.options).toEqual(["ISOLATED_WORKTREE", "SHARED_CURRENT_DIRECTORY"]);
    expect(() => workspaceStrategySchema.parse("CURRENT_DIRECTORY_WITHOUT_LEASE")).toThrow();
  });

  it("publishes the effective default with the Project version", () => {
    expect(
      projectWorkspaceStrategyResponseSchema.parse({
        schemaVersion: 1,
        selection: {
          schemaVersion: 1,
          projectId: "project-one",
          strategy: "ISOLATED_WORKTREE",
          projectVersion: 3,
          updatedAt: "2026-09-06T10:00:00.000Z",
        },
      }),
    ).toMatchObject({ selection: { strategy: "ISOLATED_WORKTREE", projectVersion: 3 } });
  });

  it("requires optimistic concurrency on a strategy mutation", () => {
    expect(
      setProjectWorkspaceStrategyRequestSchema.parse({
        schemaVersion: 1,
        commandId: "set-workspace-strategy",
        expectedProjectVersion: 3,
        strategy: "SHARED_CURRENT_DIRECTORY",
      }),
    ).toMatchObject({ expectedProjectVersion: 3, strategy: "SHARED_CURRENT_DIRECTORY" });
    expect(() =>
      setProjectWorkspaceStrategyRequestSchema.parse({
        schemaVersion: 1,
        commandId: "set-workspace-strategy",
        strategy: "SHARED_CURRENT_DIRECTORY",
      }),
    ).toThrow();
  });
});
