import type { DeploymentObservationOutcome, StateCommandResult } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";

import type { DeploymentDriver } from "./deployment-driver.js";

type DeploymentRunnerLogger = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

type ActiveDeployment = {
  controller: AbortController;
  promise: Promise<void>;
};

export type DeploymentRunner = {
  wake: (deploymentId: string) => void;
  observe: (input: { deploymentId: string; commandId: string; correlationId: string }) => Promise<void>;
  cancel: (deploymentId: string) => Promise<boolean>;
  recover: () => Promise<void>;
  whenIdle: (deploymentId?: string) => Promise<void>;
  stop: () => Promise<void>;
};

export const createDeploymentRunner = (input: {
  state: Pick<LocalState, "query" | "execute">;
  driver: DeploymentDriver;
  createCommandId: () => string;
  now: () => Date;
  logger: DeploymentRunnerLogger;
}): DeploymentRunner => {
  const active = new Map<string, ActiveDeployment>();

  const correlationId = (deploymentId: string): string =>
    `deployment-${deploymentId}-${input.now().getTime().toString()}`;

  const contextFor = (deploymentId: string) => {
    const context = input.state.query({ type: "GET_DEPLOYMENT_CONTEXT", deploymentId });
    return context.type === "DEPLOYMENT_CONTEXT" ? context : null;
  };

  const recordUnknown = (deploymentId: string): void => {
    const current = contextFor(deploymentId);
    if (current?.deployment.status !== "RUNNING" || current.deployment.remoteRunId !== null) return;
    input.state.execute({
      schemaVersion: 1,
      commandId: input.createCommandId(),
      correlationId: correlationId(deploymentId),
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "RECORD_DEPLOYMENT_DISPATCH",
      payload: {
        deploymentId,
        expectedVersion: current.deployment.version,
        outcome: { type: "UNKNOWN" },
      },
    });
  };

  const run = async (deploymentId: string, controller: AbortController): Promise<void> => {
    const initial = contextFor(deploymentId);
    if (initial?.deployment.status !== "APPROVED") return;
    const started = input.state.execute({
      schemaVersion: 1,
      commandId: input.createCommandId(),
      correlationId: correlationId(deploymentId),
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "START_DEPLOYMENT",
      payload: { deploymentId, expectedVersion: initial.deployment.version },
    });
    if (started.type !== "DEPLOYMENT_CHANGED" || started.deployment.status !== "RUNNING") return;

    try {
      const outcome = await input.driver.dispatch({
        repositoryPath: initial.project.repositoryPath,
        releaseTree: initial.release.sourceTree,
        target: initial.plan.target,
        signal: controller.signal,
      });
      const current = contextFor(deploymentId);
      if (
        current?.deployment.status !== "RUNNING" ||
        current.deployment.remoteRunId !== null ||
        current.deployment.version !== started.deployment.version
      ) {
        return;
      }
      input.state.execute({
        schemaVersion: 1,
        commandId: input.createCommandId(),
        correlationId: correlationId(deploymentId),
        actor: { type: "SYSTEM", id: "deployment-runner" },
        type: "RECORD_DEPLOYMENT_DISPATCH",
        payload: {
          deploymentId,
          expectedVersion: current.deployment.version,
          outcome,
        },
      });
    } catch (error: unknown) {
      input.logger.error(
        { deploymentId, errorName: error instanceof Error ? error.name : "UnknownError" },
        "Deployment driver failed outside its typed boundary",
      );
      recordUnknown(deploymentId);
    }
  };

  const wake = (deploymentId: string): void => {
    if (active.has(deploymentId)) return;
    const controller = new AbortController();
    const promise = run(deploymentId, controller)
      .catch((error: unknown) => {
        input.logger.error(
          { deploymentId, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Deployment runner failed",
        );
      })
      .finally(() => {
        if (active.get(deploymentId)?.promise === promise) active.delete(deploymentId);
      });
    active.set(deploymentId, { controller, promise });
  };

  const observe = async (observation: {
    deploymentId: string;
    commandId: string;
    correlationId: string;
  }): Promise<void> => {
    const deploymentId = observation.deploymentId;
    const initial = contextFor(deploymentId);
    if (
      initial === null ||
      (initial.deployment.status !== "RUNNING" && initial.deployment.status !== "UNKNOWN") ||
      initial.deployment.remoteRunId === null
    ) {
      return;
    }
    const runId = initial.deployment.remoteRunId;
    let outcome: DeploymentObservationOutcome;
    try {
      outcome = await input.driver.observe({ target: initial.plan.target, runId });
    } catch (error: unknown) {
      input.logger.error(
        { deploymentId, errorName: error instanceof Error ? error.name : "UnknownError" },
        "Deployment observation failed outside its typed boundary",
      );
      outcome = { type: "UNKNOWN" };
    }
    const current = contextFor(deploymentId);
    if (
      current?.deployment.version !== initial.deployment.version ||
      current.deployment.remoteRunId !== runId
    ) {
      return;
    }
    input.state.execute({
      schemaVersion: 1,
      commandId: observation.commandId,
      correlationId: observation.correlationId,
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "RECORD_DEPLOYMENT_OBSERVATION",
      payload: {
        deploymentId,
        expectedVersion: current.deployment.version,
        observedRunId: runId,
        outcome,
      },
    });
  };

  return {
    wake,
    observe,
    cancel: async (deploymentId) => {
      const running = active.get(deploymentId);
      if (running === undefined) return false;
      running.controller.abort();
      await running.promise;
      return true;
    },
    recover: () => {
      const result = input.state.query({ type: "LIST_ACTIVE_DEPLOYMENTS" });
      if (result.type !== "DEPLOYMENTS") return Promise.resolve();
      for (const deployment of result.deployments) {
        if (deployment.status !== "RUNNING") continue;
        const changed: StateCommandResult = input.state.execute({
          schemaVersion: 1,
          commandId: input.createCommandId(),
          correlationId: correlationId(deployment.id),
          actor: { type: "SYSTEM", id: "local-daemon" },
          type: "RECONCILE_DEPLOYMENT",
          payload: { deploymentId: deployment.id, expectedVersion: deployment.version },
        });
        if (changed.type !== "DEPLOYMENT_CHANGED") {
          throw new Error("Deployment reconciliation returned an unexpected result");
        }
      }
      return Promise.resolve();
    },
    whenIdle: async (deploymentId) => {
      if (deploymentId !== undefined) {
        await active.get(deploymentId)?.promise;
        return;
      }
      await Promise.all([...active.values()].map(({ promise }) => promise));
    },
    stop: async () => {
      const running = [...active.values()];
      for (const item of running) item.controller.abort();
      await Promise.all(running.map(({ promise }) => promise));
    },
  };
};
