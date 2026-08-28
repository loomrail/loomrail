import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { materialiseFixtureRepository, resolveBundledFixture } from "../apps/daemon/dist/fixtures.js";
import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";
import { openLocalState, type LocalState } from "../packages/persistence-sqlite/dist/index.js";
import { mockDeliveryTemplate } from "../packages/workflow-engine/dist/index.js";
import { addWorktree, inspectRepository } from "../packages/workspace/dist/index.js";

/**
 * The repository a seeded Project points at, materialised the way registration would.
 *
 * A bundled fixture is a template inside this checkout, never a repository -- a nested `.git` cannot
 * be committed here. A Project seeded at the template is therefore a Project whose path is a
 * directory inside Loomrail's own repository, and the daemon refuses to cut a workspace from one of
 * those (it would branch the developer's own tree), answering with a blocking question instead of
 * running the stage. So the seed calls the daemon's own materialiser, rooted where a daemon opening
 * this database file defaults its demo root: beside the database, at `<data>/demo-projects`.
 */
const seedRepositoryPath = async (databasePath: string): Promise<string> =>
  (
    await materialiseFixtureRepository(
      await resolveBundledFixture("web-app-a"),
      join(dirname(databasePath), "demo-projects"),
    )
  ).repositoryPath;

/**
 * The two demo Projects exactly as the owner's own database holds them: recorded at the bundled
 * fixture TEMPLATE inside Loomrail's checkout, which is a directory inside a repository rather
 * than a repository of its own.
 *
 * `resolveBundledFixture` is used for the paths, ids and names rather than literals, so this seed
 * cannot drift from what a registration would actually have written back when it wrote them.
 */
const seedStaleFixtureProjects = async (
  databasePath: string,
): Promise<{ apiServiceB: string; webAppA: string }> => {
  const webAppA = await resolveBundledFixture("web-app-a");
  const apiServiceB = await resolveBundledFixture("api-service-b");
  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: () => new Date("2026-08-22T18:00:00.000Z"),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    for (const fixture of [webAppA, apiServiceB]) {
      localState.execute({
        schemaVersion: 1,
        commandId: `seed-stale-${fixture.fixtureId}`,
        correlationId: `correlation-seed-stale-${fixture.fixtureId}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: fixture.projectId,
          fixtureId: fixture.fixtureId,
          name: fixture.name,
          repositoryPath: fixture.templatePath,
        },
      });
    }
  } finally {
    localState.close();
  }
  return { apiServiceB: apiServiceB.templatePath, webAppA: webAppA.templatePath };
};

/**
 * Writes a task carrying more activity than a single page holds. Driving forty moves through the
 * board would dominate the run, and the point under test is what the inspector does with a long
 * log, not how the log came to be long.
 */
const seedLongActivity = async (databasePath: string, title: string): Promise<number> => {
  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: () => new Date("2026-08-22T18:00:00.000Z"),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-register-project",
      correlationId: "correlation-seed-register-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: await seedRepositoryPath(databasePath),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "seed-create-work-item",
      correlationId: "correlation-seed-create-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-web",
        parentId: null,
        type: "TASK",
        title,
        description: "Seeded with a long audit trail.",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: [],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("The seeded WorkItem was not created");

    let version = created.workItem.version;
    for (let move = 0; move < 40; move += 1) {
      const moved = localState.execute({
        schemaVersion: 1,
        commandId: `seed-move-${move.toString()}`,
        correlationId: `correlation-seed-move-${move.toString()}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: version,
          targetState: move % 2 === 0 ? "READY" : "BACKLOG",
        },
      });
      if (moved.type !== "WORK_ITEM_MOVED") throw new Error("The seeded WorkItem was not moved");
      version = moved.workItem.version;
    }
    // One creation plus forty moves.
    return 41;
  } finally {
    localState.close();
  }
};

const humanActor = { type: "HUMAN", id: "local-owner" } as const;
const sessionLoopActor = { type: "SYSTEM", id: "session-loop" } as const;

/**
 * The recipe every seeded ProviderSession carries. Its content never matters to these tests -- only
 * that persistence-sqlite accepts a well-formed one -- so it stays fixed rather than parameterised.
 */
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
 * Registers the fixture project, creates one WorkItem, moves it to Ready, and starts its mock
 * pipeline's first stage attempt -- through to a RUNNING dispatch, one step short of its first
 * ProviderSession. Shared by both session-loop fixtures below.
 *
 * Seeded through direct commands against the same database file the daemon will later open,
 * exactly like `seedLongActivity` above -- not by driving `runStageAttempt`, whose mock adapter
 * replays the same stateless per-turn options on every session it opens and so cannot itself
 * produce "session 1 hands off with a checkpoint, session 2 hits the wall" or "two sessions in a
 * row publish nothing": both need each session to end differently, and only direct commands can
 * hand each one an outcome the last one didn't already use.
 */
const seedRunningStageAttempt = (
  localState: LocalState,
  title: string,
): { dispatchId: string; stageAttemptId: string; workItemId: string } => {
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
      description: "Seeded to exercise the session loop's nesting directly.",
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
      // Matches the daemon's own DEFAULT_MOCK_BUDGET (apps/daemon/src/server.ts): if a fixture's
      // stage attempt ever resumes far enough to reach the mock script's IMPLEMENT budget-exhaustion
      // beat, its usageIncrements (summing to 100) must actually reach this limit, or
      // decideApplyProviderOutcome rejects the outcome as "budget limit not reached".
      budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
    },
  });
  if (started.type !== "PIPELINE_STARTED") throw new Error("The seeded pipeline did not start");

  const dispatched = localState.execute({
    schemaVersion: 1,
    commandId: "seed-mark-dispatch-started",
    correlationId: "correlation-seed-mark-dispatch-started",
    actor: sessionLoopActor,
    type: "MARK_WORKFLOW_DISPATCH_STARTED",
    payload: { dispatchId: started.dispatch.id },
  });
  if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("The seeded dispatch did not start");

  return {
    dispatchId: started.dispatch.id,
    stageAttemptId: started.stageAttempt.id,
    workItemId: created.workItem.id,
  };
};

/**
 * A stage attempt that survived one context handoff and one reactive cut: session 1 crosses the
 * handoff threshold, publishes a real checkpoint, and hands off; session 2 crosses it again but
 * hits the wall anyway, publishing a different checkpoint before it does. Exercises every piece of
 * spec D5's requirement at once -- ordinal, endReason, occupancy, the handoff-requested fact, and
 * the full text of two distinct checkpoints -- with the run left healthy (RUNNING), never a series
 * of failures.
 */
