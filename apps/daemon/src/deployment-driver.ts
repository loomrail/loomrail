import type {
  DeploymentDispatchOutcome,
  DeploymentObservationOutcome,
  DeploymentPreflightFailureCode,
  GithubActionsDeploymentTarget,
  GithubActionsDeploymentTargetV2,
  LaunchEnvironmentKind,
} from "@loomrail/contracts";

export type DeploymentPreflightResult =
  | { type: "READY"; target: GithubActionsDeploymentTargetV2 }
  | { type: "BLOCKED"; code: DeploymentPreflightFailureCode };

export type DeploymentDriver = {
  preflight: (input: {
    repositoryPath: string;
    releaseTree: string;
    environmentKind: LaunchEnvironmentKind;
    signal?: AbortSignal;
  }) => Promise<DeploymentPreflightResult>;
  dispatch: (input: {
    repositoryPath: string;
    releaseTree: string;
    target: GithubActionsDeploymentTarget;
    signal?: AbortSignal;
  }) => Promise<DeploymentDispatchOutcome>;
  observe: (input: {
    target: GithubActionsDeploymentTarget;
    runId: number;
    signal?: AbortSignal;
  }) => Promise<DeploymentObservationOutcome>;
};
