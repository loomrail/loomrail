import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { passingBrowserQADriver } from "../apps/daemon/test/browser-qa-fixture.js";
import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

/**
 * Task 9 (spec §9, milestone A1.5): the browser-level proof that a stage attempt's background
 * progress -- driven entirely by the session worker (Task 8), never by the click that started it
 * -- actually reaches the owner through the SSE channel (Tasks 1-6), and that losing the channel
 * for a while is harmless because reconnecting refetches everything (spec D3).
 *
 * New file rather than an addition to walking-skeleton.spec.ts (task-9-brief decision #4): a
 * concurrent session edits that file, and this file's tests are the only ones in the suite whose
 * subject is the channel itself. `initializeWorkspace` and `createTask` below are small, deliberate
 * copies of the same-named helpers there (decision #4) rather than an import of that module: a
 * `.spec.ts` file imported for its helpers still has its own `test.describe` run as a side effect
 * of loading it, which would register that file's 26 tests a second time under this one.
 *
 * Both new tests drive two pages sharing one BrowserContext and one daemon, on purpose. A single
 * page cannot tell apart "the board updated because the channel pushed an invalidation" from "the
 * board updated because the very mutation that started the background work also invalidates its
 * own query on success (workspace.tsx), and that follow-up GET happened to land after the
 * (near-instant, mock) background cascade had already finished". The mock provider resolves across
 * a handful of microtask ticks; a browser's own follow-up request is not reliably slower than
 * that. A single-page version of "brings a finished stage to the board without the owner touching
 * anything" would therefore keep passing even with the channel hook removed entirely, which is
 * exactly the outcome the mutation proof this task requires is supposed to catch. The observer page
 * below never issues the mutation that starts the cascade, so nothing but its own channel
 * connection (or a manual reload, which these tests never do) can move what it shows.
 */

let daemon: RunningDaemon | undefined;

test.afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

/**
 * Presses "Initialize demo workspace" and waits for it to finish.
 *
 * The wait is given more than Playwright's default because the button now does real work: each
 * bundled fixture is copied out of this checkout and given a repository of its own with a first
 * commit, which is what makes a later IMPLEMENT stage able to cut a worktree at all. On a cold
 * machine that is two `git init` plus two first commits before the projects list can render.
 */
const DEMO_INITIALISATION_MS = 20_000;

/**
 * Discovery cuts a real worktree before the mock session starts. Give that background Git path the
 * same bounded patience as the later IMPLEMENT wall without weakening what must appear.
 */
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
    .fill("Persisted through the authenticated local API.");
  await dialog
    .getByPlaceholder("The owner can verify the delivered outcome…")
    .fill("The task remains durable after reload.");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

const workflowSectionOf = (page: Page, inspector: Locator): Locator =>
  inspector.locator(".lr-inspector-section").filter({ has: page.getByText("Workflow", { exact: true }) });

/**
 * Starts a fresh daemon, opens the workbench and creates one task. Returns the actor's inspector:
 * every mutation in a test is issued through this page.
 */
const openWorkbench = async (page: Page, title: string): Promise<Locator> => {
  daemon = await startDaemon({
    bootstrapToken: randomBytes(32).toString("base64url"),
    logger: false,
    webRoot: resolve("apps/web/dist"),
    browserQADriver: passingBrowserQADriver(),
  });
  await page.goto(daemon.bootstrapUrl);
  await initializeWorkspace(page);
  await createTask(page, title);
  return page.getByRole("complementary", { name: title });
};

/**
 * A second page onto the same daemon and the same task, opened purely to look at it. It never
 * submits a mutation of its own, so its react-query cache (staleTime 30s, no refetch-on-focus, no
 * polling -- apps/web/src/App.tsx) can only move when its own channel connection tells it to.
 */
const openObserver = async (page: Page, title: string): Promise<Locator> => {
  if (!daemon) throw new Error("openObserver called before openWorkbench started a daemon");
  await page.goto(daemon.baseUrl);
  await page.getByRole("button", { name: "All issues", exact: true }).click();
  await page.getByRole("button", { name: title }).click();
  return page.getByRole("complementary", { name: title });
};

/**
 * How long a run may take to reach IMPLEMENT's budget wall.
 *
 * More than Playwright's default because IMPLEMENT is now a stage that cuts a Git worktree before
 * its first session opens -- snapshot, `worktree add`, and the repository inspection ahead of both.
 * The assertion is unchanged: the wall still has to be reached, and a run that never gets there
 * still fails here. Only the patience is different, and it is different because the work is real.
 */