const seedHandoffAndExhaustedSessions = async (databasePath: string, title: string): Promise<void> => {
  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: (() => {
      let clock = Date.parse("2026-08-25T18:00:00.000Z");
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
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: await seedRepositoryPath(databasePath),
      },
    });
    const { dispatchId, stageAttemptId, workItemId } = seedRunningStageAttempt(localState, title);
    const recipe = seededRecipe(workItemId);

    const session1 = localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-1-start",
      correlationId: "correlation-seed-session-1-start",
      actor: sessionLoopActor,
      type: "START_PROVIDER_SESSION",
      payload: { stageAttemptId, recipe },
    });
    if (session1.type !== "PROVIDER_SESSION_STARTED") throw new Error("Session 1 did not start");
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-1-handoff",
      correlationId: "correlation-seed-session-1-handoff",
      actor: sessionLoopActor,
      type: "REQUEST_CONTEXT_HANDOFF",
      payload: {
        providerSessionId: session1.session.id,
        usage: { usedTokens: 780, windowTokens: 1000, quality: "ACTUAL" },
        handoffThreshold: 0.75,
      },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-1-checkpoint",
      correlationId: "correlation-seed-session-1-checkpoint",
      actor: sessionLoopActor,
      type: "PUBLISH_CHECKPOINT",
      payload: {
        providerSessionId: session1.session.id,
        checkpoint: {
          summary: "Mapped the fixture repository's auth module and located the token refresh path.",
          completed: [
            "Read through src/auth/session.ts and src/auth/tokens.ts",
            "Reproduced the expiring-token bug locally",
          ],
          remaining: ["Write the regression test", "Patch the refresh race"],
          deadEnds: ["Assumed the bug was in the HTTP client retry logic -- it was not"],
          openQuestions: [],
        },
      },
    });
    const ended1 = localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-1-end",
      correlationId: "correlation-seed-session-1-end",
      actor: sessionLoopActor,
      type: "END_PROVIDER_SESSION",
      payload: { providerSessionId: session1.session.id, endReason: "HANDOFF", providerStarted: true },
    });
    if (ended1.type !== "PROVIDER_SESSION_ENDED" || ended1.nextSessionOrdinal === null) {
      throw new Error("Session 1 did not hand off to a second session");
    }

    const session2 = localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-2-start",
      correlationId: "correlation-seed-session-2-start",
      actor: sessionLoopActor,
      type: "START_PROVIDER_SESSION",
      payload: { stageAttemptId, recipe },
    });
    if (session2.type !== "PROVIDER_SESSION_STARTED") throw new Error("Session 2 did not start");
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-2-handoff",
      correlationId: "correlation-seed-session-2-handoff",
      actor: sessionLoopActor,
      type: "REQUEST_CONTEXT_HANDOFF",
      payload: {
        providerSessionId: session2.session.id,
        usage: { usedTokens: 920, windowTokens: 1000, quality: "ACTUAL" },
        handoffThreshold: 0.75,
      },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-2-checkpoint",
      correlationId: "correlation-seed-session-2-checkpoint",
      actor: sessionLoopActor,
      type: "PUBLISH_CHECKPOINT",
      payload: {
        providerSessionId: session2.session.id,
        checkpoint: {
          summary:
            "Landed the token refresh patch and a regression test; the retry-storm edge case is still open.",
          completed: [
            "Wrote a failing regression test for the race",
            "Serialized the refresh call behind a mutex",
          ],
          remaining: ["Cover the retry-storm edge case", "Update the auth module's README"],
          deadEnds: [],
          openQuestions: ["Should the refresh mutex be per-session or per-user?"],
        },
      },
    });
    const ended2 = localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-2-end",
      correlationId: "correlation-seed-session-2-end",
      actor: sessionLoopActor,
      type: "END_PROVIDER_SESSION",
      payload: {
        providerSessionId: session2.session.id,
        endReason: "CONTEXT_EXHAUSTED",
        providerStarted: true,
      },
    });
    if (ended2.type !== "PROVIDER_SESSION_ENDED" || ended2.nextSessionOrdinal === null) {
      throw new Error("Session 2 did not continue to a third session");
    }

    // A third session that actually finishes the stage: without this, the attempt's original
    // dispatch is left durably PENDING (spec §6.1 -- it only completes when the stage does), and a
    // freshly-started daemon reading this fixture back would treat that exactly like a crash mid-
    // attempt and mark it INTERRUPTED at startup (spec §6.4). Its own checkpoint history stays
    // empty on purpose: it exists to close the attempt out cleanly, not to add a third example.
    const session3 = localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-3-start",
      correlationId: "correlation-seed-session-3-start",
      actor: sessionLoopActor,
      type: "START_PROVIDER_SESSION",
      payload: { stageAttemptId, recipe },
    });
    if (session3.type !== "PROVIDER_SESSION_STARTED") throw new Error("Session 3 did not start");
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-session-3-end",
      correlationId: "correlation-seed-session-3-end",
      actor: sessionLoopActor,
      type: "END_PROVIDER_SESSION",
      payload: { providerSessionId: session3.session.id, endReason: "COMPLETED", providerStarted: true },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-apply-outcome",
      correlationId: "correlation-seed-apply-outcome",
      actor: sessionLoopActor,
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId,
        outcome: {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Choose the discovery depth",
            context: "Resumed after the context handoff; one product decision is still needed.",
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

/**
 * Two provider sessions in a row publish no checkpoint, which durable state (not daemon memory --
 * spec §6.5) turns into a HARD pause with `failureCode: "NO_PROGRESS"`. This is the fixture for
 * Task 11's carried defect: every HARD_PAUSED run used to read "Budget paused" and offer an
 * "approve budget override" action that throws for exactly this pause (decideApproveBudgetOverride
 * refuses a session pause).
 */
const seedNoProgressHardPause = async (databasePath: string, title: string): Promise<void> => {
  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: (() => {
      let clock = Date.parse("2026-08-25T19:00:00.000Z");
      return () => new Date((clock += 1000));
    })(),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-pause-register-project",
      correlationId: "correlation-seed-pause-register-project",
      actor: humanActor,
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: await seedRepositoryPath(databasePath),
      },
    });
    const { stageAttemptId, workItemId } = seedRunningStageAttempt(localState, title);
    const recipe = seededRecipe(workItemId);

    for (const ordinal of [1, 2]) {
      const session = localState.execute({
        schemaVersion: 1,
        commandId: `seed-pause-session-${ordinal.toString()}-start`,
        correlationId: `correlation-seed-pause-session-${ordinal.toString()}-start`,
        actor: sessionLoopActor,
        type: "START_PROVIDER_SESSION",
        payload: { stageAttemptId, recipe },
      });
      if (session.type !== "PROVIDER_SESSION_STARTED") {
        throw new Error(`Session ${ordinal.toString()} did not start`);
      }
      // Ends with zero checkpoints published: unproductive, per spec §6.5.
      localState.execute({
        schemaVersion: 1,
        commandId: `seed-pause-session-${ordinal.toString()}-end`,
        correlationId: `correlation-seed-pause-session-${ordinal.toString()}-end`,
        actor: sessionLoopActor,
        type: "END_PROVIDER_SESSION",
        payload: {
          providerSessionId: session.session.id,
          endReason: "CONTEXT_EXHAUSTED",
          providerStarted: true,
        },
      });
    }
  } finally {
    localState.close();
  }
};

type SeededWorkspaces = {
  baseCommit: string;
  branch: string;
  goneTitle: string;
  liveTitle: string;
  noWorkspaceTitle: string;
  repositoryPath: string;
  worktreePath: string;
};

/**
 * Three work items covering the three things the card has to say about a workspace: one with a real
 * worktree on disk, one whose worktree is gone, and one that never needed a repository at all.
 *
 * The live worktree is genuinely cut with `git worktree add` (through the product's own
 * `addWorktree`) against the materialised fixture repository, never against this checkout. That is
 * not ceremony: startup reconciliation orphans any READY workspace `git worktree list` does not
 * report, so a synthetic path would arrive at the browser already ORPHANED and the READY branch of
 * the panel would never be rendered. The same mechanism is what makes the second item ORPHANED --
 * its path is simply never created, and the daemon reaches that conclusion itself rather than the
 * seed asserting it.
 *
 * The worktree path carries a space and non-ASCII characters (AGENTS.md), which is also the case
 * the panel's wrapping has to survive: this is the value the owner came to copy.
 */
const seedWorkspaces = async (databasePath: string): Promise<SeededWorkspaces> => {
  const repositoryPath = await seedRepositoryPath(databasePath);
  const inspected = await inspectRepository(repositoryPath);
  const baseCommit = inspected?.headCommit ?? null;
  if (inspected === null || baseCommit === null) {
    throw new Error("The seeded fixture repository has no commit to branch from");
  }
  const branch = "loomrail/seeded-live-workspace";
  const worktreePath = join(dirname(databasePath), "workspaces", "project web", "задача с пробелом");
  await mkdir(dirname(worktreePath), { recursive: true });
  const added = await addWorktree({
    topLevel: inspected.topLevel,
    branch,
    path: worktreePath,
    startPoint: baseCommit,
  });
  if (added.type !== "ADDED") throw new Error(`The seeded worktree was refused: ${added.refusal.type}`);

  const titles = {
    goneTitle: "Task whose worktree went away",
    liveTitle: "Task with a live workspace",
    noWorkspaceTitle: "Task that never needed a repository",
  };

  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: () => new Date("2026-08-26T09:00:00.000Z"),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-workspace-register-project",
      correlationId: "correlation-seed-workspace-register-project",
      actor: humanActor,
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath,
      },
    });

    const createSeededTask = (slug: string, title: string): string => {
      const created = localState.execute({
        schemaVersion: 1,
        commandId: `seed-workspace-create-${slug}`,
        correlationId: `correlation-seed-workspace-create-${slug}`,
        actor: humanActor,
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-web",
          parentId: null,
          type: "TASK",
          title,
          description: "Seeded to exercise what the card says about a workspace.",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: [],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED")
        throw new Error(`The seeded WorkItem "${title}" was not created`);
      return created.workItem.id;
    };

    const recordWorkspace = (workItemId: string, workspaceBranch: string, path: string): void => {
      const workspace = localState.execute({
        schemaVersion: 1,
        commandId: `seed-workspace-record-${workItemId}`,
        correlationId: `correlation-seed-workspace-record-${workItemId}`,
        actor: sessionLoopActor,
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          workItemId,
          projectId: "project-web",
          branch: workspaceBranch,
          worktreePath: path,
          baseCommit,
          snapshotCommit: null,
          carriedPaths: [],
        },
      });
      if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") {
        throw new Error("The seeded workspace was not recorded");
      }
    };

    recordWorkspace(createSeededTask("live", titles.liveTitle), branch, worktreePath);
    recordWorkspace(
      createSeededTask("gone", titles.goneTitle),
      "loomrail/seeded-vanished-workspace",
      join(dirname(databasePath), "workspaces", "project web", "never created"),
    );
    createSeededTask("bare", titles.noWorkspaceTitle);
  } finally {
    localState.close();
  }

  return { ...titles, baseCommit, branch, repositoryPath, worktreePath };
};

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
 * How long a run may take to reach IMPLEMENT's budget wall.
 *
 * More than Playwright's default because IMPLEMENT is now a stage that cuts a Git worktree before
 * its first session opens -- snapshot, `worktree add`, and the repository inspection ahead of both.
 * The assertion is unchanged: the wall still has to be reached, and a run that never gets there
 * still fails here. Only the patience is different, and it is different because the work is real.
 */
