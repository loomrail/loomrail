import { describe, expect, it } from "vitest";

import { renderSection } from "../src/index.js";
import { sampleSources } from "./fixtures.js";

describe("section rendering", () => {
  it("renders the same bytes for the same input", () => {
    const first = renderSection("WORK_ITEM_BRIEF", sampleSources());
    const second = renderSection("WORK_ITEM_BRIEF", sampleSources());
    expect(first.text).toBe(second.text);
    expect(first.bytes).toBe(Buffer.byteLength(first.text, "utf8"));
  });

  it("uses LF regardless of the host platform", () => {
    // Windows иначе даст другой хеш при том же состоянии, и аудит разойдётся между машинами.
    const rendered = renderSection("WORK_ITEM_BRIEF", sampleSources());
    expect(rendered.text).not.toContain("\r");
  });

  it("marks a checkpoint as untrusted provider output", () => {
    // Спек §8: checkpoint попадает в контекст следующей сессии и переживает смену провайдера.
    const rendered = renderSection("LATEST_CHECKPOINT", sampleSources());
    expect(rendered.text).toContain("BEGIN UNTRUSTED AGENT REPORT");
    expect(rendered.text).toContain("END UNTRUSTED AGENT REPORT");
  });

  it("renders an absent checkpoint as an explicit absence, not as emptiness", () => {
    const rendered = renderSection("LATEST_CHECKPOINT", { ...sampleSources(), latestCheckpoint: null });
    expect(rendered.text).toContain("No checkpoint has been published for this attempt yet.");
    expect(rendered.source).toBeNull();
  });

  it("counts bytes, not characters", () => {
    // Не-ASCII содержимое обязано считаться в байтах: бюджет окна измеряется не символами.
    const sources = sampleSources();
    const rendered = renderSection("WORK_ITEM_BRIEF", {
      ...sources,
      workItemBrief: { ...sources.workItemBrief, title: "Задача" },
    });
    expect(rendered.bytes).toBeGreaterThan(rendered.text.length - 20);
  });
});