const BUDGET_WALL_MS = 20_000;

/**
 * Drives the actor through every human decision the mock delivery needs before its remaining
 * stages (IMPLEMENT's retry, REVIEW, QA, ACCEPTANCE) can run unattended: Ready, start, and the
 * discovery choice. Stops with the attempt sitting at "Budget paused" so a caller can open an
 * observer, or drop its channel, before triggering the budget approval under test.
 */
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

test.describe("event channel", () => {
  // Spec §9, browser proof: work started by the owner reaches the board with nobody touching it
  // again. The observer page opens once, before the trigger below, and is never interacted with
  // after that -- if the board changes under it, only the channel could have done it.
  test("brings a finished stage to the board without the owner touching anything", async ({
    page,
    context,
  }) => {
    const title = "Delivered while nobody was looking";
    const actorInspector = await openWorkbench(page, title);
    await readyForBudgetApproval(page, actorInspector);

    const observerPage = await context.newPage();
    const observerInspector = await openObserver(observerPage, title);
    const observerWorkflow = workflowSectionOf(observerPage, observerInspector);
    await expect(observerWorkflow.getByText("Budget paused", { exact: true }).first()).toBeVisible();

    // The one click that unblocks the rest of the pipeline. Everything after IMPLEMENT's retry --
    // REVIEW, QA, the request for acceptance -- runs unattended in the session worker (Task 8).
    const actorWorkflow = workflowSectionOf(page, actorInspector);
    await actorWorkflow.getByLabel("Hard token budget").fill("200");
    await actorWorkflow.getByRole("button", { name: "Approve cost policy" }).click();

    // Nothing is clicked on the observer page from here on: only its own channel connection can
    // move this text.
    await expect(observerWorkflow.getByRole("heading", { name: "Acceptance package" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(observerWorkflow.getByText("Review report", { exact: true })).toBeVisible();
    await expect(observerWorkflow.getByText("QA report", { exact: true })).toBeVisible();
  });

  // Spec D3, browser proof: the channel replays nothing and carries no sequence number, so a lost
  // signal has to be indistinguishable from a delivered one once the channel reconnects. Task 6
  // proved the mechanism (invalidateAll on every open); this proves the convergence -- by actually
  // losing signals, not by reasoning about the code that would otherwise deliver them.
  test("catches up on work done while the channel was down", async ({ page, context }) => {
    const title = "Delivered while the channel was down";
    const actorInspector = await openWorkbench(page, title);
    await readyForBudgetApproval(page, actorInspector);

    // Every attempt the observer's channel makes to connect is dropped from its very first try --
    // not merely after it once succeeded. This is the stronger version of the claim above: the
    // observer never gets to see so much as one signal during the work that follows.
    await context.route("**/api/v1/stream", async (route) => {
      await route.abort();
    });

    const observerPage = await context.newPage();
    const observerInspector = await openObserver(observerPage, title);
    const observerWorkflow = workflowSectionOf(observerPage, observerInspector);
    // Presence before absence, in the same scope: the observer's ordinary HTTP-backed load still
    // works with its channel dead, so this establishes the panel is real and tracking live state
    // before the "did it move on its own" check below is trusted.
    await expect(observerWorkflow.getByText("Budget paused", { exact: true }).first()).toBeVisible();
    await expect(observerWorkflow.getByText("100 of 100", { exact: true })).toBeVisible();

    const actorWorkflow = workflowSectionOf(page, actorInspector);
    await actorWorkflow.getByLabel("Hard token budget").fill("200");
    await actorWorkflow.getByRole("button", { name: "Approve cost policy" }).click();
    // The actor's own view is unaffected -- it never depended on the channel -- and settles on the
    // finished delivery through its own mutation's invalidation.
    await expect(actorWorkflow.getByRole("heading", { name: "Acceptance package" })).toBeVisible({
      timeout: 15_000,
    });

    // The observer issued no mutation of its own and its channel is still down, so nothing should
    // have moved it off the snapshot already confirmed above.
    await expect(observerWorkflow.getByRole("heading", { name: "Acceptance package" })).not.toBeVisible();

    // The channel comes back; nothing is clicked on the observer page and nothing is reloaded.
    await context.unroute("**/api/v1/stream");
    await expect(observerWorkflow.getByRole("heading", { name: "Acceptance package" })).toBeVisible({
      timeout: 20_000,
    });
  });
});