const BUDGET_WALL_MS = 20_000;

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

const createTask = async (
  page: Page,
  title: string,
  description = "Persisted through the authenticated local API.",
): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const submit = dialog.getByRole("button", { name: "Create task" });
  await expect(submit).toBeDisabled();
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill(description);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

/**
 * Changes one preference through the settings dialog.
 *
 * The dialog is located by class rather than by accessible name: choosing a language renames it
 * mid-flight, and a name-based locator would report the still-open dialog as hidden while it is
 * covering the page.
 */
/**
 * Picks one preference in the settings dialog.
 *
 * The dialog is located by class rather than by accessible name: choosing a language renames it
 * mid-flight, and a name-based locator would report the still-open dialog as hidden while it is
 * covering the page. The close control is used for the same reason.
 */
const chooseInSettings = async (page: Page, control: string, option: string): Promise<void> => {
  const settings = page.locator(".lr-dialog");
  await page.getByRole("button", { name: /Open settings|Открыть настройки/ }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("group", { name: control }).getByRole("button", { name: option }).click();
  await settings.locator(".lr-dialog__header button").click();
  await expect(settings).toHaveCount(0);
};

test.describe("authenticated walking skeleton", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("opens a real persisted workbench and preserves local preferences", async ({ page }) => {
    const bootstrapToken = randomBytes(32).toString("base64url");
    const requestedUrls: string[] = [];
    page.on("request", (request) => {
      requestedUrls.push(request.url());
    });
    daemon = await startDaemon({
      bootstrapToken,
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);

    await expect(page.getByRole("heading", { level: 1, name: "Current work" })).toBeVisible();
    await expect(page.getByText("No local projects yet", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/bootstrap=/);
    expect(requestedUrls.every((url) => !url.includes(bootstrapToken))).toBe(true);
    expect(await page.evaluate<string>("window.location.hash")).toBe("");
    expect(await page.evaluate<string>("document.referrer")).not.toContain(bootstrapToken);

    const viewport = page.viewportSize();
    const appSurfaceBox = await page.locator(".app-surface").boundingBox();
    expect(viewport).not.toBeNull();
    expect(appSurfaceBox).not.toBeNull();
    if (viewport && appSurfaceBox) {
      expect(appSurfaceBox.y).toBe(8);
      expect(viewport.width - (appSurfaceBox.x + appSurfaceBox.width)).toBe(8);
      expect(viewport.height - (appSurfaceBox.y + appSurfaceBox.height)).toBe(8);
    }

    await initializeWorkspace(page);
    await createTask(page, "Persisted browser task");

    const task = page.getByRole("button", { name: "Persisted browser task" });
    const card = task.locator(".lr-task-card");
    await expect(task).toHaveAttribute("aria-pressed", "true");
    await expect(card).toHaveClass(/is-selected/);
    await expect(card).toHaveCSS("box-shadow", /0px 0px 0px 1px/);
    const initialInspector = page.getByRole("complementary", { name: "Persisted browser task" });
    await expect(
      initialInspector.getByRole("heading", { level: 2, name: "Persisted browser task" }),
    ).toBeVisible();
    await expect(initialInspector.getByText("Backlog", { exact: true })).toBeVisible();

    await initialInspector.getByRole("button", { name: "Edit task" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit task" });
    await editDialog.locator("#edit-task-title").fill("Edited persisted browser task");
    await editDialog.locator("#edit-task-description").fill("Updated through the persisted PATCH command.");
    await editDialog
      .locator("#edit-work-item-criteria")
      .fill("The edit survives reload\nThe event is auditable");
    await editDialog.getByRole("combobox", { name: "Priority" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(editDialog).toBeHidden();

    const inspector = page.getByRole("complementary", { name: "Edited persisted browser task" });
    await expect(page.getByRole("button", { name: "Edited persisted browser task" })).toBeVisible();
    await expect(inspector.getByText("Updated through the persisted PATCH command.")).toBeVisible();
    await expect(inspector.getByText("The edit survives reload")).toBeVisible();
    await expect(inspector.getByText("Task updated", { exact: true })).toBeVisible();
    await expect(
      inspector.getByText(/Changed title, description, priority, acceptance criteria/),
    ).toBeVisible();

    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByText("Ready", { exact: true })).toBeVisible();
    await expect(inspector.getByText("State changed", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Backlog → Ready", { exact: true })).toBeVisible();

    await chooseInSettings(page, "Change color theme", "Dark");
    await chooseInSettings(page, "Change language", "Русский");
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edited persisted browser task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Components" })).toHaveCount(0);
  });

  test("keeps the application frame stable while the workspace is loading", async ({ page }) => {
    const bootstrapToken = randomBytes(32).toString("base64url");
    let releaseStatus: (() => void) | undefined;
    const statusBlocked = new Promise<void>((resolveStatus) => {
      releaseStatus = resolveStatus;
    });
    daemon = await startDaemon({
      bootstrapToken,
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });
    await page.route("**/api/v1/status", async (route) => {
      await statusBlocked;
      await route.continue();
    });

    await page.goto(daemon.bootstrapUrl, { waitUntil: "domcontentloaded" });
    const surface = page.locator(".app-surface");
    await expect(surface).toBeVisible();
    await expect(page.locator(".app-sidebar nav:visible")).toHaveCount(0);
    await expect(page.locator(".app-topbar")).toBeHidden();
    const loadingMark = surface.locator(".app-brand-mark");
    await expect(loadingMark).toBeVisible();
    await expect(loadingMark).toHaveAttribute("height", "40");
    await expect(surface.getByRole("status", { name: "Connecting…" })).toBeVisible();
    expect(
      await surface.locator(".app-loading-mark").evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style.animationName === "app-loading-mark" && style.animationDuration === "1.4s";
      }),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await surface.locator(".app-loading-mark").evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style.animationName === "none" && style.opacity === "1" && style.transform === "none";
      }),
    ).toBe(true);
    const initialDocument = await page.request.get(new URL("/", daemon.bootstrapUrl).toString());
    const initialMarkup = await initialDocument.text();
    expect(initialMarkup).not.toContain("Starting Loomrail");
    expect(initialMarkup).toContain('class="app-shell app-shell--loading"');
    expect(initialMarkup).toContain('lang="ru">Подключение…');
    const loadingBox = await surface.boundingBox();

    releaseStatus?.();
    await expect(page.getByRole("heading", { level: 1, name: "Current work" })).toBeVisible();
    const loadedBox = await surface.boundingBox();
    expect(loadingBox).not.toBeNull();
    expect(loadedBox).not.toBeNull();
    if (loadingBox && loadedBox) {
      expect(Math.abs(loadingBox.x - loadedBox.x)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.y - loadedBox.y)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.width - loadedBox.width)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.height - loadedBox.height)).toBeLessThan(0.1);
    }
  });

  test("reserves inspector workflow and activity space while their data loads", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Stable inspector loading");

    let releaseWorkflow: (() => void) | undefined;
    let releaseEvents: (() => void) | undefined;
    const workflowBlocked = new Promise<void>((resolveWorkflow) => {
      releaseWorkflow = resolveWorkflow;
    });
    const eventsBlocked = new Promise<void>((resolveEvents) => {
      releaseEvents = resolveEvents;
    });
    await page.route("**/api/v1/work-items/*/workflow", async (route) => {
      await workflowBlocked;
      await route.continue();
    });
    await page.route(/\/api\/v1\/events\?/, async (route) => {
      await eventsBlocked;
      await route.continue();
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    const inspector = page.getByRole("complementary", { name: "Stable inspector loading" });
    const workflowSkeleton = inspector.getByRole("status", { name: "Loading workflow…" });
    const activitySkeleton = inspector.getByRole("status", { name: "Loading activity…" });
    await expect(workflowSkeleton).toBeVisible();
    await expect(activitySkeleton).toBeVisible();
    expect((await workflowSkeleton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(120);
    expect((await activitySkeleton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(90);
    await expect(inspector.getByText("Loading workflow…", { exact: true })).toHaveCount(0);
    await expect(inspector.getByText("Loading activity…", { exact: true })).toHaveCount(0);

    releaseWorkflow?.();
    releaseEvents?.();
    await expect(workflowSkeleton).toBeHidden();
    await expect(activitySkeleton).toBeHidden();
    await expect(inspector.getByText("Move this task to Ready before starting its workflow.")).toBeVisible();
  });

  test("keeps localized inspector actions inside the inspector", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Localized inspector actions");
    await chooseInSettings(page, "Change language", "Русский");

    const inspector = page.getByRole("complementary", { name: "Localized inspector actions" });
    const inspectorTitle = inspector.getByRole("heading", { name: "Localized inspector actions" });
    expect(await inspectorTitle.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await inspector.getByRole("button", { name: "Редактировать задачу" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Редактировать задачу");
    await expect(page.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    // A visible tooltip is a label, not a target: it must not intercept clicks beneath it.
    await expect(page.getByRole("tooltip")).toHaveCSS("pointer-events", "none");
    await expect(inspector.getByRole("button", { name: "Редактировать задачу" })).not.toHaveAttribute(
      "title",
    );
    await page.mouse.move(0, 0);
    const footer = inspector.locator(".task-inspector__footer");
    const footerBox = await footer.boundingBox();
    const actionBoxes = await footer.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
    expect(footerBox).not.toBeNull();
    if (footerBox) {
      expect(
        actionBoxes.every(({ left, right }) => left >= footerBox.x && right <= footerBox.x + footerBox.width),
      ).toBe(true);
    }
    expect(await footer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.getByRole("button", { name: "Настройки отображения" }).click();
    const ordering = page.getByRole("combobox", { name: "Сортировать задачи по" });
    await ordering.click();
    const updated = page.getByRole("option", { name: "Обновлено" });
    expect(
      await updated
        .locator(".lr-select-item__copy > span")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  });

  test("registers a local Git repository from settings, and refuses a directory inside one", async ({
    page,
  }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail own repository "));
    try {
      // A repository of its own, built the way registration builds the demo one -- so this test
      // needs no git of its own, and the repository it registers is as real as the owner's would be.
      const { repositoryPath } = await materialiseFixtureRepository(
        await resolveBundledFixture("web-app-a"),
        temporaryDirectory,
      );
      const inside = join(repositoryPath, "packages");
      await mkdir(inside, { recursive: true });

      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        stateDatabasePath: join(temporaryDirectory, "local-state.sqlite"),
        webRoot: resolve("apps/web/dist"),
      });

      await page.goto(daemon.bootstrapUrl);
      await expect(page.getByText("No local projects yet", { exact: true })).toBeVisible();

      const settings = page.locator(".lr-dialog");
      await page.getByRole("button", { name: "Open settings" }).click();
      const path = settings.getByLabel("Register a local repository");
      const register = settings.getByRole("button", { name: "Register repository" });

      // The guard first: a directory inside a repository is refused, and the refusal names the
      // repository it is inside -- which is what tells the owner what to register instead.
      await path.fill(inside);
      await register.click();
      await expect(settings.getByRole("alert")).toContainText(repositoryPath);
      await expect(page.getByRole("button", { name: "Switch project" })).toHaveCount(0);

      // Then the repository itself. Its directory name is the Project's name.
      await path.fill(repositoryPath);
      await register.click();
      await settings.locator(".lr-dialog__header button").click();
      await expect(settings).toHaveCount(0);

      const project = page.getByRole("button", { name: "Switch project" });
      await expect(project).toBeVisible({ timeout: DEMO_INITIALISATION_MS });
      await expect(project).toContainText("web-app-a");
      // A Project like any other: the board is live and a task can be filed against it.
      await createTask(page, "Task in my own repository");
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  /**
   * The one database that matters, and the repair reached the way a person reaches it.
   *
   * The owner's two demo Projects were registered before a bundled fixture became a real
   * repository, so their `repository_path` names a directory inside Loomrail's own checkout;
   * migration 0012 carried those paths across verbatim, as it must, since a migration cannot know
   * the data directory. Every IMPLEMENT and QA on them is refused there.
   *
   * REPOINT_FIXTURE_PROJECT and its route were built for exactly this and were verified by calling
   * the route. But the only thing in the product that called the route was "Initialize demo
   * workspace", which renders only when there is no selected project -- and this owner has two --
   * and the mutation behind it then skipped any `fixtureId` already registered. So the repair was
   * unreachable by any sequence of clicks, and the Projects list showed names only, which is why
   * nothing looked wrong.
   *
   * Seeded at the bundled template path on purpose, rather than at a materialised repository the
   * way every other test here seeds: that path IS the defect.
   */
  test("repairs a demo project still recorded at the bundled fixture template, from settings", async ({
    page,
  }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail stale demo "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const stalePaths = await seedStaleFixtureProjects(databasePath);

      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });

      await page.goto(daemon.bootstrapUrl);
      // Two Projects, so the "Initialize demo workspace" empty state never appears -- which is the
      // owner's actual situation and the reason the repair could not be reached.
      await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible();
      await expect(page.getByText("No local projects yet", { exact: true })).toHaveCount(0);

      const settings = page.locator(".lr-dialog");
      await page.getByRole("button", { name: "Open settings" }).click();
      await expect(settings).toBeVisible();

      // The path is on screen at all, which it was not: the list was names only, so a Project stuck
      // at the template looked exactly like a healthy one.
      const staleRow = settings.locator(".settings__projects li", { hasText: "Fixture web application" });
      await expect(staleRow.locator(".settings__project-path")).toContainText(stalePaths.webAppA);

      const repair = staleRow.getByRole("button", { name: "Repair demo repository" });
      await expect(repair).toBeVisible();
      await repair.click();

      // Repaired: the Project now records a repository under the daemon's own data directory --
      // beside the database, where `demoProjectsRoot` defaults -- and not the bundled template.
      const repaired = join(temporaryDirectory, "demo-projects", "web-app-a");
      await expect(staleRow.locator(".settings__project-path")).toContainText(repaired, {
        timeout: DEMO_INITIALISATION_MS,
      });
      await expect(staleRow.locator(".settings__project-path")).not.toContainText(stalePaths.webAppA);
      // And the row stops offering a repair, because there is nothing left to repair.
      await expect(staleRow.getByRole("button", { name: "Repair demo repository" })).toHaveCount(0);

      // The second demo Project is untouched by the first one's repair -- each is repaired on its
      // own row -- so the affordance is still there for it.
      const otherRow = settings.locator(".settings__projects li", { hasText: "Fixture API service" });
      await expect(otherRow.locator(".settings__project-path")).toContainText(stalePaths.apiServiceB);
      await expect(otherRow.getByRole("button", { name: "Repair demo repository" })).toBeVisible();
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("offers both languages in settings and marks the active one", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const languages = settings.getByRole("group", { name: "Change language" });

    await expect(languages.getByRole("button")).toHaveCount(2);
    await expect(languages.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    // Neither label may be clipped by the tile that holds it.
    for (const name of ["English", "Русский"]) {
      const label = languages.getByRole("button", { name }).locator("span");
      expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  });

  test("filters the board to blocking requests and back from the workspace navigation", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Quick filter task");

    // Human requests is the only quick filter the product still offers.
    await page.getByRole("link", { name: "Human requests" }).click();
    await expect(page).toHaveURL(/summary=needsYou/);

    const appliedFilters = page.getByRole("region", { name: "Filter tasks" });
    await expect(appliedFilters.getByText("Quick filter", { exact: true })).toBeVisible();
    await expect(appliedFilters.getByText("Needs you", { exact: true })).toBeVisible();
    // Nothing is blocking, so the task the test just created must be filtered out.
    await expect(page.getByRole("button", { name: "Quick filter task" })).toHaveCount(0);

    await page.reload();
    await expect(appliedFilters.getByText("Needs you", { exact: true })).toBeVisible();

    await appliedFilters.getByRole("button", { name: "Clear quick filter" }).click();
    await expect(page).not.toHaveURL(/summary=/);
    await expect(page.getByRole("button", { name: "Quick filter task" })).toBeVisible();
  });

  test("searches values of every property from the main filter search", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Main search task");

    await page.getByRole("button", { name: "Filter tasks" }).first().click();
    const filterPopover = page.locator(".lr-filter-popover");
    await filterPopover.getByRole("menuitem", { name: "Priority" }).hover();
    await expect(page.getByRole("menu", { name: "Priority options" })).toBeVisible();

    // The submenu hangs off a property row, so a search that hides the row has to take the
    // submenu with it instead of leaving it floating next to nothing.
    await filterPopover.getByRole("searchbox", { name: "Search Filters" }).fill("urgent");
    await expect(page.getByRole("menu", { name: "Priority options" })).toBeHidden();

    // The main search reaches the values inside every property, not just the property names.
    await filterPopover.getByRole("menuitemcheckbox", { name: "Priority: Urgent" }).click();
    await expect(page).toHaveURL(/filters=priority-urgent/);
    await expect(page.getByRole("button", { name: "Main search task" })).toHaveCount(0);
  });

  test("filters the board by risk", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Medium risk task");

    // Risk is a real WorkItem field, so it belongs in the filter tree rather than behind a
    // metric chip that mixed it with delivery state.
    await page.getByRole("button", { name: "Filter tasks" }).first().click();
    await page.locator(".lr-filter-popover").getByRole("menuitem", { name: "Risk" }).hover();
    await expect(page.getByRole("menu", { name: "Risk options" })).toBeVisible();
    await page.getByRole("button", { name: "Add Critical" }).click();
    await expect(page).toHaveURL(/filters=risk-critical/);
    await expect(page.getByRole("button", { name: "Medium risk task" })).toHaveCount(0);

    // The filter popover stays open after adding a value and would cover the applied-filter bar.
    await page.keyboard.press("Escape");
    await expect(page.locator(".lr-filter-popover")).toBeHidden();
    await page.getByRole("region", { name: "Filter tasks" }).getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Medium risk task" })).toBeVisible();
  });

  test("isolates board scrolling from the inspector on compact screens", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 720 });
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Compact screen task");
    const workbench = page.locator(".workbench");
    const board = page.locator(".workbench-board");
    const columns = page.locator(".kanban-board-scroll");
    const inspector = page.getByRole("complementary", { name: "Compact screen task" });

    expect(await workbench.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    // The column row absorbs the horizontal overflow so the toolbar and heading never scroll away.
    expect(await columns.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await board.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    await inspector.scrollIntoViewIfNeeded();
    const surfaceBox = await page.locator(".app-surface").boundingBox();
    const inspectorBox = await inspector.boundingBox();
    expect(surfaceBox).not.toBeNull();
    expect(inspectorBox).not.toBeNull();
    if (surfaceBox && inspectorBox) {
      expect(inspectorBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
      expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("explains how to recover when the local daemon becomes unavailable", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Recovery guidance task");

    const stoppedDaemon = daemon;
    daemon = undefined;
    await stoppedDaemon.close();

    const inspector = page.getByRole("complementary", { name: "Recovery guidance task" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByText("Loomrail is temporarily unreachable", { exact: true })).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("renders persisted WorkItem text as inert content", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const title = '<img src=x onerror="window.__loomrailXss = true">';
    await createTask(page, title, "<script>window.__loomrailXss = true</script>");

    await expect(page.getByRole("button", { name: title })).toBeVisible();
    expect(await page.evaluate<boolean>("Boolean(window.__loomrailXss)")).toBe(false);
    await page.reload();
    await expect(page.getByRole("button", { name: title })).toBeVisible();
    expect(await page.evaluate<boolean>("Boolean(window.__loomrailXss)")).toBe(false);
  });

  test("persists the full mock delivery and gates Done on owner acceptance", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Human decision workflow");
    const inspector = page.getByRole("complementary", { name: "Human decision workflow" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByRole("button", { name: "Start mock workflow" })).toBeEnabled();
    await inspector.getByRole("button", { name: "Start mock workflow" }).click();

    await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible();
    await expect(inspector.getByText("Waiting for you", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toBeVisible();

    await page.goto(new URL("/?filters=priority-urgent", daemon.baseUrl).toString());
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
    const filteredAttentionBanner = page.getByRole("button", { name: /Needs your decision/ });
    await expect(filteredAttentionBanner).toBeVisible();
    await filteredAttentionBanner.click();
    await expect(page).not.toHaveURL(/filters=/);
    await expect(page.getByRole("complementary", { name: "Human decision workflow" })).toBeVisible();

    await page.reload();
    const restoredInspector = page.getByRole("complementary", { name: "Human decision workflow" });
    await expect(
      restoredInspector.getByRole("heading", { name: "Choose the discovery depth" }),
    ).toBeVisible();

    await restoredInspector.getByRole("radio", { name: /Focused pass/ }).click();
    await restoredInspector.getByRole("button", { name: "Answer & resume" }).click();
    const workflowSection = restoredInspector
      .locator(".lr-inspector-section")
      .filter({ has: page.getByText("Workflow", { exact: true }) });
    await expect(workflowSection.getByText("Budget paused", { exact: true }).first()).toBeVisible({
      timeout: BUDGET_WALL_MS,
    });
    await expect(workflowSection.getByText("100 of 100", { exact: true })).toBeVisible();
    await expect(workflowSection.getByRole("button", { name: "Approve 200 token budget" })).toBeEnabled();
    await workflowSection.getByRole("button", { name: "Approve 200 token budget" }).click();
    await expect(workflowSection.getByText("100 of 200", { exact: true })).toBeVisible();
    await expect(workflowSection.getByRole("heading", { name: "Acceptance package" })).toBeVisible();
    await expect(workflowSection.getByText("Review report", { exact: true })).toBeVisible();
    await expect(workflowSection.getByText("QA report", { exact: true })).toBeVisible();
    await expect(workflowSection.getByText("Needs decision", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toBeVisible();
    // Each stage attempt now records its ProviderSession as well (spec §6), so a full mock delivery
    // fills more than one page of activity and the discovery decision has moved off the newest one.
    await restoredInspector.getByRole("button", { name: "Show more" }).click();
    await expect(restoredInspector.getByText("Decision recorded", { exact: true })).toBeVisible();
    const acceptanceResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/acceptance/") && response.url().endsWith("/resolve"),
    );
    await workflowSection.getByRole("button", { name: "Accept delivery" }).click();
    const acceptanceResponse = await acceptanceResponsePromise;
    expect(acceptanceResponse.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toHaveCount(0);

    // Accepted work leaves the active board, so "All issues" has to be able to show it again.
    await page.getByRole("button", { name: "All issues", exact: true }).click();
    await expect(page).toHaveURL(/scope=all/);
    const doneColumn = page
      .locator(".lr-kanban-column")
      .filter({ has: page.getByText("Done", { exact: true }) });
    await expect(doneColumn.getByRole("button", { name: "Human decision workflow" })).toBeVisible();

    // The scope survives a reload and the summary keeps describing live work only.
    await page.reload();
    await expect(page.getByRole("button", { name: "All issues", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toBeVisible();

    await page.getByRole("button", { name: "Backlog", exact: true }).click();
    await expect(page).toHaveURL(/scope=backlog/);
    await expect(page.locator(".lr-kanban-column")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
  });

  test("shows the sessions inside a running stage attempt, with occupancy, handoff, and full checkpoint text", async ({
    page,
  }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail sessions "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const title = "Task carried across two provider sessions";
      await seedHandoffAndExhaustedSessions(databasePath, title);

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

      // D5's whole point: the owner sees one attempt with its sessions nested inside, identified by
      // ordinal and how each one ended -- not a series of failures.
      const session1 = workflowSection.getByRole("listitem", { name: "Session 1" });
      const session2 = workflowSection.getByRole("listitem", { name: "Session 2" });
      await expect(session1).toBeVisible();
      await expect(session2).toBeVisible();
      await expect(session1.getByText("Handed off", { exact: true })).toBeVisible();
      await expect(session2.getByText("Context exhausted", { exact: true })).toBeVisible();

      // Occupancy and the fact a handoff was requested are both visible, per session.
      await expect(session1.getByText("Handoff requested", { exact: true })).toBeVisible();
      await expect(session1.getByText("78% of the window at handoff", { exact: true })).toBeVisible();
      await expect(session2.getByText("Handoff requested", { exact: true })).toBeVisible();
      await expect(session2.getByText("92% of the window at handoff", { exact: true })).toBeVisible();

      // Spec §4.3/§5.2: the occupancy figure is shown with how it was arrived at. Both of these
      // sessions reported a measured figure; without the qualifier a measured 92% and a guessed
      // one would read identically, and only one of them is evidence about the provider.
      await expect(session1.getByText("(measured)", { exact: true })).toBeVisible();
      await expect(session2.getByText("(measured)", { exact: true })).toBeVisible();

      // The most recently published checkpoint (session 2's) reads in full without any extra click:
      // this is what feeds the next session's context, and spec §8 requires the owner to be able to
      // read it because it is untrusted provider output.
      await expect(
        session2.getByText(
          "Landed the token refresh patch and a regression test; the retry-storm edge case is still open.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        session2.getByText("Wrote a failing regression test for the race", { exact: true }),
      ).toBeVisible();
      await expect(
        session2.getByText("Should the refresh mutex be per-session or per-user?", { exact: true }),
      ).toBeVisible();

      // The earlier checkpoint (session 1's) is collapsed by default, but its full text is one
      // keystroke away, not lost. AGENTS.md requires keyboard operability to be verified, not
      // assumed -- so this reaches the disclosure by keyboard (Tab, then Space) exactly as a
      // keyboard-only owner would, not by clicking it.
      const firstCheckpointSummary = session1.locator("summary").filter({
        hasText: "Mapped the fixture repository's auth module and located the token refresh path.",
      });
      await expect(firstCheckpointSummary).toBeVisible();
      // A closed <details> still keeps its content in the DOM (native disclosure semantics -- that
      // is what makes it keyboard-reachable), so the collapsed check must be about visibility, not
      // presence.
      await expect(
        session1.getByText("Reproduced the expiring-token bug locally", { exact: true }),
      ).not.toBeVisible();
      await firstCheckpointSummary.focus();
      await expect(firstCheckpointSummary).toBeFocused();
      await page.keyboard.press("Space");
      await expect(
        session1.getByText("Reproduced the expiring-token bug locally", { exact: true }),
      ).toBeVisible();
      await expect(
        session1.getByText("Assumed the bug was in the HTTP client retry logic -- it was not", {
          exact: true,
        }),
      ).toBeVisible();

      // The default mock provider cannot wind down on request, so losing a session's tail is normal
      // for it rather than a malfunction (spec §7).
      await expect(
        inspector.getByText(
          "This provider cannot wind down on request — losing recent work when a session is cut is expected for it.",
          { exact: true },
        ),
      ).toBeVisible();
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  // E1 gave the agent a real worktree; until now nothing in the product said where it is. The
  // owner's next move after a stage is to open that directory or run `git diff` in it, and every
  // assertion below is about a value they have to be able to read and copy in full.
  test("names the repository, branch, base commit and worktree a task's agent writes in", async ({
    page,
  }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail workspaces "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const seeded = await seedWorkspaces(databasePath);

      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });

      await page.goto(daemon.bootstrapUrl);
      await page.getByRole("button", { name: "All issues", exact: true }).click();
      await page.getByRole("button", { name: seeded.liveTitle }).click();

      const inspector = page.getByRole("complementary", { name: seeded.liveTitle });
      const workspaceSection = inspector
        .locator(".lr-inspector-section")
        .filter({ has: page.getByText("Workspace", { exact: true }) });
      await expect(workspaceSection).toBeVisible();
      await expect(workspaceSection.getByText("Ready", { exact: true })).toBeVisible();
      await expect(workspaceSection.getByText(seeded.repositoryPath, { exact: true })).toBeVisible();
      await expect(workspaceSection.getByText(seeded.branch, { exact: true })).toBeVisible();

      // The whole path, character for character -- not a prefix, not an ellipsis. A worktree path
      // the owner cannot copy in one piece is the same as no path at all, which is why this is an
      // exact match against the seeded value rather than a substring.
      const worktreePath = workspaceSection.getByText(seeded.worktreePath, { exact: true });
      await expect(worktreePath).toBeVisible();
      await expect(worktreePath).toHaveText(seeded.worktreePath);

      // Abbreviated to what `git show` resolves, with the full object id still on the element for
      // anyone who wants it. Both halves are asserted: a card that printed a truncated sha and
      // dropped the original would be showing a value it could not stand behind.
      const baseCommit = workspaceSection.locator(".workspace-identity__sha");
      await expect(baseCommit).toHaveText(seeded.baseCommit.slice(0, 12));
      await expect(baseCommit).toHaveAttribute("title", seeded.baseCommit);

      // The boundary the README states, said where the owner is looking at the work.
      await expect(
        workspaceSection.getByText(
          "Loomrail has committed nothing. The work sits in this worktree, on this branch, until you keep it or discard it.",
          { exact: true },
        ),
      ).toBeVisible();

      // Startup reconciliation found this one's worktree gone and marked it ORPHANED, which is
      // terminal: the card says so and offers no action, because Loomrail has none to offer.
      await page.getByRole("button", { name: seeded.goneTitle }).click();
      const goneInspector = page.getByRole("complementary", { name: seeded.goneTitle });
      const goneSection = goneInspector
        .locator(".lr-inspector-section")
        .filter({ has: page.getByText("Workspace", { exact: true }) });
      await expect(goneSection.getByText("Worktree gone", { exact: true })).toBeVisible();
      await expect(
        goneSection.getByText(
          "The worktree for this task is no longer on disk. Loomrail does not cut a second one, and nothing returns this workspace to service — the branch still holds whatever was committed to it.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(goneSection.getByRole("button")).toHaveCount(0);

      // A task that never needed a repository shows no section at all -- headings over blanks read
      // as a panel that failed to load.
      //
      // The absence check below must not run before the workspace query has actually resolved.
      // `WorkspacePanel` renders nothing while its query is pending, for the same reason it renders
      // nothing once the query settles with no workspace (WorkbenchPage.tsx) -- so a `toHaveCount(0)`
      // fired right after the heading (which paints from `item`, before any query starts) could be
      // satisfied at the very first poll, against a panel that has not loaded yet, and would keep
      // passing even if that panel went on to render a shell a moment later. Unlike the sibling
      // absence check upstream, there is no positive state to reach for on the workspace query
      // itself -- still-loading and genuinely-empty both render nothing -- so this borrows one from
      // `WorkflowPanel` next to it instead: it shows a loading skeleton while its own query is
      // pending, and the real "Start mock workflow" button once that query resolves. Both queries are
      // fired from the same mount, `useWorkItemWorkflow` before `useWorkItemWorkspace` in render
      // order, so proving the workflow query has landed proves the workspace one has had at least as
      // long to land too -- and a fetch to the same idle local daemon that started no later does not
      // finish meaningfully later.
      await page.getByRole("button", { name: seeded.noWorkspaceTitle }).click();
      const bareInspector = page.getByRole("complementary", { name: seeded.noWorkspaceTitle });
      await expect(
        bareInspector.getByRole("heading", { level: 2, name: seeded.noWorkspaceTitle }),
      ).toBeVisible();
      await expect(bareInspector.getByRole("button", { name: "Start mock workflow" })).toBeVisible();
      await expect(bareInspector.getByText("Workspace", { exact: true })).toHaveCount(0);
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("explains a non-budget hard pause without offering a budget action that would fail", async ({
    page,
  }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail no-progress "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const title = "Task stalled across two empty sessions";
      await seedNoProgressHardPause(databasePath, title);

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

      // The Task 11 defect: this pause has nothing to do with budget, so the banner must not claim
      // it does, and the escape hatch that only works for a budget pause must not be offered.
      // The "Budget paused" absence check runs only after the panel is confirmed rendered (the
      // "Paused: no progress" visibility assertion establishes that): asserting absence first would
      // pass on the very first poll, before the workflow query resolves, against an empty panel --
      // and would keep passing even if the banner reverted to "Budget paused".
      await expect(workflowSection.getByText("Paused: no progress", { exact: true }).first()).toBeVisible();
      await expect(workflowSection.getByText("Budget paused", { exact: true })).toHaveCount(0);
      await expect(workflowSection.getByRole("button", { name: /Approve .* token budget/ })).toHaveCount(0);

      // The owner is not stuck: the Human Request panel still renders the real question, and
      // answering it is the action that actually lifts a session-loop pause.
      await expect(
        workflowSection.getByRole("heading", {
          name: "Two provider sessions in a row published no checkpoint",
        }),
      ).toBeVisible();
      await workflowSection.getByRole("radio", { name: "Other" }).click();
      await workflowSection
        .getByRole("textbox", { name: "Other" })
        .fill("Split the WorkItem into two smaller ones and resume.");
      await workflowSection.getByRole("button", { name: "Answer & resume" }).click();
      // Milestone A1.5: resuming no longer finishes inside this click's HTTP response -- the
      // worker resumes DISCOVERY, then auto-completes PLAN, then re-hits the same deterministic
      // IMPLEMENT budget wall in the background, and the channel is what tells this page. Waiting
      // on the new pause actually landing (a presence assertion) before trusting that the old one
      // is gone keeps this from passing on the very first poll, against a panel that has not
      // caught up with the resume yet.
      await expect(workflowSection.getByText("Budget paused", { exact: true }).first()).toBeVisible({
        timeout: BUDGET_WALL_MS,
      });
      await expect(workflowSection.getByText("Paused: no progress", { exact: true })).toHaveCount(0);
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("keeps overlays mutually exclusive, dismissible, and responsive", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    const viewActionsTrigger = page.getByRole("button", { name: "Open view actions" });
    const triggerBox = await viewActionsTrigger.boundingBox();
    const iconBox = await viewActionsTrigger.locator("svg").boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    if (triggerBox && iconBox) {
      expect(Math.abs(triggerBox.y + triggerBox.height / 2 - (iconBox.y + iconBox.height / 2))).toBeLessThan(
        1,
      );
    }
    await viewActionsTrigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Open view actions");
    await expect(page.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    await expect(viewActionsTrigger).not.toHaveAttribute("title");
    await page.mouse.move(0, 0);
    await viewActionsTrigger.click();
    await expect(page.getByRole("menuitem", { name: "Copy view link" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewActionsTrigger).toBeFocused();

    const filterTrigger = page.getByRole("button", { name: "Filter tasks" });
    const displayTrigger = page.getByRole("button", { name: "Display settings" });
    const filterPopover = page.locator(".lr-filter-popover");
    const displayPopover = page.locator('.lr-popover[aria-label="Display settings"]');
    await filterTrigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Filter tasks");
    await page.mouse.move(0, 0);
    await filterTrigger.click();
    await expect(filterPopover).toBeVisible();
    await displayTrigger.click();
    await expect(filterPopover).toBeHidden();
    await expect(displayPopover).toBeVisible();
    await filterTrigger.click();
    await expect(displayPopover).toBeHidden();
    await expect(filterPopover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(filterPopover).toBeHidden();

    // An opened popover takes the focus onto its own surface rather than arming whichever control
    // happens to sit first inside it -- and so no tooltip of that control's is pulled open either.
    const sortDirection = displayPopover.getByRole("button", { name: "Sort ascending" });
    const sortTooltip = page.getByRole("tooltip", { name: "Sort ascending" });
    await displayTrigger.click();
    await expect(displayPopover).toBeFocused();
    await expect(sortTooltip).toBeHidden();
    // A select of its own answers for the Escape pressed on it, and leaves the surface standing.
    const ordering = displayPopover.getByRole("combobox", { name: "Order tasks by" });
    await ordering.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(displayPopover).toBeVisible();
    // Tab still walks the surface's own controls, and focus a keyboard placed on one does earn the
    // tooltip a click's focus did not.
    await page.keyboard.press("Shift+Tab");
    await expect(sortDirection).toBeFocused();
    await expect(sortTooltip).toBeVisible();
    // One Escape closes the popover even with that tooltip standing over it, and hands the focus
    // back to the trigger the owner pressed.
    await page.keyboard.press("Escape");
    await expect(sortTooltip).toBeHidden();
    await expect(displayPopover).toBeHidden();
    await expect(displayTrigger).toBeFocused();

    const dialogTrigger = page.getByRole("button", { name: "New task" });
    await dialogTrigger.click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();
    await expect(dialogTrigger).toBeFocused();

    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.locator(".app-surface")).toHaveCSS("margin", "0px");
    await expect
      .poll(() =>
        page.evaluate<boolean>(
          "document.documentElement.scrollWidth === document.documentElement.clientWidth",
        ),
      )
      .toBe(true);
  });

  test("keeps navigation, form controls, and persisted activity optically aligned", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    // Measure the very link that is hovered, not merely the first one in the sidebar.
    const humanRequests = page.locator(".app-nav-link").filter({ hasText: "Human requests" });
    const navBackground = async (): Promise<string> =>
      humanRequests.evaluate((element) => getComputedStyle(element).backgroundColor);
    const navBackgroundBefore = await navBackground();
    await humanRequests.hover();
    expect(await navBackground()).not.toBe(navBackgroundBefore);

    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    const submit = dialog.getByRole("button", { name: "Create task" });
    await expect(submit).toBeDisabled();
    const textField = dialog.locator(".lr-text-field");
    const projectTrigger = dialog.getByRole("combobox", { name: "Project" });
    const priorityTrigger = dialog.getByRole("combobox", { name: "Priority" });
    await expect(textField).toHaveCSS("height", "34px");
    await expect(projectTrigger).toHaveCSS("height", "34px");
    await expect(priorityTrigger).toHaveCSS("height", "34px");
    const controlBoxes = await Promise.all([
      textField.boundingBox(),
      projectTrigger.boundingBox(),
      priorityTrigger.boundingBox(),
    ]);
    expect(controlBoxes.every((box) => box !== null)).toBe(true);

    const titleLabel = dialog.locator('label[for="new-task-title"]');
    const briefLabel = dialog.locator('label[for="new-task-brief"]');
    const briefField = dialog.locator("#new-task-brief");
    const briefDescription = dialog.locator("#new-task-brief-description");
    const fieldBoxes = await Promise.all([
      titleLabel.boundingBox(),
      textField.boundingBox(),
      briefLabel.boundingBox(),
      briefField.boundingBox(),
      briefDescription.boundingBox(),
    ]);
    expect(fieldBoxes.every((box) => box !== null)).toBe(true);
    if (fieldBoxes[0] && fieldBoxes[1]) {
      expect(Math.abs(fieldBoxes[1].y - (fieldBoxes[0].y + fieldBoxes[0].height) - 6)).toBeLessThan(0.1);
    }
    if (fieldBoxes[2] && fieldBoxes[3] && fieldBoxes[4]) {
      expect(Math.abs(fieldBoxes[3].y - (fieldBoxes[2].y + fieldBoxes[2].height) - 6)).toBeLessThan(0.1);
      expect(Math.abs(fieldBoxes[4].y - (fieldBoxes[3].y + fieldBoxes[3].height) - 3)).toBeLessThan(0.1);
    }
    await expect(briefDescription).toHaveCSS("font-size", "11px");
    await expect(briefDescription).toHaveCSS("line-height", "14px");

    await projectTrigger.click();
    await expect(page.getByRole("option", { name: "Fixture web application" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Fixture API service" })).toBeVisible();
    await page.keyboard.press("Escape");

    await dialog.getByPlaceholder("What should the team deliver?").fill("Aligned persisted task");
    await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill("Verify timeline alignment.");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden();

    const createdEvent = page.locator(".lr-timeline-event").filter({ hasText: "Task created" }).first();
    const timelineBoxes = await Promise.all([
      createdEvent.boundingBox(),
      createdEvent.locator(".lr-timeline-event__icon").boundingBox(),
      createdEvent.locator("time").boundingBox(),
    ]);
    expect(timelineBoxes.every((box) => box !== null)).toBe(true);
    if (timelineBoxes[0] && timelineBoxes[1] && timelineBoxes[2]) {
      const rowCenter = timelineBoxes[0].y + timelineBoxes[0].height / 2;
      const iconCenter = timelineBoxes[1].y + timelineBoxes[1].height / 2;
      const timeCenter = timelineBoxes[2].y + timelineBoxes[2].height / 2;
      expect(Math.abs(rowCenter - iconCenter)).toBeLessThan(1);
      expect(Math.abs(rowCenter - timeCenter)).toBeLessThan(1);
    }
  });

  test("supports localized cascading filters on desktop and mobile", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Filtered persisted task");
    await page
      .getByRole("complementary", { name: "Filtered persisted task" })
      .getByRole("button", { name: "Move to Ready" })
      .click();

    const trigger = page.getByRole("button", { name: "Filter tasks" }).first();
    const triggerBoxBeforeOpen = await trigger.boundingBox();
    await trigger.click();
    const rootPopover = page.locator(".lr-filter-popover");
    await expect(rootPopover).toBeVisible();
    await expect(page.getByRole("menu", { name: "Filters options" })).toBeVisible();
    await expect(rootPopover.getByRole("menuitem")).toHaveCount(3);
    await expect(rootPopover.getByRole("separator")).toHaveCount(0);
    await expect(rootPopover).toHaveCSS("width", "191px");
    await expect(rootPopover).toHaveCSS("border-top-color", "rgb(232, 232, 234)");

    const statusItem = rootPopover.getByRole("menuitem", { name: "Status" });
    await statusItem.hover();
    const statusMenu = page.getByRole("menu", { name: "Status options" });
    await expect(statusMenu).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search Status" })).toHaveAttribute(
      "placeholder",
      "Filter…",
    );
    await page.getByRole("button", { name: "Add Ready" }).click();
    await expect(rootPopover).toBeVisible();

    const appliedFilters = page.getByRole("region", { name: "Filter tasks" });
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);
    await expect(appliedFilters).toContainText("Ready");
    // The view tabs carry no rule of their own; the board heading below is the only divider.
    await expect(page.locator(".board-toolbar")).toHaveCSS("border-bottom-width", "0px");
    await expect(appliedFilters).toHaveCSS("background-color", "rgb(239, 239, 240)");
    await expect(appliedFilters).toHaveCSS("border-radius", "10px");
    const triggerBoxAfterSelection = await trigger.boundingBox();
    if (triggerBoxBeforeOpen && triggerBoxAfterSelection) {
      expect(Math.abs(triggerBoxBeforeOpen.x - triggerBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(triggerBoxBeforeOpen.y - triggerBoxAfterSelection.y)).toBeLessThan(1);
    }

    const displayTrigger = page.getByRole("button", { name: "Display settings" });
    await displayTrigger.click();
    await expect(rootPopover).toBeHidden();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    const orderingTrigger = displaySettings.getByRole("combobox", {
      exact: true,
      name: "Order tasks by",
    });
    await orderingTrigger.click();
    const orderingOptions = page.getByRole("listbox");
    // Every offered ordering is backed by a real WorkItem field.
    await expect(orderingOptions.getByRole("option")).toHaveCount(4);
    await expect(
      orderingOptions.getByRole("option", { name: "Priority" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "500");
    await expect(
      orderingOptions.getByRole("option", { name: "Created" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "400");
    const titleOption = orderingOptions.getByRole("option", { name: "Title" });
    expect(
      await titleOption
        .locator(".lr-select-item__copy > span")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await titleOption.hover();
    await expect(titleOption).toHaveCSS("cursor", "default");
    await expect(titleOption).toHaveCSS("user-select", "none");
    await page.keyboard.press("Escape");
    await expect(orderingOptions).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(displaySettings).toBeHidden();

    await appliedFilters.getByRole("button", { name: "Clear" }).click();
    await page.setViewportSize({ height: 844, width: 390 });
    await trigger.click();
    const mobileDialog = page.locator(".lr-filter-dialog");
    await expect(page.getByRole("dialog", { name: "Filter tasks" })).toBeVisible();
    const viewport = page.viewportSize();
    const dialogBox = await mobileDialog.boundingBox();
    expect(viewport).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    if (viewport && dialogBox) {
      expect(dialogBox.width).toBeCloseTo(viewport.width, 1);
      expect(dialogBox.height).toBeCloseTo(viewport.height, 1);
    }
    await mobileDialog.getByRole("menuitem", { name: "Status" }).click();
    await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
    await expect(mobileDialog.getByRole("button", { name: "Back to Filters" })).toBeVisible();
    await mobileDialog.getByRole("button", { name: "Add Backlog" }).click();
    await expect(mobileDialog).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ height: 900, width: 1440 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(page.locator(".lr-filter-popover")).toHaveCSS("animation-duration", "0.001s");
    await page.getByRole("menuitem", { name: "Status" }).hover();
    await expect(page.locator('.lr-filter-level[data-filter-depth="1"]')).toHaveCSS(
      "transition-duration",
      "0.001s",
    );
    await page.keyboard.press("Escape");
  });

  test("orders the board by a real WorkItem field and keeps the choice in the URL", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    // The popover animates in; reduced motion keeps its controls immediately stable to click.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Zulu ordering probe");
    await createTask(page, "Alpha ordering probe");

    // Read through a retrying assertion rather than a one-shot text snapshot: a reload repaints
    // the board asynchronously, and a bare read reports the empty column it passes through.
    const backlogTitles = page
      .locator(".lr-kanban-column")
      .first()
      .locator(".task-card-button .lr-task-card__title");

    // Both tasks share a priority, so the default view falls back to newest-created first.
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);

    // Both changes are made in one popover session: closing and reopening it between them adds
    // overlay transitions that say nothing about ordering.
    await page.getByRole("button", { name: "Display settings" }).click();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    await displaySettings.getByRole("combobox", { name: "Order tasks by" }).click();
    await page.getByRole("option", { name: "Title" }).click();
    await expect(page.getByRole("listbox")).toBeHidden();

    await expect(page).toHaveURL(/order=title/);
    await expect(backlogTitles).toHaveText(["Zulu ordering probe", "Alpha ordering probe"]);

    await displaySettings.getByRole("button", { name: "Sort ascending" }).click();
    await expect(page).toHaveURL(/dir=asc/);
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);

    // The ordering survives a reload because it lives in the URL, not component state.
    await page.reload();
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);
  });

  test("hides empty delivery columns only when the owner asks for it", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Only backlog work");

    const columns = page.locator(".lr-kanban-column");
    await expect(columns).toHaveCount(4);

    await page.getByRole("button", { name: "Display settings" }).click();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    await displaySettings.getByRole("switch", { name: "Show empty columns" }).click();
    await page.keyboard.press("Escape");
    await expect(displaySettings).toBeHidden();

    await expect(page).toHaveURL(/hideEmpty=true/);
    await expect(columns).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Only backlog work" })).toBeVisible();
  });

  test("emphasises the forward move and offers no placeholder actions", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Forward move probe");

    const inspector = page.getByRole("complementary", { name: "Forward move probe" });
    const footer = inspector.locator(".task-inspector__footer");

    // Backlog has exactly one meaningful move, so no disabled placeholder is rendered beside it.
    await expect(footer.getByRole("button")).toHaveCount(1);
    const toReady = footer.getByRole("button", { name: "Move to Ready" });
    await expect(toReady).toHaveClass(/lr-button--primary/);
    await toReady.click();

    // READY allows Backlog before Running in the transition matrix; the emphasised action must
    // still be the one that carries the work forward.
    await expect(footer.getByRole("button")).toHaveCount(2);
    await expect(footer.getByRole("button", { name: "Move to Running" })).toHaveClass(/lr-button--primary/);
    await expect(footer.getByRole("button", { name: "Move to Backlog" })).not.toHaveClass(
      /lr-button--primary/,
    );
    await expect(footer.getByRole("button", { name: /No available move|No secondary action/ })).toHaveCount(
      0,
    );
  });

  test("reveals the column a selected task moved into on a narrow board", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.setViewportSize({ height: 800, width: 1024 });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Scrolled into view");

    const board = page.locator(".kanban-board-scroll");
    expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const inspector = page.getByRole("complementary", { name: "Scrolled into view" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await inspector.getByRole("button", { name: "Move to Running" }).click();
    await inspector.getByRole("button", { name: "Move to Blocked" }).click();

    const card = page.getByRole("button", { name: "Scrolled into view" });
    await expect(card).toHaveAttribute("aria-pressed", "true");
    // The card sits in the right-most column; the board must have scrolled it back into view
    // instead of leaving the visible columns looking empty. A retrying assertion is used because
    // the move re-renders the board underneath us.
    await expect(card).toBeInViewport();
  });

  test("keeps navigation reachable and free of dead ends on a phone viewport", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await page.setViewportSize({ height: 812, width: 375 });

    // The sidebar is gone at this width, so the drawer is the only route to navigation.
    await expect(page.locator(".app-sidebar")).toBeHidden();
    const openNavigation = page.getByRole("button", { name: "Open navigation" });
    await expect(openNavigation).toBeVisible();
    await openNavigation.click();

    const drawer = page.getByRole("dialog", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    // Project switching and the settings entry both have to survive the narrow layout.
    await expect(drawer.getByRole("button", { name: "Switch project" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Open settings" })).toBeVisible();

    await drawer.getByRole("link", { name: "Human requests" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/summary=needsYou/);
  });

  test("offers no navigation entry that leads nowhere", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    // Every sidebar entry resolves to a view the product actually serves.
    const links = page.locator(".app-sidebar .app-nav-link");
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("href", /^\//);
      await expect(link).not.toHaveAttribute("aria-disabled", "true");
    }

    // No control in the frame or the board toolbar is present purely for decoration.
    const disabledControls = await page
      .locator(".app-sidebar, .app-topbar, .board-toolbar")
      .locator("button:disabled, [aria-disabled='true']")
      .count();
    expect(disabledControls).toBe(0);

    // Every board scope tab switches the board rather than sitting there inert.
    for (const [name, expected] of [
      ["Backlog", /scope=backlog/],
      ["All issues", /scope=all/],
      ["Active", /^(?!.*scope=).*$/],
    ] as const) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page).toHaveURL(expected);
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
  });

  test("shows the newest activity first and loads older pages on demand", async ({ page }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail activity "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const title = "Task with a long audit trail";
      const total = await seedLongActivity(databasePath, title);

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
      const rows = inspector.locator(".inspector-activity > li");
      await expect(rows).toHaveCount(30);

      // The count admits that the loaded rows are not the whole log.
      await expect(inspector.getByText("30+", { exact: true })).toBeVisible();

      // The newest Event leads, so the current state is readable without scrolling or paging.
      await expect(rows.first()).toContainText("State changed");
      await expect(rows.first()).toContainText("Ready → Backlog");
      await expect(inspector.getByText("Task created", { exact: true })).toHaveCount(0);

      const loadMore = inspector.getByRole("button", { name: "Show more" });
      await expect(loadMore).toBeVisible();
      await loadMore.click();

      await expect(rows).toHaveCount(total);
      await expect(inspector.getByText("Task created", { exact: true })).toBeVisible();
      await expect(inspector.getByText(total.toString(), { exact: true })).toBeVisible();
      await expect(loadMore).toHaveCount(0);
    } finally {
      // The daemon holds this database open, and Windows refuses to unlink a file that still has
      // a handle on it. Releasing it here rather than in afterEach keeps the removal ordered.
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("draws inspector rules inset from the panel edge and none below the last section", async ({
    page,
  }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Inspector rule alignment");

    const inspector = page.getByRole("complementary", { name: "Inspector rule alignment" });
    const sections = inspector.locator(".lr-inspector-section");
    await expect(sections).toHaveCount(4);

    // Every rule stops short of the panel edge by the same inset the content sits at.
    const inset = await sections.first().evaluate((element) => {
      const rule = window.getComputedStyle(element, "::after");
      return { content: rule.content, left: rule.left, right: rule.right };
    });
    expect(inset.content).not.toBe("none");
    expect(inset.left).toBe("16px");
    expect(inset.right).toBe("16px");

    // The last section - the activity log - has nothing below it to separate from.
    const trailing = await sections
      .last()
      .evaluate((element) => window.getComputedStyle(element, "::after").content);
    expect(trailing).toBe("none");
  });

  test("gathers browser preferences in settings and applies board density", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Density probe");

    const card = page.locator(".lr-task-card").first();
    await expect(card).toHaveCSS("padding", "12px");

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // Both registered fixture projects are listed, with the active one marked.
    await expect(settings.getByRole("button", { name: /Fixture/ })).toHaveCount(2);

    await settings
      .getByRole("group", { name: "Board density" })
      .getByRole("button", { name: "Compact" })
      .click();
    await expect(card).toHaveCSS("padding", "8px");

    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // The preference belongs to this browser, so it has to survive a reload.
    await page.reload();
    await expect(page.locator(".lr-task-card").first()).toHaveCSS("padding", "8px");
  });

  test("keeps a resized panel across a reload without the loading shell jumping", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    const sidebar = page.locator(".app-sidebar");
    expect((await sidebar.boundingBox())?.width).toBe(240);

    // Drag the divider rather than writing storage directly, so the whole path is exercised.
    const handle = page.getByRole("separator", { name: "Resize the sidebar" });
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200);
      await page.mouse.down();
      await page.mouse.move(320, handleBox.y + 200, { steps: 8 });
      await page.mouse.up();
    }
    expect((await sidebar.boundingBox())?.width).toBe(320);

    await page.reload();
    // The width has to be in place on the very first paint, before React hydrates, or the loading
    // shell renders at the default and the layout jumps once the app mounts.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--lr-size-sidebar").trim(),
      ),
    ).toBe("320px");
    expect((await sidebar.boundingBox())?.width).toBe(320);
  });
});
