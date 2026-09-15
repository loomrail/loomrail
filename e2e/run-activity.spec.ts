import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProviderAdapter } from "../packages/provider-core/dist/index.js";

import { passingBrowserQADriver } from "../apps/daemon/test/browser-qa-fixture.js";
import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

/**
 * Task 11: the browser-level proof that the Run Activity section (Tasks 9-10) behaves the way an
 * owner actually experiences it -- an already-rendered entry list growing because a signal arrived
 * over the event channel (Tasks 1-6), never reloaded for and never merely a fresh query's own first
 * fetch (review round 1's finding: an earlier version of this test proved only that); the section
 * starting collapsed and opening only on the owner's own click; and one daemon-audited workspace
 * action rendered exactly once across the whole Cockpit, never duplicated into the Activity timeline
 * the way review round 1 also found.
 *
 * New file rather than an addition to walking-skeleton.spec.ts or event-channel.spec.ts, for the
 * same reason Task 9's own event-channel.spec.ts gave (task-9-brief decision #4): a concurrent
 * session edits those files, and `initializeWorkspace`/`createTask`/`workflowSectionOf`/
 * `readyForBudgetApproval` below are small, deliberate copies of the same-named helpers there
 * rather than an import of that module -- a `.spec.ts` imported for its helpers still runs its own
 * `test.describe` a second time as a side effect of loading it.
 */

let daemon: RunningDaemon | undefined;

test.afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const DEMO_INITIALISATION_MS = 20_000;
const DISCOVERY_DECISION_MS = 20_000;

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible({
    timeout: DEMO_INITIALISATION_MS,
  });
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled({
    timeout: DEMO_INITIALISATION_MS,
  });
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const submit = dialog.getByRole("button", { name: "Create task" });
  await expect(submit).toBeDisabled();
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Exercise the Run Activity section against a real workspace write.");
  await dialog
    .getByPlaceholder("The owner can verify the delivered outcome…")
    .fill("The audited write appears in Run Activity exactly once.");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

const workflowSectionOf = (page: Page, inspector: Locator): Locator =>
  inspector.locator(".lr-inspector-section").filter({ has: page.getByText("Workflow", { exact: true }) });

// `exact: true` is load-bearing here: "Run Activity" is itself a text node inside a DIFFERENT
// `.lr-inspector-section`, and a non-exact match on "Activity" would match both sections' headers.
const runActivitySectionOf = (page: Page, inspector: Locator): Locator =>
  inspector.locator(".lr-inspector-section").filter({ has: page.getByText("Run Activity", { exact: true }) });

const activityTimelineSectionOf = (page: Page, inspector: Locator): Locator =>
  inspector.locator(".lr-inspector-section").filter({ has: page.getByText("Activity", { exact: true }) });

const openWorkbench = async (page: Page, title: string, adapter: ProviderAdapter): Promise<Locator> => {
  daemon = await startDaemon({
    bootstrapToken: randomBytes(32).toString("base64url"),
    logger: false,
    webRoot: resolve("apps/web/dist"),
    browserQADriver: passingBrowserQADriver(),
    providerAdapter: adapter,
  });
  await page.goto(daemon.bootstrapUrl);
  await initializeWorkspace(page);
  await createTask(page, title);
  return page.getByRole("complementary", { name: title });
};

/**
 * A second page onto the same daemon and the same task, opened purely to look at it. It never
 * submits a mutation of its own, so its react-query cache (staleTime 30s, no refetch-on-focus, no
 * polling -- apps/web/src/App.tsx) can only move when its own channel connection tells it to. Copied
 * from event-channel.spec.ts's own helper of the same name -- the whole point of this test is that
 * property, applied to Run Activity instead of Workflow.
 */
const openObserver = async (page: Page, title: string): Promise<Locator> => {
  if (!daemon) throw new Error("openObserver called before openWorkbench started a daemon");
  await page.goto(daemon.baseUrl);
  await page.getByRole("button", { name: "All issues", exact: true }).click();
  await page.getByRole("button", { name: title }).click();
  return page.getByRole("complementary", { name: title });
};

const BUDGET_WALL_MS = 20_000;

const readyForBudgetApproval = async (page: Page, inspector: Locator): Promise<Locator> => {
  await inspector.getByRole("button", { name: "Move to Ready" }).click();
  await expect(inspector.getByRole("button", { name: "Start workflow" })).toBeEnabled();
  await inspector.getByLabel("Hard token budget").fill("100");
  await inspector.getByLabel("Per-agent run ceiling").fill("100");
  await inspector.getByRole("button", { name: "Start workflow" }).click();
  await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible({
    timeout: DISCOVERY_DECISION_MS,
  });
  await inspector.getByRole("radio", { name: /Focused pass/ }).click();
  await inspector.getByRole("button", { name: "Answer & resume" }).click();

  const workflowSection = workflowSectionOf(page, inspector);
  await expect(workflowSection.getByText("Budget paused", { exact: true }).first()).toBeVisible({
    timeout: BUDGET_WALL_MS,
  });
  await expect(workflowSection.getByText("100 of 100", { exact: true })).toBeVisible();
  return workflowSection;
};

