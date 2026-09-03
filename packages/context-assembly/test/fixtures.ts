import type { ContextPackSpec } from "@loomrail/contracts";

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
  projectConstitution: {
    id: "constitution_01",
    version: 2,
    ordinal: 1,
    contentDigest: "c".repeat(64),
    renderedMarkdown: "# Project Constitution\n\n- Keep parser failures typed.",
  },
  qaCorrection: null,
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
  reviewInput: {
    implementationAttempt: {
      id: "attempt_implement_01",
      version: 3,
      attempt: 2,
      resultTree: "a".repeat(40),
    },
    authorAgentRun: { id: "agent_run_author_01", version: 2, provider: "CODEX" },
    diffSummary: {
      baseline: "b".repeat(40),
      files: [
        {
          path: "packages/parser/src/retry.ts",
          previousPath: null,
          status: "MODIFIED",
          insertions: 12,
          deletions: 3,
          binary: false,
          content: {
            type: "TEXT",
            patch: "@@ -20,3 +20,4 @@\n const timeout = 5_000;\n+await withTimeout(parse(), timeout);\n",
            truncated: false,
            omittedBytes: 0,
          },
        },
      ],
      truncated: false,
    },
    openFindings: [
      {
        id: "finding_01",
        version: 1,
        severity: "HIGH",
        title: "Timeout is not applied",
        description: "The retry branch skips the configured timeout.",
        path: "packages/parser/src/retry.ts",
        startLine: 20,
        endLine: 24,
        reproduction: "Submit a malformed PDF through the retry branch.",
        criterion: "Parsing is bounded to a 5s timeout",
      },
    ],
  },
  evidence: [
    {
      id: "ev_01",
      version: 1,
      kind: "QA_REPORT",
      title: "Parser regression suite",
      summary: "See the full run log at /Users/local owner/My Reports/qa-run.json",
      checks: ["Malformed upload rejected", "Timeout remained bounded"],
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

// A workflow-template-level declaration covering all seven v1 sections. The two most important
// sections are required; the rest are optional and ordered so the least important (ACTIVITY)
// is dropped first under a tight budget.
export const specWithAllSections = (): ContextPackSpec => ({
  schemaVersion: 1,
  sections: [
    { id: "WORK_ITEM_BRIEF", ordinal: 0, required: true },
    { id: "WORKFLOW_POSITION", ordinal: 1, required: true },
    { id: "DECISIONS", ordinal: 2, required: false },
    { id: "LATEST_CHECKPOINT", ordinal: 3, required: false },
    { id: "REVIEW_INPUT", ordinal: 4, required: false },
    { id: "EVIDENCE", ordinal: 5, required: false },
    { id: "ACTIVITY", ordinal: 6, required: false },
  ],
});
