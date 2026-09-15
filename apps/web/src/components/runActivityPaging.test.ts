import { describe, expect, it } from "vitest";
import type { AgentRunActivityPage, WorkItem, WorkflowSnapshot } from "@loomrail/contracts";

import { anyPageHasGap, anyPageIsDegraded, hasStartedWorkflow } from "./runActivityPaging";

// Fix round 1: `gap` is per-page -- set on the page that ran into one of its two causes (a cursor
// naming a position no longer held, or a source coming back at its read-ahead cap on a page that
// still ended) -- not task-level like `degraded`/`omittedCount`. Reading only the most recently
// loaded page's `gap` made an announced gap vanish the moment the owner loaded one more page -- the
// exact silent hole the flag exists to prevent. This is the one-line rule that fixes it, tested on
// its own.

const page = (overrides: Partial<AgentRunActivityPage> = {}): AgentRunActivityPage => ({
  entries: [],
  nextCursor: null,
  omittedCount: 0,
  degraded: false,
  gap: false,
  ...overrides,
});

describe("anyPageHasGap", () => {
  it("is false with no pages loaded", () => {
    expect(anyPageHasGap([])).toBe(false);
  });

  it("is false when no loaded page reported a gap", () => {
    expect(anyPageHasGap([page(), page(), page()])).toBe(false);
  });

  it("stays true once any loaded page reported a gap, even pages fetched after it", () => {
    // Page 1: no gap (a first page can trip neither cause). Page 2: flagged -- the cursor from page
    // 1 landed on a position no longer held, or the page ended on a source's capped window.
    // Page 3: fetched afterwards, itself not a gap -- but the announcement must not disappear
    // because of it.
    expect(anyPageHasGap([page({ gap: false }), page({ gap: true }), page({ gap: false })])).toBe(true);
  });
});

// Fix round 1 on Task 5: `degraded` needs the same rule for the same reason. It is mostly a
// task-level fact, which is why the container read it off the last loaded page alone, but the route
// ORs two per-page facts into it (a run whose stage would not resolve; audited rows for a run with no
// live provider), so the last page alone can un-announce a warning an earlier page raised.
describe("anyPageIsDegraded", () => {
  it("is false with no pages loaded", () => {
    expect(anyPageIsDegraded([])).toBe(false);
  });

  it("is false when no loaded page reported degradation", () => {
    expect(anyPageIsDegraded([page(), page(), page()])).toBe(false);
  });

  it("stays true once any loaded page reported degradation, even pages fetched after it", () => {
    expect(
      anyPageIsDegraded([page({ degraded: false }), page({ degraded: true }), page({ degraded: false })]),
    ).toBe(true);
  });
});

// Fix round 1 on Task 3: this predicate is the whole of RunActivitySection's "never started"
// gate (`if (!hasStartedWorkflow(item, workflowQuery.data)) return null;`), pulled out so the
// boolean logic itself has a test. The container that wires it in is covered too, by fix round 2 on
// Task 3: the `describe("RunActivitySection")` cases in RunActivitySection.test.tsx render the real
// container through a hoisted `vi.mock("../workspace")`, so neither half of the gate rests on a live
// e2e run any more.
describe("hasStartedWorkflow", () => {
  const item = (currentStage: WorkItem["currentStage"]): Pick<WorkItem, "currentStage"> => ({
    currentStage,
  });
  const snapshot = (run: WorkflowSnapshot["run"]): Pick<WorkflowSnapshot, "run"> => ({ run });
  // Only its existence is read by the gate; the fields are filler a real PipelineRun needs to
  // satisfy the type. `status: "CANCELLED"` is the shape that matters: this is what a task that ran
  // and was then cancelled looks like.
  const cancelledPipelineRun = (): WorkflowSnapshot["run"] => ({
    schemaVersion: 1,
    id: "pipeline-run-1",
    projectId: "project-1",
    workItemId: "item-1",
    workflowTemplateId: "workflow-template-1",
    workflowVersion: 1,
    status: "CANCELLED",
    currentStageAttemptId: "stage-attempt-1",
    version: 2,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T11:00:00.000Z",
    finishedAt: "2026-09-14T11:00:00.000Z",
  });

  // This is also the "cancelled before it ever ran" case, which `state === "CANCELLED"` would have
  // got wrong as a stand-in signal: `decideMove` (packages/domain/src/index.ts) allows
  // BACKLOG -> CANCELLED directly, and such a task reaches CANCELLED with no pipeline run at all.
  it("is false for a WorkItem that has never started its pipeline", () => {
    expect(hasStartedWorkflow(item(null), snapshot(null))).toBe(false);
  });

  it("is true once currentStage is set, including a stage this WorkItem has since moved past", () => {
    // The gate does not care WHICH stage -- only that the pipeline has started at all -- so a
    // fixture with a non-initial stage ("QA", not "DISCOVERY") proves this isn't accidentally
    // checking for one specific stage value. The snapshot says "never ran" here, so this also pins
    // that `currentStage` alone is sufficient and needs no snapshot to agree with it.
    expect(hasStartedWorkflow(item("QA"), snapshot(null))).toBe(true);
  });

  // The defect this second signal exists for, and the case that makes the fixture discriminating:
  // `currentStage` is null while a pipeline run exists, so only a gate reading BOTH answers true.
  // Three CANCEL decisions in packages/domain (qa-correction.ts:decideQACorrectionGate,
  // verification-correction.ts's two correction gates) put `currentStage` back to `null` on a task
  // that has run a whole pipeline, so on `currentStage` alone every cancelled task lost its entire
  // Run Activity section. The `pipeline_runs` row survives the cancel -- nothing in
  // packages/persistence-sqlite deletes from that table -- and is what says the task did run.
  it("is true for a cancelled WorkItem whose currentStage was cleared but which has a pipeline run", () => {
    expect(hasStartedWorkflow(item(null), snapshot(cancelledPipelineRun()))).toBe(true);
  });

  it("is false while the workflow snapshot has not loaded yet, rather than flashing an empty card", () => {
    expect(hasStartedWorkflow(item(null), undefined)).toBe(false);
  });
});