/** The text of the second, PROVIDER_REPORTED entry -- see `runActivityAdapter` below. */
const SECOND_ACTIVITY_TEXT = "Reviewing the audited write before handing off.";

/**
 * Scripted like `provider-double.ts`'s own DISCOVERY/IMPLEMENT-attempt-1 shape (so the shared
 * `readyForBudgetApproval` helper above still applies unmodified), but IMPLEMENT's retry performs
 * one REAL audited write through the bounded workspace-tool gateway (`invocation.workspaceTools`,
 * the same seam `review-loop.spec.ts`'s adapter uses), then -- once the test releases the returned
 * gate -- reports a SECOND, PROVIDER_REPORTED action directly through `listener.onActivity` before
 * pausing with its own NEEDS_HUMAN instead of chaining straight through REVIEW/QA/ACCEPTANCE.
 *
 * The gate is what makes this a real append-to-an-already-rendered-list proof rather than a
 * new-query's-first-fetch proof: review round 1 found that reporting both actions up front only
 * proves a freshly mounted query's first fetch already has the data (true regardless of the event
 * channel, since React Query fetches an `enabled` query on mount with no invalidation involved) --
 * never the live-update path an OWNER actually watches for, where an already-fetched list grows
 * because a signal arrived. Releasing the gate only after the test has confirmed the first entry is
 * on screen forces the second one to depend on that live path -- and a PROVIDER_REPORTED entry
 * specifically, because it appends no domain Event (unlike the audited write's
 * WORKSPACE_TOOL_CALL_CHANGED) and therefore depends solely on session-loop.ts's own direct
 * `publishActivitySignal`, not on `broadcastingState`'s generic per-Event publish.
 *
 * The pause after both actions is load-bearing, not incidental: `RunActivitySection` reads the
 * WorkItem's *current* stage attempt (spec: mirrors `AttemptSessionsPanel`), and the scripted
 * double's usual REVIEW -> QA -> ACCEPTANCE chain resolves synchronously -- fast enough that by the
 * time an assertion could observe IMPLEMENT's own AgentRun, `currentStageAttemptId` would already
 * have moved to ACCEPTANCE's fresh, empty one. Pausing keeps IMPLEMENT "current" for exactly as long
 * as this test needs it to be.
 */
const runActivityAdapter = (): { adapter: ProviderAdapter; releaseSecondActivity: () => void } => {
  let release: () => void = () => undefined;
  const secondActivityGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: ProviderAdapter = {
    capabilities: () => ({
      provider: "CODEX",
      start: true,
      interrupt: true,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      costReporting: false,
      tokenBudgetEnforcement: "HARD",
    }),
    start: async (invocation, listener) => {
      const { stage, attempt } = invocation.session;
      if (stage === "DISCOVERY" && invocation.dispatch.mode === "START") {
        return {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Choose the discovery depth",
            context: "The test delivery pipeline needs one product decision before planning.",
            recommendation: "Use the focused pass for a bounded task.",
            options: [
              {
                id: "focused-pass",
                label: "Focused pass",
                consequence: "Proceed with the smallest sufficient plan.",
                recommended: true,
              },
              {
                id: "extended-pass",
                label: "Extended pass",
                consequence: "Map additional constraints and edge cases.",
                recommended: false,
              },
            ],
            allowOther: true,
          },
        };
      }
      if (stage === "IMPLEMENT" && attempt === 1) {
        return {
          type: "BUDGET_LIMIT_REACHED",
          usageIncrements: [50, 30, 15, 5],
          quality: "LOOMRAIL_ESTIMATE",
        };
      }
      if (stage === "IMPLEMENT") {
        if (invocation.workspaceTools === undefined) throw new Error("IMPLEMENT has no workspace tools");
        const effect = await invocation.workspaceTools.execute(
          {
            callId: `${invocation.session.id}-run-activity-write`,
            operation: "WRITE_FILE",
            path: "run-activity-effect.txt",
            expectedSha256: null,
            content: "Audited implementation effect for the Run Activity E2E canary.\n",
          },
          invocation.authoritySignal,
        );
        if (effect.status !== "SUCCEEDED") throw new Error(`IMPLEMENT tool failed: ${effect.code}`);
        await secondActivityGate;
        listener.onActivity?.({
          actionKey: `${invocation.session.id}-run-activity-note`,
          kind: "AGENT_TEXT",
          label: null,
          detail: SECOND_ACTIVITY_TEXT,
          status: null,
          terminal: true,
          truncated: false,
        });
        return {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Confirm before REVIEW",
            context: "Pausing here on purpose so both actions above stay the current AgentRun's activity.",
            recommendation: "Continue once the observation is done.",
            options: [
              { id: "continue", label: "Continue", consequence: "Move on to REVIEW.", recommended: true },
            ],
            allowOther: true,
          },
        };
      }
      return { type: "COMPLETED", summary: `${stage} completed for the run activity E2E.` };
    },
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  };
  return { adapter, releaseSecondActivity: release };
};

