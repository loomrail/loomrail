import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";
import { openLocalState, type LocalState } from "../packages/persistence-sqlite/dist/index.js";
import { mockDeliveryTemplate } from "../packages/workflow-engine/dist/index.js";

/**
 * Spec D5: a StageAttempt is the unit of work and a ProviderSession is the unit of execution, and
 * the cockpit must show sessions nested inside their attempt. What shipped shows a bare "Sessions"
 * heading with no attempt identity above it -- ordinal or status -- so the owner cannot tell which
 * attempt the list belongs to. This is invisible with only one attempt on screen (today's only
 * case), which is exactly why it needs its own proof rather than relying on the existing suite.
 *
 * A new file, not an addition to walking-skeleton.spec.ts: that file is held by a concurrent
 * session's in-flight edits.
 */

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const submit = dialog.getByRole("button", { name: "Create task" });
  await expect(submit).toBeDisabled();
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Exercises the attempt header.");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

const humanActor = { type: "HUMAN" as const, id: "local-owner" };
const sessionLoopActor = { type: "SYSTEM" as const, id: "session-loop" };

const seededRecipe = (workItemId: string) => ({
  schemaVersion: 1 as const,
  templateId: mockDeliveryTemplate.id,
  templateVersion: mockDeliveryTemplate.version,
  specSource: "WORKFLOW_TEMPLATE" as const,
  sections: [
    {
      id: "WORK_ITEM_BRIEF" as const,
      sources: [{ kind: "WORK_ITEM" as const, id: workItemId, version: 1 }],
      bytes: 120,
    },
  ],
  omitted: [],
  contentHash: `sha256:${"0".repeat(64)}`,
  estimatedTokens: 30,
  budgetTokens: 1000,
  estimateQuality: "LOOMRAIL_ESTIMATE" as const,
});

/**
 * One stage attempt holding both occupancy cases the cockpit has to tell apart, because the label
 * is chosen per session and only a session of each kind can prove the choice is being made:
 *
 *  - session 1 reports 62% of its window and never crosses the handoff threshold. Its stored
 *    figure is a peak, not a handoff, and saying "at handoff" here would tell the owner a wind-down
 *    happened when none did.
 *  - session 2 crosses at 88% and is asked to wind down. For it the peak really is the reading at
 *    handoff, because the loop stops reporting the moment it asks.
 *  - session 3 is never measured at all, so it carries no occupancy line -- distinct from zero.
 *
 * Seeded through real commands against the database the daemon then opens, exactly as
 * walking-skeleton.spec.ts's session fixtures are: the in-tree mock adapter runs the scripted M6
 * delivery and reports no occupancy at all, and the one that does report replays the same options
 * on every session it opens, so neither can produce two sessions that differ in this way.
 */
