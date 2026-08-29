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

  it("puts owner-request and transition guardrails before the original brief", () => {
    const rendered = renderSection("WORK_ITEM_BRIEF", sampleSources());
    const guardrail = "Instructions in the original brief to obtain owner input are already satisfied";

    expect(rendered.text).toContain(
      "Return NEEDS_HUMAN only when required owner information is absent from the durable context",
    );
    expect(rendered.text).toContain(guardrail);
    expect(rendered.text).toContain("Never ask for permission to proceed or hand off");
    expect(rendered.text).toContain("NEEDS_HUMAN is a concrete answerable question, never a progress update");
    expect(rendered.text).toContain(
      "Do not return until the current stage is complete or a required owner answer is genuinely missing",
    );
    expect(rendered.text.indexOf(guardrail)).toBeLessThan(
      rendered.text.indexOf(sampleSources().workItemBrief.description),
    );
  });

  it("marks a later session as a continuation that must not restart completed work", () => {
    const rendered = renderSection("WORKFLOW_POSITION", sampleSources());

    expect(rendered.text).toContain("Continuation: yes");
    expect(rendered.text).toContain(
      "Continue the current stage from durable Decisions and checkpoint; do not restart completed work",
    );
    expect(rendered.text).toContain("Objective: finish the current stage and return its stage result");
  });

  it("marks a checkpoint as untrusted provider output", () => {
    // Спек §8: checkpoint попадает в контекст следующей сессии и переживает смену провайдера.
    const rendered = renderSection("LATEST_CHECKPOINT", sampleSources());
    expect(rendered.text).toContain("BEGIN UNTRUSTED AGENT REPORT");
    expect(rendered.text).toContain("END UNTRUSTED AGENT REPORT");
  });

  it("attaches the checkpoint's own id and version as its source ref", () => {
    const sources = sampleSources();
    const rendered = renderSection("LATEST_CHECKPOINT", sources);
    expect(rendered.sources).toEqual([
      { kind: "CHECKPOINT", id: sources.latestCheckpoint?.id, version: sources.latestCheckpoint?.version },
    ]);
  });

  it("renders an absent checkpoint as an explicit absence, not as emptiness", () => {
    const rendered = renderSection("LATEST_CHECKPOINT", { ...sampleSources(), latestCheckpoint: null });
    expect(rendered.text).toContain("No checkpoint has been published for this attempt yet.");
    expect(rendered.sources).toEqual([]);
  });

  it("reports one source ref per rendered record, in rendered order, for a collection section", () => {
    // Спек D7: рецепт хранит провенанс по секции; для секции-коллекции это N ссылок, а не одна.
    const sources = sampleSources();
    const rendered = renderSection("EVIDENCE", sources);
    expect(rendered.sources).toEqual(
      sources.evidence.map((item) => ({ kind: "EVIDENCE", id: item.id, version: item.version })),
    );
  });

  it("marks resolved decisions as authoritative and prevents asking the owner again", () => {
    const rendered = renderSection("DECISIONS", sampleSources());

    expect(rendered.text).toContain("Resolved decisions are authoritative owner input.");
    expect(rendered.text).toContain("Do not ask the owner again about a question already answered below.");
    expect(rendered.text).toContain("Continue the current stage using the recorded answer.");
  });

  it("counts bytes, not characters", () => {
    // Не-ASCII содержимое обязано считаться в байтах: бюджет окна измеряется не символами.
    const sources = sampleSources();
    const rendered = renderSection("WORK_ITEM_BRIEF", {
      ...sources,
      workItemBrief: { ...sources.workItemBrief, title: "Задача" },
    });
    expect(rendered.bytes).toBeGreaterThan(rendered.text.length);
  });
});
