import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectProviderAllowanceResponse } from "@loomrail/contracts";

import { I18nProvider } from "../i18n";
import { ProviderAllowanceStrip } from "./ProviderAllowanceStrip";

const liveResponse: ProjectProviderAllowanceResponse = {
  schemaVersion: 1,
  projectId: "project-web",
  effectiveProvider: "CODEX",
  current: {
    schemaVersion: 1,
    provider: "CODEX",
    observedAt: "2026-09-04T18:00:00.000Z",
    freshness: "LIVE",
    buckets: [
      {
        id: "primary",
        name: null,
        kind: "PRIMARY",
        usedPercent: 38,
        remainingPercent: 62,
        windowDurationMins: 300,
        resetsAt: "2026-09-04T20:00:00.000Z",
        limitReached: false,
      },
    ],
    unavailableReason: null,
  },
  advisory: { status: "LOW_CAPACITY", deferUntil: "2026-09-04T20:00:00.000Z" },
  providers: [
    {
      schemaVersion: 1,
      provider: "CODEX",
      observedAt: "2026-09-04T18:00:00.000Z",
      freshness: "LIVE",
      buckets: [
        {
          id: "primary",
          name: null,
          kind: "PRIMARY",
          usedPercent: 38,
          remainingPercent: 62,
          windowDurationMins: 300,
          resetsAt: "2026-09-04T20:00:00.000Z",
          limitReached: false,
        },
      ],
      unavailableReason: null,
    },
    {
      schemaVersion: 1,
      provider: "CLAUDE_CODE",
      observedAt: "2026-09-04T18:00:00.000Z",
      freshness: "UNAVAILABLE",
      buckets: [],
      unavailableReason: "DATA_NOT_PRESENT",
    },
  ],
};

const renderStrip = (
  response: ProjectProviderAllowanceResponse | null = liveResponse,
  options: { error?: Error | null; loading?: boolean; refreshing?: boolean } = {},
): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProviderAllowanceStrip
        error={options.error ?? null}
        loading={options.loading ?? false}
        onRefresh={vi.fn()}
        refreshing={options.refreshing ?? false}
        response={response ?? undefined}
        surface="command-center"
      />
    </I18nProvider>,
  );

describe("ProviderAllowanceStrip", () => {
  it("does not render an unresolved time placeholder when a low-capacity hint has no reset", () => {
    const html = renderStrip({
      ...liveResponse,
      advisory: { status: "LOW_CAPACITY", deferUntil: null },
    });

    expect(html).toContain("Check again before starting new work");
    expect(html).not.toContain("{time}");
  });

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
  });

  it("labels remaining, window, reset, freshness and used detail without a bare percentage", () => {
    const html = renderStrip();

    expect(html).toContain("Codex · Provider allowance");
    expect(html).toContain("Live");
    expect(html).toContain("62% remaining");
    expect(html).toContain("5 h window");
    expect(html).toContain("Resets");
    expect(html).toContain("38% used");
    expect(html).not.toMatch(/>38%<\/[^>]+>/);
  });

  it("localizes the same explicit labels in Russian", () => {
    window.localStorage.setItem("loomrail.locale", "ru");
    const html = renderStrip();

    expect(html).toContain("Codex · Лимит провайдера");
    expect(html).toContain("Актуально");
    expect(html).toContain("62% осталось");
    expect(html).toContain("окно 5 ч");
    expect(html).toContain("38% использовано");
  });

  it("keeps the last snapshot visible while reporting a failed refresh", () => {
    const html = renderStrip(liveResponse, { error: new Error("network") });

    expect(html).toContain("62% remaining");
    expect(html).toContain("The new check failed. The last reading is still shown.");
    expect(html).toContain('role="alert"');
  });

  it("exposes a named loading state and disables refresh until the first read completes", () => {
    const html = renderStrip(null, { loading: true });

    expect(html).toContain("Loading provider allowance");
    expect(html).toContain("disabled");
    expect(html).toContain("Provider · Provider allowance");
  });
});