const seedMeasuredAndHandedOffSessions = async (databasePath: string, title: string): Promise<void> => {
  let nextId = 0;
  const localState: LocalState = await openLocalState({
    databasePath,
    now: (() => {
      let clock = Date.parse("2026-08-26T18:00:00.000Z");
      return () => new Date((clock += 1000));
    })(),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-register-project",
      correlationId: "correlation-seed-register-project",
      actor: humanActor,
      type: "REGISTER_FIXTURE_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: resolve("fixtures/projects/web-app-a"),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "seed-create-work-item",
      correlationId: "correlation-seed-create-work-item",
      actor: humanActor,
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-web",
        parentId: null,
        type: "TASK",
        title,
        description: "Seeded to exercise the occupancy label per session.",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: [],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("The seeded WorkItem was not created");
    const moved = localState.execute({
      schemaVersion: 1,
      commandId: "seed-move-ready",
      correlationId: "correlation-seed-move-ready",
      actor: humanActor,
      type: "MOVE_WORK_ITEM",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: created.workItem.version,
        targetState: "READY",
      },
    });
    if (moved.type !== "WORK_ITEM_MOVED") throw new Error("The seeded WorkItem was not moved to Ready");
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "seed-start-pipeline",
      correlationId: "correlation-seed-start-pipeline",
      actor: humanActor,
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: moved.workItem.id,
        expectedVersion: moved.workItem.version,
        template: mockDeliveryTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("The seeded pipeline did not start");
    const dispatchId = started.dispatch.id;
    const stageAttemptId = started.stageAttempt.id;
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-mark-dispatch-started",
      correlationId: "correlation-seed-mark-dispatch-started",
      actor: sessionLoopActor,
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId },
    });
    const recipe = seededRecipe(created.workItem.id);

    // Each session publishes a checkpoint before it ends: two unproductive sessions in a row are
    // spec §6.5's HARD pause, which would take the run somewhere this test is not about.
    const runSession = (
      ordinal: number,
      reports: readonly { usedTokens: number; percent: number }[],
      endReason: "HANDOFF" | "CONTEXT_EXHAUSTED" | "COMPLETED",
    ): void => {
      const session = localState.execute({
        schemaVersion: 1,
        commandId: `seed-session-${ordinal.toString()}-start`,
        correlationId: `correlation-seed-session-${ordinal.toString()}-start`,
        actor: sessionLoopActor,
        type: "START_PROVIDER_SESSION",
        payload: { stageAttemptId, recipe },
      });
      if (session.type !== "PROVIDER_SESSION_STARTED") {
        throw new Error(`Session ${ordinal.toString()} did not start`);
      }
      for (const report of reports) {
        // The same deterministic commandId shape apps/daemon/src/session-loop.ts builds, so this
        // fixture exercises the production id namespace rather than inventing its own.
        localState.execute({
          schemaVersion: 1,
          commandId: `usage-${session.session.id}-${report.percent.toString()}`,
          correlationId: `correlation-seed-session-${ordinal.toString()}-usage`,
          actor: sessionLoopActor,
          type: "REQUEST_CONTEXT_HANDOFF",
          payload: {
            providerSessionId: session.session.id,
            usage: { usedTokens: report.usedTokens, windowTokens: 1000, quality: "ACTUAL" },
            handoffThreshold: 0.75,
          },
        });
      }
      localState.execute({
        schemaVersion: 1,
        commandId: `seed-session-${ordinal.toString()}-checkpoint`,
        correlationId: `correlation-seed-session-${ordinal.toString()}-checkpoint`,
        actor: sessionLoopActor,
        type: "PUBLISH_CHECKPOINT",
        payload: {
          providerSessionId: session.session.id,
          checkpoint: {
            summary: `Deterministic seeded checkpoint from session ${ordinal.toString()}.`,
            completed: [`Session ${ordinal.toString()} did its share of the seeded work.`],
            remaining: ["Continue on the next session."],
            deadEnds: [],
            openQuestions: [],
          },
        },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: `seed-session-${ordinal.toString()}-end`,
        correlationId: `correlation-seed-session-${ordinal.toString()}-end`,
        actor: sessionLoopActor,
        type: "END_PROVIDER_SESSION",
        payload: { providerSessionId: session.session.id, endReason, providerStarted: true },
      });
    };

    runSession(1, [{ usedTokens: 620, percent: 62 }], "CONTEXT_EXHAUSTED");
    runSession(
      2,
      [
        { usedTokens: 300, percent: 30 },
        { usedTokens: 880, percent: 88 },
      ],
      "HANDOFF",
    );
    // Session 3 measures nothing and closes the attempt out: without a COMPLETED session the
    // attempt's dispatch stays durably PENDING and a freshly-started daemon reads this fixture as
    // a crash mid-attempt (spec §6.4), which would rewrite the very rows under test.
    runSession(3, [], "COMPLETED");

    localState.execute({
      schemaVersion: 1,
      commandId: "seed-apply-outcome",
      correlationId: "correlation-seed-apply-outcome",
      actor: sessionLoopActor,
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId,
        outcome: {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Choose the discovery depth",
            context: "Resumed after the seeded sessions; one product decision is still needed.",
            recommendation: null,
            options: [
              {
                id: "focused-pass",
                label: "Focused pass",
                consequence: "Proceed with the smallest sufficient plan.",
                recommended: true,
              },
            ],
            allowOther: false,
          },
        },
        template: mockDeliveryTemplate,
      },
    });
  } finally {
    localState.close();
  }
};

