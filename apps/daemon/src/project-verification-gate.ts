import type { WorkflowDispatch } from "@loomrail/contracts";
import {
  projectVerificationAcceptanceGate,
  VERIFICATION_WORKFLOW_ACTOR_ID,
  type ProjectVerificationAcceptanceBlocker,
} from "@loomrail/domain";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";

import type { ProjectVerificationRunner } from "./verification-runner.js";

export type ProjectVerificationWorkflowGateResult =
  | { status: "READY"; configured: boolean }
  | { status: "BLOCKED"; blocker: ProjectVerificationAcceptanceBlocker }
  | { status: "MOVED" };

export type ProjectVerificationWorkflowGate = {
  beforeBrowserQA: (input: {
    dispatch: WorkflowDispatch;
    testedTree: string;
  }) => Promise<ProjectVerificationWorkflowGateResult>;
};

type GateSnapshot = {
  gate: ReturnType<typeof projectVerificationAcceptanceGate>;
  latestRunId: string | null;
  latestRunStatus: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "ERROR" | "INTERRUPTED" | null;
  planRevision: number | null;
  planContentHash: string | null;
  workItemVersion: number | null;
};

const resultOf = (snapshot: GateSnapshot): ProjectVerificationWorkflowGateResult => {
  if (snapshot.gate.status === "BLOCKED") {
    return { status: "BLOCKED", blocker: snapshot.gate.blocker };
  }
  return { status: "READY", configured: snapshot.gate.status === "READY" };
};

const needsFreshRun = (blocker: ProjectVerificationAcceptanceBlocker): boolean =>
  blocker === "RUN_MISSING" || blocker === "STALE" || blocker === "LINEAGE_MISMATCH";

/**
 * Runs the owner-approved Project Plan at the deterministic seam between independent Review and
 * Browser QA. Provider work cannot start this command: the domain accepts only the daemon's exact
 * workflow actor, and only while the WorkItem is at QA.
 */
export const createProjectVerificationWorkflowGate = (input: {
  state: Pick<LocalState, "execute" | "query">;
  runner: Pick<ProjectVerificationRunner, "wake" | "whenIdle">;
  platform: () => "darwin" | "linux" | "win32";
  createCommandId: () => string;
}): ProjectVerificationWorkflowGate => {
  const dispatchIsStillPending = (dispatchId: string): boolean => {
    const pending = input.state.query({ type: "LIST_PENDING_DISPATCHES" });
    if (pending.type !== "WORKFLOW_DISPATCHES") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification dispatch state is unavailable");
    }
    return pending.dispatches.some(({ id }) => id === dispatchId);
  };

  const readSnapshot = (dispatch: WorkflowDispatch, testedTree: string): GateSnapshot => {
    const planResult = input.state.query({
      type: "GET_PROJECT_VERIFICATION_PLAN",
      projectId: dispatch.projectId,
    });
    if (planResult.type !== "PROJECT_VERIFICATION_PLAN") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification Plan is unavailable");
    }
    const workItemResult = input.state.query({
      type: "GET_WORK_ITEM",
      workItemId: dispatch.workItemId,
    });
    if (workItemResult.type !== "WORK_ITEM" || workItemResult.workItem === null) {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification WorkItem is unavailable");
    }
    const runsResult = input.state.query({
      type: "LIST_WORK_ITEM_VERIFICATION_RUNS",
      workItemId: dispatch.workItemId,
      limit: 1,
    });
    if (runsResult.type !== "VERIFICATION_RUNS") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification Runs are unavailable");
    }
    const latestRun = runsResult.runs[0];
    const runResult =
      latestRun === undefined
        ? null
        : input.state.query({ type: "GET_VERIFICATION_RUN", runId: latestRun.id });
    if (runResult !== null && runResult.type !== "VERIFICATION_RUN") {
      throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification evidence is unavailable");
    }
    const currentRun = runResult?.run ?? undefined;
    return {
      gate: projectVerificationAcceptanceGate({
        projectId: dispatch.projectId,
        workItemId: dispatch.workItemId,
        pipelineRunId: dispatch.pipelineRunId,
        currentPlan: planResult.plan ?? undefined,
        publication: planResult.publication ?? undefined,
        latestRun: currentRun,
        checks: runResult?.checks ?? [],
        currentTree: testedTree,
      }),
      latestRunId: currentRun?.id ?? null,
      latestRunStatus: currentRun?.status ?? null,
      planRevision: planResult.plan?.revision ?? null,
      planContentHash: planResult.plan?.contentHash ?? null,
      workItemVersion: workItemResult.workItem.version,
    };
  };

  const awaitActiveRun = async (snapshot: GateSnapshot): Promise<void> => {
    if (
      snapshot.latestRunId !== null &&
      (snapshot.latestRunStatus === "QUEUED" || snapshot.latestRunStatus === "RUNNING")
    ) {
      input.runner.wake(snapshot.latestRunId);
      await input.runner.whenIdle(snapshot.latestRunId);
    }
  };

  return {
    beforeBrowserQA: async ({ dispatch, testedTree }) => {
      let snapshot = readSnapshot(dispatch, testedTree);
      if (snapshot.gate.status !== "BLOCKED") return resultOf(snapshot);

      await awaitActiveRun(snapshot);
      if (!dispatchIsStillPending(dispatch.id)) return { status: "MOVED" };
      if (snapshot.latestRunStatus === "QUEUED" || snapshot.latestRunStatus === "RUNNING") {
        snapshot = readSnapshot(dispatch, testedTree);
        if (snapshot.gate.status !== "BLOCKED") return resultOf(snapshot);
      }

      if (
        !needsFreshRun(snapshot.gate.blocker) ||
        snapshot.planRevision === null ||
        snapshot.planContentHash === null ||
        snapshot.workItemVersion === null
      ) {
        return resultOf(snapshot);
      }

      const reserved = input.state.execute({
        schemaVersion: 1,
        commandId: input.createCommandId(),
        correlationId: `verification-workflow-${dispatch.id}`,
        actor: { type: "SYSTEM", id: VERIFICATION_WORKFLOW_ACTOR_ID },
        type: "START_VERIFICATION_RUN",
        payload: {
          workItemId: dispatch.workItemId,
          expectedWorkItemVersion: snapshot.workItemVersion,
          expectedPlanRevision: snapshot.planRevision,
          expectedPlanContentHash: snapshot.planContentHash,
          implementationTree: testedTree,
          platform: input.platform(),
        },
      });
      if (reserved.type !== "VERIFICATION_RUN_RESERVED") {
        throw new StateStoreError("PERSISTENCE_FAILURE", "Project verification Run was not reserved");
      }
      input.runner.wake(reserved.run.id);
      await input.runner.whenIdle(reserved.run.id);
      if (!dispatchIsStillPending(dispatch.id)) return { status: "MOVED" };
      return resultOf(readSnapshot(dispatch, testedTree));
    },
  };
};
