import type {
  CompleteQARunCommand,
  Project,
  QADriverResult,
  QAFinalizedAttachment,
  QAPlanSnapshot,
  QARetestCell,
  QARunScope,
  WorkflowDispatch,
} from "@loomrail/contracts";
import type { BrowserDriver, BrowserDriverExecution } from "@loomrail/browser-qa";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

import {
  unavailableBrowserQAConfig,
  type BrowserQAConfigResolution,
  type BrowserQAConfigResolver,
} from "./browser-qa-config.js";

export type BrowserQAStageRunner = {
  run: (input: { dispatch: WorkflowDispatch; agentRunId: string; testedTree: string }) => Promise<void>;
};

export type BrowserQAStageRunnerDeps = {
  state: LocalState;
  driver: BrowserDriver;
  resolveConfig: BrowserQAConfigResolver;
  createCommandId: () => string;
  createAttachmentId: () => string;
  logger: FastifyBaseLogger;
};

const readProject = (state: LocalState, projectId: string): Project => {
  const result = state.query({ type: "GET_PROJECT", projectId });
  if (result.type !== "PROJECT" || result.project === null) {
    throw new StateStoreError("PROJECT_NOT_FOUND", "The Browser QA Project does not exist");
  }
  return result.project;
};

export const createBrowserQAStageRunner = (deps: BrowserQAStageRunnerDeps): BrowserQAStageRunner => ({
  run: async ({ dispatch, agentRunId, testedTree }) => {
    const workflow = deps.state.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: dispatch.workItemId,
    });
    if (workflow.type !== "WORKFLOW_SNAPSHOT") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA workflow could not be loaded");
    }
    const stageAttempt = workflow.snapshot.stageAttempts.find(({ id }) => id === dispatch.stageAttemptId);
    if (stageAttempt === undefined) {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA StageAttempt could not be loaded");
    }

    let targetOrigin: string;
    let plan: QAPlanSnapshot;
    let scope: QARunScope;
    let retestCells: readonly QARetestCell[] | undefined;
    let configError: Extract<QADriverResult, { outcome: "ERROR" }> | null = null;
    if (stageAttempt.correctionRunId === null) {
      let config: BrowserQAConfigResolution;
      try {
        config = await deps.resolveConfig(readProject(deps.state, dispatch.projectId));
      } catch {
        config = unavailableBrowserQAConfig(
          "The project Browser QA configuration could not be loaded safely. Fix it before retrying QA.",
        );
      }
      targetOrigin = config.targetOrigin;
      plan = config.plan;
      scope = { type: "FULL" };
      if (config.status === "ERROR") configError = config.error;
    } else {
      const qaState = deps.state.query({ type: "GET_QA_STATE", pipelineRunId: dispatch.pipelineRunId });
      if (qaState.type !== "QA_STATE") {
        throw new StateStoreError("PERSISTENCE_FAILURE", "The QA correction state could not be loaded");
      }
      const correction = qaState.correctionRuns.find(
        ({ id, status }) => id === stageAttempt.correctionRunId && status === "ACTIVE",
      );
      const retestPlan = qaState.retestPlans.find(
        ({ correctionRunId }) => correctionRunId === stageAttempt.correctionRunId,
      );
      const baseline = qaState.runs.find(({ id }) => id === correction?.baselineQARunId);
      if (correction === undefined || retestPlan === undefined || baseline?.status !== "FAILED") {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The active QA correction is missing its failed baseline or immutable retest plan",
        );
      }
      targetOrigin = baseline.targetOrigin;
      plan = baseline.plan;
      scope = {
        type: "RETEST",
        correctionRunId: correction.id,
        retestPlanId: retestPlan.id,
      };
      retestCells = retestPlan.cells;
    }

    const reserved = deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: `dispatch-${dispatch.id}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RESERVE_QA_RUN",
      payload: {
        stageAttemptId: dispatch.stageAttemptId,
        agentRunId,
        testedTree,
        targetOrigin,
        plan,
        scope,
      },
    });
    if (reserved.type !== "QA_RUN_RESERVED") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA reservation was not recorded");
    }

    let execution: BrowserDriverExecution | undefined;
    let result: QADriverResult;
    let finalizedAttachments: QAFinalizedAttachment[] = [];
    if (configError !== null) {
      result = configError;
    } else {
      try {
        execution = await deps.driver.run(reserved.qaRun, retestCells);
        result = execution.result;
        finalizedAttachments = [
          ...(await execution.finalizeAttachments({
            qaRunId: reserved.qaRun.id,
            createAttachmentId: deps.createAttachmentId,
          })),
        ];
      } catch (error: unknown) {
        deps.logger.error(
          {
            dispatchId: dispatch.id,
            qaRunId: reserved.qaRun.id,
            error: error instanceof Error ? error.name : "unknown",
          },
          "The Browser QA driver failed before it returned bounded evidence",
        );
        result = {
          outcome: "ERROR",
          code: "DRIVER_CRASHED",
          summary: "The Playwright driver crashed before it returned bounded evidence.",
        };
        finalizedAttachments = [];
      } finally {
        await execution?.dispose().catch((error: unknown) => {
          deps.logger.warn(
            {
              dispatchId: dispatch.id,
              qaRunId: reserved.qaRun.id,
              error: error instanceof Error ? error.name : "unknown",
            },
            "The Browser QA quarantine directory could not be disposed cleanly",
          );
        });
      }
    }

    const completionCommand: CompleteQARunCommand = {
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: `dispatch-${dispatch.id}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "COMPLETE_QA_RUN",
      payload: {
        qaRunId: reserved.qaRun.id,
        expectedVersion: reserved.qaRun.version,
        currentTree: testedTree,
        result,
        finalizedAttachments,
      },
    };
    const completed = deps.state.execute(completionCommand);
    if (completed.type !== "QA_RUN_COMPLETED") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "The Browser QA completion was not recorded");
    }
    await execution?.confirmAttachments().catch((error: unknown) => {
      deps.logger.warn(
        {
          dispatchId: dispatch.id,
          qaRunId: reserved.qaRun.id,
          error: error instanceof Error ? error.name : "unknown",
        },
        "The committed Browser QA attachment marker remains pending for startup recovery",
      );
    });
  },
});
