import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceStrategySelection } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { ProjectWorkspaceStrategyView } from "./ProjectWorkspaceStrategyPanel";

const selection: ProjectWorkspaceStrategySelection = {
  schemaVersion: 1,
  projectId: "project-recurkit",
  strategy: "ISOLATED_WORKTREE",
  projectVersion: 4,
  updatedAt: "2026-09-06T09:00:00.000Z",
};

const renderView = (
  overrides: Partial<React.ComponentProps<typeof ProjectWorkspaceStrategyView>> = {},
): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProjectWorkspaceStrategyView
        acceptedRisk={false}
        confirmingShared={false}
        error={null}
        onAcceptedRiskChange={vi.fn()}
        onCancelShared={vi.fn()}
        onConfirmShared={vi.fn()}
        onRequestShared={vi.fn()}
        onSelectIsolated={vi.fn()}
        repositoryPath="/projects/RecurKit"
        saving={false}
        selection={selection}
        {...overrides}
      />
    </I18nProvider>,
  );

describe("ProjectWorkspaceStrategyView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows both workspace choices without hiding them in a dropdown", () => {
    const html = renderView();

    expect(html).toContain("Working directory");
    expect(html).toContain("Separate worktree — recommended");
    expect(html).toContain("This project folder");
    expect(html).toContain("/projects/RecurKit");
    expect(html).toContain('type="radio"');
    expect(html).toMatch(/checked="" value="ISOLATED_WORKTREE"/);
    expect(html).not.toContain("I understand the shared-folder risk");
  });

  it("requires an explicit risk acknowledgement before shared mode can be saved", () => {
    const unchecked = renderView({ confirmingShared: true });
    expect(unchecked).toContain("Before Loomrail uses this folder");
    expect(unchecked).toContain("tracked and untracked files");
    expect(unchecked).toContain("editor, terminal, or other tools");
    expect(unchecked).toContain("I understand the shared-folder risk");
    expect(unchecked).toMatch(/<button[^>]*disabled=""[^>]*>.*Use this project folder/s);

    const accepted = renderView({ acceptedRisk: true, confirmingShared: true });
    expect(accepted).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Use this project folder/s);
  });

  it("explains that a strategy change applies only to workspaces created later", () => {
    const html = renderView({
      selection: { ...selection, strategy: "SHARED_CURRENT_DIRECTORY" },
    });

    expect(html).toMatch(/checked="" value="SHARED_CURRENT_DIRECTORY"/);
    expect(html).toContain("Existing task workspaces do not move");
  });
});