test.describe("attempt nesting", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("names the attempt its sessions are nested inside, by ordinal and status", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Attempt header task");

    const inspector = page.getByRole("complementary", { name: "Attempt header task" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByRole("button", { name: "Start mock workflow" })).toBeEnabled();
    await inspector.getByRole("button", { name: "Start mock workflow" }).click();

    // The mock pipeline's first ProviderSession has ended by the time this human decision surfaces
    // -- the earliest point the sessions list (and so its attempt header) is guaranteed to render.
    await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible();

    const workflowSection = inspector
      .locator(".lr-inspector-section")
      .filter({ has: page.getByText("Workflow", { exact: true }) });
    const sessionsPanel = workflowSection.locator(".lr-session-timeline-panel");
    await expect(sessionsPanel.getByRole("listitem", { name: "Session 1" })).toBeVisible();

    // D5's fix: the header identifying the attempt -- its ordinal and its status -- sits above the
    // sessions list, not just a bare "Sessions" heading.
    const attemptHeader = sessionsPanel.locator(".lr-session-timeline__row").first();
    await expect(attemptHeader.getByText("Attempt 1", { exact: true })).toBeVisible();
    // Not just present -- readable. AGENTS.md requires status is never colour-only, and a
    // container-only check (".lr-status" visible) still passes if the label text inside it is
    // dropped, leaving a bare coloured dot. "Waiting" is workflow.stage.WAITING_HUMAN, the status
    // this attempt is in at the point the test reaches it (same fixed-string approach the
    // neighbouring "Attempt 1" assertion above already takes, rather than pulling in the
    // translator for one known string).
    await expect(attemptHeader.locator(".lr-status")).toContainText("Waiting");

    // D5 names the attempt as the CONTAINER of its sessions -- the attempt heading must render
    // above the "Sessions" list label, not below it. A bounding-box comparison checks what the
    // screen actually shows (the thing an owner reads top to bottom), not just DOM order, so it
    // catches a CSS-only inversion (e.g. `order`/flex-reverse) as well as a markup one.
    const sessionsLabel = sessionsPanel.getByText("Sessions", { exact: true });
    const [attemptBox, sessionsBox] = await Promise.all([
      attemptHeader.boundingBox(),
      sessionsLabel.boundingBox(),
    ]);
    if (attemptBox === null || sessionsBox === null) {
      throw new Error("expected both the attempt header and the Sessions label to have a layout box");
    }
    expect(attemptBox.y).toBeLessThan(sessionsBox.y);
  });

  /**
   * The occupancy label is chosen per session, and the choice is the thing under test: the stored
   * figure is the highest occupancy a session reached, which for a session that never asked to
   * wind down is emphatically not "at handoff". Forcing either wording for every session -- the
   * defect in both directions -- fails here, which is what the string-table check this replaced
   * could not do: it compared two constants and never rendered either of them.
   */
  test("says a session peaked, and only says a handoff happened when one did", async ({ page }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail occupancy "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const title = "Task measured across three provider sessions";
      await seedMeasuredAndHandedOffSessions(databasePath, title);

      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });

      await page.goto(daemon.bootstrapUrl);
      await page.getByRole("button", { name: "All issues", exact: true }).click();
      await page.getByRole("button", { name: title }).click();

      const inspector = page.getByRole("complementary", { name: title });
      const workflowSection = inspector
        .locator(".lr-inspector-section")
        .filter({ has: page.getByText("Workflow", { exact: true }) });
      const session1 = workflowSection.getByRole("listitem", { name: "Session 1" });
      const session2 = workflowSection.getByRole("listitem", { name: "Session 2" });
      const session3 = workflowSection.getByRole("listitem", { name: "Session 3" });

      // Measured, never wound down: the peak wording, and no claim that a handoff happened.
      await expect(session1.getByText("Peaked at 62% of the window", { exact: true })).toBeVisible();
      await expect(session1.getByText("Handoff requested", { exact: true })).toHaveCount(0);
      await expect(session1.getByText("62% of the window at handoff", { exact: true })).toHaveCount(0);

      // Crossed the threshold: for this one the peak IS the reading at handoff, and it says so.
      await expect(session2.getByText("88% of the window at handoff", { exact: true })).toBeVisible();
      await expect(session2.getByText("Handoff requested", { exact: true })).toBeVisible();
      await expect(session2.getByText("Peaked at 88% of the window", { exact: true })).toHaveCount(0);

      // Both figures are measured rather than estimated, and the cockpit still says which.
      await expect(session1.getByText("(measured)", { exact: true })).toBeVisible();
      await expect(session2.getByText("(measured)", { exact: true })).toBeVisible();

      // Never measured at all, which is not the same as measured at zero: no occupancy line.
      await expect(session3).toBeVisible();
      await expect(session3.locator(".lr-session-timeline__occupancy")).toHaveCount(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
