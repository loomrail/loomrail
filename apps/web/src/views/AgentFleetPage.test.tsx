import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFleetEntry } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { AgentFleetView } from "./AgentFleetPage";

// @testing-library/react is not a dependency of apps/web -- this follows the repository's own
// idiom (see components/ProjectVerificationPanel.test.tsx) of rendering the pure, props-driven View
// with renderToStaticMarkup and asserting on the resulting HTML string.

const baseEntry: AgentFleetEntry = {
  schemaVersion: 1,
  project: { id: "project-1", name: "Storefront" },
  workItem: { id: "work-item-1", title: "Add checkout retry" },
  pipelineRunId: "pipeline-1",
  stageAttemptId: "stage-attempt-1",
  dispatchId: null,
  agentRunId: "agent-run-1",
  profile: { id: "builtin.developer", revision: 1, role: "DEVELOPER" },
  stage: "IMPLEMENT",
  provider: "CODEX",
  status: "RUNNING",
  waitReason: null,
  startedAt: "2026-09-14T10:00:00.000Z",
  latestAction: null,
};

const renderView = (overrides: Partial<Parameters<typeof AgentFleetView>[0]> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <AgentFleetView
        capacity={{ active: 1, globalLimit: 5 }}
        entries={[baseEntry]}
        error={null}
        fetching={false}
        loading={false}
        onOpenTask={vi.fn()}
        onRetry={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  );

describe("AgentFleetView latest action column", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("has a column header", () => {
    const html = renderView();
    expect(html).toContain("Latest action");
  });

  it("renders an accessible em dash for a running entry with no activity yet, like the Since column does", () => {
    const html = renderView({ entries: [{ ...baseEntry, latestAction: null }] });

    expect(html).toContain('aria-label="No activity yet">—<');
  });

  it("renders a provider-reported label as plain text, tagged by its untrusted origin, with no markup interpreted", () => {
    const html = renderView({
      entries: [
        {
          ...baseEntry,
          latestAction: { label: "<b>pnpm test</b> ls -la", origin: "PROVIDER_REPORTED" },
        },
      ],
    });

    expect(html).toContain("&lt;b&gt;pnpm test&lt;/b&gt; ls -la");
    expect(html).not.toContain("<b>pnpm test</b>");
    expect(html).toContain("Provider-reported");
  });

  it("translates a daemon-audited label through the shared workspaceTool.operation lookup", () => {
    const html = renderView({
      entries: [
        {
          ...baseEntry,
          latestAction: { label: "READ_FILE", origin: "DAEMON_AUDITED" },
        },
      ],
    });

    expect(html).toContain("Read file");
    expect(html).not.toContain(">READ_FILE<");
    expect(html).toContain("Verified");
  });

  it("keeps the table a table with a data-label on every latest-action cell for the narrow layout", () => {
    const html = renderView({
      entries: [{ ...baseEntry, latestAction: { label: "pnpm test", origin: "PROVIDER_REPORTED" } }],
    });

    expect(html).toContain("<table");
    expect(html).toContain('data-label="Latest action"');
  });
});
