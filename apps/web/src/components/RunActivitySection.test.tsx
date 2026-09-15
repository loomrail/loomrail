import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunActivityEntry } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { RunActivityView } from "./RunActivitySection";

// @testing-library/react is not a dependency of apps/web -- this follows the repository's own
// idiom (see components/ProjectVerificationPanel.test.tsx and views/AgentFleetPage.test.tsx) of
// rendering the pure, props-driven View with renderToStaticMarkup and asserting on the resulting
// HTML string.

const entry = (overrides: Partial<AgentRunActivityEntry> = {}): AgentRunActivityEntry => ({
  id: "activity-1",
  seq: 1,
  at: "2026-09-14T10:00:00.000Z",
  origin: "DAEMON_AUDITED",
  provider: "CLAUDE_CODE",
  kind: "TOOL_CALL",
  label: "READ_FILE",
  detail: "src/index.ts",
  status: "SUCCEEDED",
  failureCode: null,
  truncated: false,
  ...overrides,
});

const renderView = (overrides: Partial<Parameters<typeof RunActivityView>[0]> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <RunActivityView
        collapsedAction={null}
        degraded={false}
        entries={[]}
        error={null}
        expanded={false}
        gap={false}
        hasMore={false}
        loading={false}
        omittedCount={0}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
        onToggle={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  );

describe("RunActivityView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("collapses to the latest action and a count", () => {
    const html = renderView({
      entries: [
        entry({ id: "a1", seq: 1, label: "READ_FILE" }),
        entry({ id: "a2", seq: 2, label: "LIST_DIRECTORY" }),
        entry({ id: "a3", seq: 3, label: "WRITE_FILE" }),
      ],
    });

    expect(html).toContain("<summary");
    // The latest of the three -- oldest-first, so the last array entry -- not the first.
    expect(html).toContain("Write file");
    expect(html).not.toContain("Read file");
    expect(html).toContain('run-activity__count">3<');
    // Collapsed by default: the full list is not in the DOM at all, not merely hidden by CSS --
    // provider detail is a diagnostic view opened on request, never the primary experience.
    expect(html).not.toContain("run-activity__entries");
    expect(html).not.toContain("src/index.ts");
  });

  it("expands to the merged list in order when asked, with a native, keyboard-operable control", () => {
    const html = renderView({
      entries: [entry({ id: "a1", seq: 1 }), entry({ id: "a2", seq: 2, label: "WRITE_FILE" })],
      expanded: true,
    });

    // <summary> is a native disclosure control: keyboard toggling (Enter/Space) and tab focus come
    // from the browser for free, and its implicit ARIA role is "button".
    expect(html).toContain("<details");
    expect(html).toMatch(/<details[^>]* open(="")?[ >]/);
    expect(html).toContain("run-activity__entries");
    // Order within the merged list itself, not the collapsed summary above it (which shows the
    // latest entry's own heading text ahead of the list for an unrelated reason).
    const list = html.slice(html.indexOf("run-activity__entries"));
    expect(list.indexOf("Read file")).toBeLessThan(list.indexOf("Write file"));
  });

  it("distinguishes a daemon-audited action from a provider report without relying on colour", () => {
    const html = renderView({
      entries: [
        entry({ id: "a1", seq: 1, origin: "DAEMON_AUDITED", label: "READ_FILE" }),
        entry({
          id: "a2",
          seq: 1,
          origin: "PROVIDER_REPORTED",
          kind: "AGENT_TEXT",
          label: null,
          detail: "Investigating the failing test",
          status: null,
        }),
      ],
      expanded: true,
    });

    // Both origins are their own always-visible text, present alongside a `data-origin` attribute
    // rather than only a colour -- a colour-blind or greyscale reading loses nothing.
    expect(html).toContain("Verified by Loomrail");
    expect(html).toContain("As reported by the provider");
    expect(html).toContain('data-origin="DAEMON_AUDITED"');
    expect(html).toContain('data-origin="PROVIDER_REPORTED"');
  });

  it("says plainly when earlier entries were dropped, rather than showing a silent hole", () => {
    const withoutOmission = renderView({ entries: [entry()], expanded: true, omittedCount: 0 });
    const withOmission = renderView({ entries: [entry()], expanded: true, omittedCount: 12 });

    expect(withoutOmission).not.toContain("dropped");
    expect(withOmission).toContain("12");
    expect(withOmission).toContain("dropped");
  });

  it("says plainly when the feed is degraded, visible even while collapsed", () => {
    const collapsedHealthy = renderView({ degraded: false });
    const collapsedDegraded = renderView({ degraded: true });
    const expandedDegraded = renderView({ degraded: true, entries: [entry()], expanded: true });

    expect(collapsedHealthy).not.toContain("Incomplete");
    // A recorder failure must not look like a quiet run -- so it is visible before the owner ever
    // expands the section, not only once they go looking.
    expect(collapsedDegraded).toContain("Incomplete");
    expect(expandedDegraded).toContain("This feed is incomplete");
  });

  it("says plainly when the page restarted from the window start because the cursor pointed at pruned data", () => {
    const withoutGap = renderView({ entries: [entry()], expanded: true, gap: false });
    const withGap = renderView({ entries: [entry()], expanded: true, gap: true });

    expect(withoutGap).not.toContain("pruned");
    expect(withGap).toContain("pruned");
  });

  it("renders provider text as text, not as markup", () => {
    const html = renderView({
      entries: [
        entry({
          detail: "<img src=x onerror=alert(1)>",
          failureCode: null,
          kind: "AGENT_TEXT",
          label: null,
          origin: "PROVIDER_REPORTED",
          status: null,
        }),
      ],
      expanded: true,
    });

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("falls back to the Agent Fleet hint when no entry has been loaded yet", () => {
    const html = renderView({
      collapsedAction: { label: "pnpm test", origin: "PROVIDER_REPORTED" },
      entries: [],
    });

    expect(html).toContain("pnpm test");
    expect(html).toContain("As reported by the provider");
  });

  it("prefers the Agent Fleet hint over an already-loaded entry, since only the hint is newest-first", () => {
    const html = renderView({
      collapsedAction: { label: "pnpm test", origin: "PROVIDER_REPORTED" },
      entries: [entry({ label: "READ_FILE" })],
    });

    expect(html).toContain("pnpm test");
    expect(html).not.toContain("Read file");
  });

  it("shows a neutral empty state instead of a fabricated count when nothing is known yet", () => {
    const html = renderView({ entries: [] });

    expect(html).toContain("No run activity recorded yet");
    expect(html).not.toContain('run-activity__count"');
  });
});
