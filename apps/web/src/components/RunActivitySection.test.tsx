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
  agentRunId: "run-1",
  stage: "IMPLEMENT",
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
        loadingMore={false}
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

  // Spec 128: "записи сгруппированы по прогону, каждая группа названа стадией и порядковым номером
  // прогона". Two runs, each contributing consecutive entries -- the grouping guard this exercises
  // is "one group per run, headed by that run's own stage and ordinal", not merely "every entry
  // renders somewhere". A mutant that labelled every group with the FIRST entry's stage (instead of
  // each group's own) would still pass every other test in this file but fails this one, because
  // "Review" would never appear at all.
  it("groups consecutive entries by run, each group named by its own run's stage and ordinal", () => {
    const html = renderView({
      entries: [
        entry({ id: "a1", seq: 1, agentRunId: "run-1", stage: "IMPLEMENT", label: "READ_FILE" }),
        entry({ id: "a2", seq: 2, agentRunId: "run-1", stage: "IMPLEMENT", label: "WRITE_FILE" }),
        entry({ id: "a3", seq: 1, agentRunId: "run-2", stage: "REVIEW", label: "LIST_DIRECTORY" }),
      ],
      expanded: true,
    });

    expect((html.match(/run-activity__group"/g) ?? []).length).toBe(2);
    expect(html).toContain("Run 1");
    expect(html).toContain("Run 2");
    // Scoped to the expanded entry LIST, not the collapsed summary above it -- the summary
    // legitimately previews the task's latest action (here, also "List directory") ahead of the
    // list, for an unrelated reason (see the "collapses to the latest action" tests below).
    const list = html.slice(html.indexOf("run-activity__entries"));
    expect(list).toContain("Implementation");
    expect(list).toContain("Review");
    // The stage heading for run-2's group must appear before run-2's own entry and after both of
    // run-1's -- proving the heading text sits with the right group, not just present somewhere.
    const implementationIndex = list.indexOf("Implementation");
    const reviewIndex = list.indexOf("Review");
    const readIndex = list.indexOf("Read file");
    const writeIndex = list.indexOf("Write file");
    const listDirectoryIndex = list.indexOf("List directory");
    expect(implementationIndex).toBeLessThan(readIndex);
    expect(writeIndex).toBeLessThan(reviewIndex);
    expect(reviewIndex).toBeLessThan(listDirectoryIndex);
  });

  // The spec's grouping rule is "consecutive entries sharing an agentRunId", not "every entry
  // sharing an agentRunId, wherever it appears". A naive `groupBy(agentRunId)` implementation would
  // fuse the two run-1 spans below back into one group and print "Run 1" once; this fixture can only
  // pass if the grouping walks the list in order and starts a new group the moment run-2's entry
  // interrupts run-1's own run. The ordinal itself, though, stays keyed by agentRunId (not by which
  // group instance it is) -- both run-1 groups must say "Run 1", never "Run 1" and "Run 3".
  it("starts a new group when the same run's entries are not consecutive, but keeps its ordinal stable", () => {
    const html = renderView({
      entries: [
        entry({ id: "a1", seq: 1, agentRunId: "run-1", stage: "IMPLEMENT", label: "READ_FILE" }),
        entry({ id: "a2", seq: 1, agentRunId: "run-2", stage: "REVIEW", label: "LIST_DIRECTORY" }),
        entry({ id: "a3", seq: 2, agentRunId: "run-1", stage: "IMPLEMENT", label: "WRITE_FILE" }),
      ],
      expanded: true,
    });

    expect((html.match(/run-activity__group"/g) ?? []).length).toBe(3);
    expect((html.match(/Run 1/g) ?? []).length).toBe(2);
    expect(html).not.toContain("Run 3");
  });

  // "Свёрнутая сводка показывает последнее действие по задаче" -- across the whole task, not just
  // the earliest run's own tail. Without a live Agent Fleet hint, the collapsed summary falls back
  // to the merged feed's own last entry; this fixture makes that entry belong to the SECOND run, so
  // a container-level regression that scoped the summary to only the first/current run's entries
  // (the bug this task fixes) would show "Write file" here instead of "List directory".
  it("collapses to the latest action across the whole task, not one run's own tail", () => {
    const html = renderView({
      entries: [
        entry({ id: "a1", seq: 1, agentRunId: "run-1", stage: "IMPLEMENT", label: "READ_FILE" }),
        entry({ id: "a2", seq: 2, agentRunId: "run-1", stage: "IMPLEMENT", label: "WRITE_FILE" }),
        entry({ id: "a3", seq: 1, agentRunId: "run-2", stage: "REVIEW", label: "LIST_DIRECTORY" }),
      ],
    });

    expect(html).toContain("List directory");
    expect(html).not.toContain("Write file");
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

  // The test above sets `label: null`, which routes the entry's text into the *heading* sink
  // (`entryHeading` falls back to `detail` only when `label` is empty) and leaves `detail: null` --
  // so it never exercises the `run-activity__entry-detail` <p> at all. A non-null `label` keeps
  // `detail` in play as its own sink, and PROVIDER_REPORTED `status` is a third, separate one
  // (`entryStatus` returns it raw, unlike a DAEMON_AUDITED row's `workspaceTool.status.*` lookup).
  // Verified by mutation in this session (see task-9-report.md): swapping either sink's `{value}`
  // for `dangerouslySetInnerHTML={{ __html: value }}` fails exactly this test and no others.
  it("renders provider detail and status as text too, not only the heading", () => {
    const html = renderView({
      entries: [
        entry({
          detail: "<img src=x onerror=alert(2)>",
          failureCode: null,
          kind: "TOOL_CALL",
          label: "pnpm test",
          origin: "PROVIDER_REPORTED",
          status: "<script>window.hacked=true</script>",
        }),
      ],
      expanded: true,
    });

    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;script&gt;window.hacked=true&lt;/script&gt;");
    expect(html).not.toContain("<script>window.hacked=true</script>");
  });

  // The collapsed Fleet-hint label (`collapsedActionLabel`) is a fourth sink, structurally
  // separate from every per-entry one above: it never goes through `RunActivityEntryRow` at all.
  // Verified by mutation in this session: swapping its `{summary.label}` for
  // `dangerouslySetInnerHTML` fails only this test.
  it("renders the collapsed Agent Fleet hint as text too, not as markup", () => {
    const html = renderView({
      collapsedAction: { label: "<img src=x onerror=alert(3)>", origin: "PROVIDER_REPORTED" },
      entries: [],
    });

    expect(html).toContain("&lt;img src=x onerror=alert(3)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(3)>");
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

  // Fix round 1, item 4: a finished run has no live Agent Fleet entry, so the headline falls back
  // to the merged feed's own last *loaded* entry -- the tail of an oldest-first page. For a run
  // longer than one page that row is simply not the latest action, and presenting it as one would
  // be false. `hasMore` is exactly the signal that more of the feed exists beyond what was loaded.
  it("does not claim a loaded-but-unconfirmed entry is the latest action when more of the feed exists", () => {
    const html = renderView({
      entries: [entry({ label: "READ_FILE" })],
      hasMore: true,
    });

    expect(html).toContain("Read file");
    expect(html).toContain("more recent activity may exist");
  });

  it("makes no such qualification once the whole feed has been loaded", () => {
    const html = renderView({
      entries: [entry({ label: "READ_FILE" })],
      hasMore: false,
    });

    expect(html).not.toContain("more recent activity may exist");
  });

  it("makes no such qualification when the Agent Fleet hint is the confirmed newest-first source", () => {
    const html = renderView({
      collapsedAction: { label: "pnpm test", origin: "PROVIDER_REPORTED" },
      entries: [],
      hasMore: true,
    });

    expect(html).not.toContain("more recent activity may exist");
  });

  // Fix round 1, item 6: a failed or in-flight "Show more" must be visible on the button itself,
  // not conflated with the initial-page `loading` flag (which stays false while paging forward).
  it("shows the Show more button busy while a next page is fetching, not the initial-load flag", () => {
    const html = renderView({
      entries: [entry()],
      expanded: true,
      hasMore: true,
      loading: false,
      loadingMore: true,
    });

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("run-activity__skeleton");
  });

  // Fix round 1, item 7: a failed "Show more" sets `error` while the already-loaded entries are
  // still held in `data` -- the recovery affordance must render alongside that list, never blank
  // it out from under the owner who is already reading it.
  it("keeps already-loaded entries visible alongside a failed Show more, instead of blanking the list", () => {
    const html = renderView({
      entries: [entry({ label: "READ_FILE" })],
      error: new Error("The local daemon could not be reached"),
      expanded: true,
      hasMore: true,
    });

    expect(html).toContain("Read file");
    expect(html).toContain("run-activity__entries");
    expect(html).toContain("The local daemon could not be reached");
    expect(html).not.toContain("No run activity recorded yet");
  });

  it("shows only the recovery panel, not a fabricated empty state, when the very first load fails", () => {
    const html = renderView({
      entries: [],
      error: new Error("The local daemon could not be reached"),
      expanded: true,
    });

    expect(html).toContain("The local daemon could not be reached");
    // The collapsed summary's own "nothing known yet" text is unrelated and still correct here;
    // what must not appear is the *body*'s empty-state paragraph fabricating "no activity" right
    // next to a recovery panel explaining that the read itself failed.
    expect(html).not.toContain('class="inspector-copy"');
    expect(html).not.toContain("run-activity__entries");
  });
});
