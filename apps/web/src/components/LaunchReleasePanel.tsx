import { useState } from "react";
import {
  launchEnvironmentConfigurationSchema,
  type LaunchEnvironment,
  type LaunchEnvironmentConfiguration,
  type LaunchEnvironmentKind,
  type LaunchReleaseGateStatus,
  type LaunchReleaseProjectResponse,
  type ListedProject,
  type WorkItem,
} from "@loomrail/contracts";
import { Button, Icon, cn } from "@loomrail/ui";

import { useI18n, type TranslationKey } from "../i18n";
import {
  useCreateLaunchRelease,
  useExportLaunchEvidencePackage,
  useLaunchRelease,
  useProjectWorkItems,
  useSaveLaunchEnvironment,
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
      {error === null ? null : (
        <p className="launch-settings__error" role="alert">
          {error.message}
        </p>
      )}
    </>
  );
};
