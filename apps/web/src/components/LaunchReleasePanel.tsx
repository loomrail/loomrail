import { useState } from "react";
import {
  launchEnvironmentConfigurationSchema,
  type LaunchEnvironment,
  type LaunchEnvironmentConfiguration,
  type LaunchEnvironmentKind,
  type LaunchReleaseGateStatus,
  type LaunchReleaseProjectResponse,
  type Deployment,
  type DeploymentPreflightFailureCode,
  type DeploymentPreviewResponse,
  type GuidedDeploymentProjectResponse,
  type GithubActionsDeploymentTarget,
  type ListedProject,
  type WorkItem,
} from "@loomrail/contracts";
import { Button, Icon, cn } from "@loomrail/ui";

import { useI18n, type TranslationKey } from "../i18n";
import {
  useCreateLaunchRelease,
  useAdoptGuidedDeploymentPlan,
  useApproveGuidedDeployment,
  useExportLaunchEvidencePackage,
  useGuidedDeployment,
  useGuidedDeploymentPreview,
  useLaunchRelease,
  useObserveGuidedDeployment,
  useProjectWorkItems,
  useSaveLaunchEnvironment,
  useStartGuidedDeployment,
} from "../workspace";

type EnvironmentForm = {
  healthPath: string;
  kind: LaunchEnvironmentKind;
  name: string;
  publicBaseUrl: string;
  requiredEnvironmentVariables: string;
};

const formFor = (snapshot: LaunchReleaseProjectResponse, kind: LaunchEnvironmentKind): EnvironmentForm => {
  const environment = snapshot.environments.find((candidate) => candidate.kind === kind);
  return {
    kind,
    name: environment?.name ?? "",
    publicBaseUrl: environment?.publicBaseUrl ?? "",
    healthPath: environment?.healthPath ?? "/health/ready",
    requiredEnvironmentVariables: environment?.requiredEnvironmentVariables.join("\n") ?? "",
  };
};

const configurationFor = (form: EnvironmentForm): LaunchEnvironmentConfiguration | null => {
  const parsed = launchEnvironmentConfigurationSchema.safeParse({
    kind: form.kind,
    name: form.name.trim(),
    presetId: "WEB_APP_V1",
    presetRevision: 1,
    publicBaseUrl: form.publicBaseUrl.trim(),
    healthPath: form.healthPath.trim(),
    requiredEnvironmentVariables: form.requiredEnvironmentVariables
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean),
  });
  return parsed.success ? parsed.data : null;
};

const gateStatusKey = (status: LaunchReleaseGateStatus): TranslationKey => {
  switch (status) {
    case "PASSED":
      return "settings.release.gateStatus.PASSED";
    case "FAILED":
      return "settings.release.gateStatus.FAILED";
    case "ACTION_REQUIRED":
      return "settings.release.gateStatus.ACTION_REQUIRED";
    case "STALE":
      return "settings.release.gateStatus.STALE";
  }
};