test.describe("run activity", () => {
  // Spec docs/plans/127-agent-run-activity-implementation-plan.ru.md, Task 11: one run, observed the
  // way an owner observes it. The observer page opens once, right after the actor reaches "Budget
  // paused", and is never interacted with beyond the single deliberate expand click below -- if
  // Run Activity's content changes under it afterward, only the channel could have done it.
  test("updates Run Activity live from the channel, collapsed by default, with the audited write shown exactly once", async ({
    page,
    context,
  }) => {
    const title = "Run activity live update";
    const { adapter, releaseSecondActivity } = runActivityAdapter();
    const actorInspector = await openWorkbench(page, title, adapter);
    await readyForBudgetApproval(page, actorInspector);

    const observerPage = await context.newPage();
    const observerInspector = await openObserver(observerPage, title);
    const runActivity = runActivitySectionOf(observerPage, observerInspector);
    await expect(runActivity).toBeVisible();

    // Collapsed by default: not just visually, but absent from the tree -- RunActivitySection.tsx
    // keeps the whole body out of the DOM while `<details>` is closed (spec: "не становится
    // основным содержимым Cockpit"), so there is nothing here yet to find at all.
    const details = runActivity.locator("details.run-activity");
    await expect(details).toHaveJSProperty("open", false);
    await expect(runActivity.locator(".run-activity__body")).toHaveCount(0);

    // The owner's one action on this page: expand the section. Nothing else is ever clicked here.
    await runActivity.locator("summary").click();
    await expect(details).toHaveJSProperty("open", true);
    await expect(runActivity.locator(".run-activity__body")).toBeVisible();

    // The one click that starts IMPLEMENT's retry, issued on the ACTOR's page.
    const actorWorkflow = workflowSectionOf(page, actorInspector);
    await actorWorkflow.getByLabel("Hard token budget").fill("200");
    await actorWorkflow.getByRole("button", { name: "Approve cost policy" }).click();

    // Nothing is clicked on the observer page from here on: only its own channel connection can
    // move what it shows. The audited write reaching Run Activity with no reload is the live-update
    // proof this test exists for. Scoped to the expanded entry LIST, not the whole section: the
    // collapsed summary legitimately previews the same latest-action text beside the list (an
    // accordion header echoing its own content, by design -- RunActivityView's `summary`), which is
    // a different thing from the "same action, two vocabularies" defect this test actually guards.
    const entryList = runActivity.locator(".run-activity__entries");
    await expect(entryList.getByText("Write file", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(entryList.getByText("Verified by Loomrail", { exact: true })).toBeVisible();
    await expect(entryList.locator(".run-activity__entry")).toHaveCount(1);

    // The append path: the entry list above is already fetched and rendered with one row. Releasing
    // the adapter's gate now makes it report a SECOND, PROVIDER_REPORTED action -- through
    // `listener.onActivity`, the same seam a real provider CLI's stdout handler uses, which appends
    // no domain Event and so cannot ride `broadcastingState`'s per-Event publish the first entry did.
    // Nothing is clicked, navigated, or reloaded on this page for this to appear: only
    // `session-loop.ts`'s own direct `publishActivitySignal` -> the event channel -> React Query's
    // invalidation of this already-mounted query can grow the list from 1 to 2. A query's very first
    // fetch (review round 1's finding: what the earlier version of this test actually proved, since a
    // freshly mounted query fetches on enablement with no invalidation involved at all) cannot be
    // mistaken for this, because there is no second mount here -- the same query grows in place.
    releaseSecondActivity();
    await expect(entryList.locator(".run-activity__entry")).toHaveCount(2, { timeout: 10_000 });
    await expect(entryList.getByText(SECOND_ACTIVITY_TEXT, { exact: true })).toBeVisible();
    await expect(entryList.getByText("As reported by the provider", { exact: true })).toBeVisible();

    // Exactly once IN THE LIST (task-11-brief): review round 1 found the very same audited action
    // rendered a second time, in a second vocabulary, in the Activity timeline.
    await expect(entryList.getByText("Write file", { exact: true })).toHaveCount(1);

    // The lifecycle Activity timeline is a different section with its own history, still present,
    // just never carrying this audited action (workItemTimeline.ts excludes
    // WORKSPACE_TOOL_CALL_CHANGED from it entirely -- Run Activity is its sole home now).
    const activityTimeline = activityTimelineSectionOf(observerPage, observerInspector);
    await expect(activityTimeline).toBeVisible();
    await expect(activityTimeline.getByText("Write file", { exact: true })).toHaveCount(0);
  });
});
