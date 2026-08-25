import type { ContextSources } from "../src/index.js";

// Synthetic slice of durable state used across render tests. Deliberately carries two
// cross-platform canaries: a non-ASCII title (byte count must diverge from character count)
// and a path containing a space (rendering must not choke on it or normalise it away).
export const sampleSources = (): ContextSources => ({
  workItemBrief: {
    id: "wi_01",
    version: 3,
    title: "Résumé pipeline hardening",
    description: "Harden the résumé parsing pipeline against malformed uploads.",
    acceptanceCriteria: [
      "Malformed PDFs are rejected with a clear error",
      "Parsing is bounded to a 5s timeout",
    ],
    priority: "HIGH",
    risk: "MEDIUM",
  },
  workflowPosition: {
    templateId: "mock-delivery-v1",
    templateVersion: 3,
    stage: "IMPLEMENT",
    attempt: 1,
    sessionOrdinal: 2,
  },
  decisions: [
    { id: "dec_01", version: 1, question: "Which parser library?", answer: "Use pdf-lib for extraction." },
  ],
  latestCheckpoint: {
    id: "chk_01",
    version: 1,
    summary: "Implemented the size guard and added a regression test.",
    completed: ["Added a 5s parsing timeout"],
    remaining: ["Wire the timeout into the retry policy"],
    deadEnds: ["Tried streaming parse; the library does not support it"],
    openQuestions: ["Should the timeout be configurable per work item?"],
  },
  evidence: [
    {
      id: "ev_01",
      version: 1,
      kind: "QA_REPORT",
      title: "Parser regression suite",
      summary: "See the full run log at /Users/local owner/My Reports/qa-run.json",
    },
  ],
  activity: [
    {
      id: "act_01",
      version: 1,
      occurredAt: "2026-08-20T10:00:00.000Z",
      description: "Opened the work item",
    },
  ],
});