const humanizeGate = (key: string): string => {
  const name = key.split("/").at(-1) ?? key;
  const words = name.toLowerCase().replaceAll("_", " ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
};

export type LaunchReleaseViewProps = {
  creating: boolean;
  exporting: boolean;
  onCreate: (environment: LaunchEnvironment, workItemIds: readonly string[]) => void;
  onExport: (releaseId: string) => void;
  onSave: (configuration: LaunchEnvironmentConfiguration, environment: LaunchEnvironment | null) => void;
  saving: boolean;
  snapshot: LaunchReleaseProjectResponse;
  workItems: readonly WorkItem[];
};

export const LaunchReleaseView = ({
  creating,
  exporting,
  onCreate,
  onExport,
  onSave,
  saving,
  snapshot,
  workItems,
}: LaunchReleaseViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const initialKind = snapshot.environments[0]?.kind ?? "PREVIEW";
  const [form, setForm] = useState(() => formFor(snapshot, initialKind));
  const [selectedWorkItemIds, setSelectedWorkItemIds] = useState<readonly string[]>(
    () => snapshot.latestRelease?.selectedWorkItems.map(({ workItemId }) => workItemId) ?? [],
  );
  const configuration = configurationFor(form);
  const environment = snapshot.environments.find(({ kind }) => kind === form.kind) ?? null;
  const configurationIsCurrent =
    configuration !== null &&
    environment !== null &&
    JSON.stringify(configuration) ===
      JSON.stringify({
        kind: environment.kind,
        name: environment.name,
        presetId: environment.presetId,
        presetRevision: environment.presetRevision,
        publicBaseUrl: environment.publicBaseUrl,
        healthPath: environment.healthPath,
        requiredEnvironmentVariables: environment.requiredEnvironmentVariables,
      });
  const update = <K extends keyof EnvironmentForm>(key: K, value: EnvironmentForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="launch-settings release-settings">
      <div className="launch-settings__heading">
        <div>
          <h4>{t("settings.release.title")}</h4>
          <p>{t("settings.release.description")}</p>
        </div>
        {snapshot.latestRelease === null ? null : (
          <span
            className={cn("launch-settings__state", snapshot.freshness?.status === "CURRENT" && "is-ready")}
          >
            <Icon name={snapshot.freshness?.status === "CURRENT" ? "check" : "warning"} size={13} />
            {t(
              snapshot.freshness?.status === "CURRENT"
                ? "settings.release.current"
                : "settings.release.stale",
            )}
          </span>
        )}
      </div>

      <div className="launch-settings__notice" role="note">
        <strong>{t("settings.release.boundaryTitle")}</strong>
        <p>{t("settings.release.boundaryNotice")}</p>
      </div>

      <div className="launch-settings__form">
        <label>
          <span>{t("settings.release.kind")}</span>
          <select
            onChange={(event) => {
              const kind = event.target.value as LaunchEnvironmentKind;
              setForm(formFor(snapshot, kind));
            }}
            value={form.kind}
          >
            <option value="PREVIEW">{t("settings.release.kind.PREVIEW")}</option>
            <option value="PRODUCTION">{t("settings.release.kind.PRODUCTION")}</option>
          </select>
        </label>
        <label>
          <span>{t("settings.release.name")}</span>
          <input
            onChange={(event) => {
              update("name", event.target.value);
            }}
            type="text"
            value={form.name}
          />
        </label>
        <label>
          <span>{t("settings.release.publicOrigin")}</span>
          <input
            onChange={(event) => {
              update("publicBaseUrl", event.target.value);
            }}
            placeholder="https://preview.example.com"
            type="text"
            value={form.publicBaseUrl}
          />
        </label>
        <label>
          <span>{t("settings.release.healthPath")}</span>
          <input
            onChange={(event) => {
              update("healthPath", event.target.value);
            }}
            type="text"
            value={form.healthPath}
          />
        </label>
        <label className="launch-settings__wide">
          <span>{t("settings.release.variables")}</span>
          <textarea
            onChange={(event) => {
              update("requiredEnvironmentVariables", event.target.value);
            }}
            rows={2}
            value={form.requiredEnvironmentVariables}
          />
        </label>
      </div>
      {configuration === null ? (
        <p className="launch-settings__error" role="alert">
          {t("settings.release.invalid")}
        </p>
      ) : null}
      <div className="launch-settings__actions">
        <Button
          disabled={configuration === null || configurationIsCurrent || creating}
          loading={saving}
          onClick={() => {
            if (configuration !== null) onSave(configuration, environment);
          }}
          type="button"
          variant="primary"
        >
          {environment === null ? t("settings.release.save") : t("settings.release.update")}
        </Button>
      </div>

      <fieldset className="release-scope">
        <legend>{t("settings.release.scope")}</legend>
        <p>{t("settings.release.scopeNotice")}</p>
        {workItems.length === 0 ? (
          <p className="settings__note">{t("settings.release.noWorkItems")}</p>
        ) : (
          workItems.map((workItem) => (
            <label key={workItem.id}>
              <input
                checked={selectedWorkItemIds.includes(workItem.id)}
                onChange={(event) => {
                  setSelectedWorkItemIds((current) =>
                    event.target.checked
                      ? [...current, workItem.id]
                      : current.filter((id) => id !== workItem.id),
                  );
                }}
                type="checkbox"
              />
              <span>{workItem.title}</span>
              <small>{workItem.state}</small>
            </label>
          ))
        )}
      </fieldset>
      <div className="launch-settings__actions">
        <Button
          disabled={environment === null || saving}
          loading={creating}
          onClick={() => {
            if (environment !== null) onCreate(environment, selectedWorkItemIds);
          }}
          type="button"
        >
          {t("settings.release.create")}
        </Button>
        {snapshot.latestRelease === null ? null : (
          <Button
            loading={exporting}
            onClick={() => {
              if (snapshot.latestRelease !== null) onExport(snapshot.latestRelease.id);
            }}
            type="button"
          >
            {t("settings.release.export")}
          </Button>
        )}
      </div>

      {snapshot.latestRelease === null ? (
        <p className="settings__note">{t("settings.release.none")}</p>
      ) : (
        <section className="launch-run" aria-label={t("settings.release.results")}>
          <div className="launch-run__heading">
            <strong>
              {t("settings.release.passed", {
                passed: snapshot.latestRelease.passedRequiredGateCount,
                required: snapshot.latestRelease.requiredGateCount,
              })}
            </strong>
            <span>{t("settings.release.tree", { tree: snapshot.latestRelease.sourceTree.slice(0, 8) })}</span>
          </div>
          <ul className="launch-gates">
            {snapshot.latestRelease.gates.map((gate) => (
              <li key={gate.key}>
                <span className={cn("launch-gates__status", `is-${gate.status.toLowerCase()}`)}>
                  <Icon name={gate.status === "PASSED" ? "check" : "warning"} size={14} />
                  {t(gateStatusKey(gate.status))}
                </span>
                <div>
                  <strong>{humanizeGate(gate.key)}</strong>
                  <p>{gate.summary}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

const deploymentBlockKey = (code: DeploymentPreflightFailureCode): TranslationKey => {
  switch (code) {
    case "RELEASE_STALE":
      return "settings.deploy.block.RELEASE_STALE";
    case "RELEASE_GATES_BLOCKED":
      return "settings.deploy.block.RELEASE_GATES_BLOCKED";
    case "ENVIRONMENT_UNSUPPORTED":
      return "settings.deploy.block.ENVIRONMENT_UNSUPPORTED";
    case "REPOSITORY_UNAVAILABLE":
      return "settings.deploy.block.REPOSITORY_UNAVAILABLE";
    case "REPOSITORY_PATH_NOT_CANONICAL":
      return "settings.deploy.block.REPOSITORY_PATH_NOT_CANONICAL";
    case "REPOSITORY_OPERATION_IN_PROGRESS":
      return "settings.deploy.block.REPOSITORY_OPERATION_IN_PROGRESS";
    case "SOURCE_DIRTY":
      return "settings.deploy.block.SOURCE_DIRTY";
    case "DETACHED_HEAD":
      return "settings.deploy.block.DETACHED_HEAD";
    case "REMOTE_INVALID":
      return "settings.deploy.block.REMOTE_INVALID";
    case "WORKFLOW_MISSING":
      return "settings.deploy.block.WORKFLOW_MISSING";
    case "WORKFLOW_NOT_REGULAR":
      return "settings.deploy.block.WORKFLOW_NOT_REGULAR";
    case "WORKFLOW_TRIGGER_MISSING":
      return "settings.deploy.block.WORKFLOW_TRIGGER_MISSING";
    case "WORKFLOW_TOO_LARGE":
      return "settings.deploy.block.WORKFLOW_TOO_LARGE";
    case "CLI_UNAVAILABLE":
      return "settings.deploy.block.CLI_UNAVAILABLE";
    case "AUTH_REQUIRED":
      return "settings.deploy.block.AUTH_REQUIRED";
    case "REMOTE_BRANCH_UNAVAILABLE":
      return "settings.deploy.block.REMOTE_BRANCH_UNAVAILABLE";
    case "REMOTE_COMMIT_MISMATCH":
      return "settings.deploy.block.REMOTE_COMMIT_MISMATCH";
    case "PREVIEW_PROMOTION_REQUIRED":
      return "settings.deploy.block.PREVIEW_PROMOTION_REQUIRED";
  }
};

const DeploymentTarget = ({ target }: { target: GithubActionsDeploymentTarget }): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <dl className="deployment-target">
      <div>
        <dt>{t("settings.deploy.environment")}</dt>
        <dd>
          {target.presetId === "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2"
            ? t(`settings.deploy.environment.${target.environmentKind}`)
            : t("settings.deploy.environment.LEGACY")}
        </dd>
      </div>
      <div>
        <dt>{t("settings.deploy.repository")}</dt>
        <dd>{target.repositorySlug}</dd>
      </div>
      <div>
        <dt>{t("settings.deploy.branch")}</dt>
        <dd>{target.branch}</dd>
      </div>
      <div>
        <dt>{t("settings.deploy.commit")}</dt>
        <dd>{target.commitSha.slice(0, 12)}</dd>
      </div>
      <div>
        <dt>{t("settings.deploy.workflow")}</dt>
        <dd>{target.workflowPath}</dd>
      </div>
    </dl>
  );
};

export type GuidedDeploymentViewProps = {
  adopting: boolean;
  approving: boolean;
  observing: boolean;
  onAdopt: (preview: DeploymentPreviewResponse) => void;
  onApprove: (deployment: Deployment) => void;
  onObserve: (deployment: Deployment) => void;
  onStart: (deployment: Deployment) => void;
  preview: DeploymentPreviewResponse | null;
  previewLoading: boolean;
  releaseId: string | null;
  snapshot: GuidedDeploymentProjectResponse;
  starting: boolean;
};

export const GuidedDeploymentView = ({
  adopting,
  approving,
  observing,
  onAdopt,
  onApprove,
  onObserve,
  onStart,
  preview,
  previewLoading,
  releaseId,
  snapshot,
  starting,
}: GuidedDeploymentViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const deployment = snapshot.latestDeployment?.releaseId === releaseId ? snapshot.latestDeployment : null;
  const plan = deployment?.planId === snapshot.latestPlan?.id ? snapshot.latestPlan : null;
  const target = plan?.target ?? (preview?.status === "READY" ? preview.target : null);
  const environmentKind =
    plan?.revision === 2
      ? plan.environmentKind
      : preview?.status === "READY"
        ? preview.target.environmentKind
        : null;
  const canAdopt =
    preview?.status === "READY" &&
    (deployment === null || deployment.status === "FAILED") &&
    deployment?.failureCode !== "DISPATCH_OUTCOME_UNKNOWN";

  return (
    <section className="launch-settings deployment-settings" aria-label={t("settings.deploy.title")}>
      <div className="launch-settings__heading">
        <div>
          <h4>{t("settings.deploy.title")}</h4>
          <p>{t("settings.deploy.description")}</p>
        </div>
        {deployment === null ? null : (
          <span className={cn("launch-settings__state", deployment.status === "SUCCEEDED" && "is-ready")}>
            <Icon name={deployment.status === "SUCCEEDED" ? "check" : "warning"} size={13} />
            {t(`settings.deploy.status.${deployment.status}`)}
          </span>
        )}
      </div>

      <div className="launch-settings__notice" role="note">
        <strong>{t("settings.deploy.boundaryTitle")}</strong>
        <p>{t("settings.deploy.boundaryNotice")}</p>
      </div>

      {releaseId === null ? (
        <p className="settings__note">{t("settings.deploy.noRelease")}</p>
      ) : previewLoading ? (
        <p className="settings__note">{t("settings.deploy.loading")}</p>
      ) : preview?.status === "BLOCKED" ? (
        <div className="deployment-message" role="status">
          <Icon name="warning" size={16} />
          <p>{t(deploymentBlockKey(preview.code))}</p>
        </div>
      ) : null}

      {target === null ? null : <DeploymentTarget target={target} />}

      {deployment?.status === "PENDING_APPROVAL" ? (
        <div className="deployment-confirmation">
          <p>
            {t("settings.deploy.approvalNotice", {
              environment: t(`settings.deploy.environment.${environmentKind ?? "LEGACY"}`),
            })}
          </p>
          <Button
            loading={approving}
            onClick={() => {
              onApprove(deployment);
            }}
            type="button"
            variant="primary"
          >
            {t("settings.deploy.approve")}
          </Button>
        </div>
      ) : null}

      {deployment?.status === "APPROVED" ? (
        <div className="deployment-confirmation">
          <p>
            {t("settings.deploy.approvedNotice", {
              environment: t(`settings.deploy.environment.${environmentKind ?? "LEGACY"}`),
            })}
          </p>
          <Button
            loading={starting}
            onClick={() => {
              onStart(deployment);
            }}
            type="button"
          >
            {t("settings.deploy.startApproved")}
          </Button>
        </div>
      ) : null}

      {deployment?.status === "UNKNOWN" ? (
        <div className="deployment-message is-critical" role="alert">
          <Icon name="warning" size={16} />
          <p>{t("settings.deploy.unknownNotice")}</p>
        </div>
      ) : null}

      {deployment?.status === "FAILED" ? (
        <div className="deployment-message" role="status">
          <Icon name="warning" size={16} />
          <p>{t("settings.deploy.failedNotice", { code: deployment.failureCode ?? "UNKNOWN" })}</p>
        </div>
      ) : null}

      {deployment?.remoteRunUrl === null || deployment === null ? null : (
        <p className="deployment-run-link">
          <a href={deployment.remoteRunUrl} rel="noreferrer" target="_blank">
            {t("settings.deploy.openRun")}
          </a>
        </p>
      )}

      {deployment !== null &&
      ["RUNNING", "UNKNOWN"].includes(deployment.status) &&
      deployment.remoteRunId !== null ? (
        <div className="launch-settings__actions">
          <Button
            loading={observing}
            onClick={() => {
              onObserve(deployment);
            }}
            type="button"
          >
            {t("settings.deploy.observe")}
          </Button>
        </div>
      ) : null}

      {canAdopt ? (
        <div className="deployment-confirmation">
          <p>
            {t("settings.deploy.planNotice", {
              environment: t(`settings.deploy.environment.${environmentKind ?? "LEGACY"}`),
            })}
          </p>
          <Button
            loading={adopting}
            onClick={() => {
              onAdopt(preview);
            }}
            type="button"
          >
            {deployment === null ? t("settings.deploy.adopt") : t("settings.deploy.adoptAgain")}
          </Button>
        </div>
      ) : null}

      <p className="settings__note">{t("settings.deploy.rollbackUnavailable")}</p>
    </section>
  );
};

const GuidedDeploymentPanel = ({
  projectId,
  releaseId,
}: {
  projectId: string;
  releaseId: string | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  const snapshotQuery = useGuidedDeployment(projectId);
  const previewQuery = useGuidedDeploymentPreview(projectId, releaseId ?? undefined);
  const adopt = useAdoptGuidedDeploymentPlan();
  const approve = useApproveGuidedDeployment();
  const start = useStartGuidedDeployment();
  const observe = useObserveGuidedDeployment();
  const snapshot = snapshotQuery.data;
  const error =
    adopt.error instanceof Error
      ? adopt.error
      : approve.error instanceof Error
        ? approve.error
        : start.error instanceof Error
          ? start.error
          : observe.error instanceof Error
            ? observe.error
            : snapshotQuery.error instanceof Error
              ? snapshotQuery.error
              : previewQuery.error instanceof Error
                ? previewQuery.error
                : null;

  if (snapshot === undefined) {
    return (
      <section className="launch-settings deployment-settings">
        <h4>{t("settings.deploy.title")}</h4>
        <p className={error === null ? "settings__note" : "launch-settings__error"}>
          {error?.message ?? t("settings.deploy.loading")}
        </p>
      </section>
    );
  }

  return (
    <>
      <GuidedDeploymentView
        adopting={adopt.isPending}
        approving={approve.isPending}
        observing={observe.isPending}
        onAdopt={(preview) => {
          adopt.mutate(preview);
        }}
        onApprove={(deployment) => {
          approve.mutate(deployment);
        }}
        onObserve={(deployment) => {
          observe.mutate(deployment);
        }}
        onStart={(deployment) => {
          start.mutate(deployment);
        }}
        preview={previewQuery.data ?? null}
        previewLoading={releaseId !== null && previewQuery.isPending}
        releaseId={releaseId}
        snapshot={snapshot}
        starting={start.isPending}
      />
      {error === null ? null : (
        <p className="launch-settings__error" role="alert">
          {error.message}
        </p>
      )}
    </>
  );
};

const downloadEvidence = (releaseId: string, markdown: string): void => {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `loomrail-release-${releaseId}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const LaunchReleasePanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const snapshotQuery = useLaunchRelease(project.id);
  const workItemsQuery = useProjectWorkItems(project.id);
  const save = useSaveLaunchEnvironment();
  const create = useCreateLaunchRelease();
  const exportEvidence = useExportLaunchEvidencePackage();
  const snapshot = snapshotQuery.data;
  const error =
    save.error instanceof Error
      ? save.error
      : create.error instanceof Error
        ? create.error
        : exportEvidence.error instanceof Error
          ? exportEvidence.error
          : snapshotQuery.error instanceof Error
            ? snapshotQuery.error
            : workItemsQuery.error instanceof Error
              ? workItemsQuery.error
              : null;

  if (snapshot === undefined || workItemsQuery.data === undefined) {
    return (
      <div className="launch-settings release-settings">
        <h4>{t("settings.release.title")}</h4>
        <p className={error === null ? "settings__note" : "launch-settings__error"}>
          {error?.message ?? t("settings.release.loading")}
        </p>
      </div>
    );
  }

  return (
    <>
      <LaunchReleaseView
        creating={create.isPending}
        exporting={exportEvidence.isPending}
        key={`${snapshot.environments.map(({ id, version }) => `${id}:${version.toString()}`).join(",")}:${snapshot.latestRelease?.id ?? "none"}`}
        onCreate={(environment, workItemIds) => {
          create.mutate({ environment, snapshot, workItemIds });
        }}
        onExport={(releaseId) => {
          exportEvidence.mutate(releaseId, {
            onSuccess: (evidence) => {
              downloadEvidence(evidence.releaseId, evidence.markdown);
            },
          });
        }}
        onSave={(configuration, environment) => {
          save.mutate({ configuration, environment, snapshot });
        }}
        saving={save.isPending}
        snapshot={snapshot}
        workItems={workItemsQuery.data.workItems.filter(({ state }) => state !== "CANCELLED")}
      />
      <GuidedDeploymentPanel projectId={project.id} releaseId={snapshot.latestRelease?.id ?? null} />
      {error === null ? null : (
        <p className="launch-settings__error" role="alert">
          {error.message}
        </p>
      )}
    </>
  );
};
