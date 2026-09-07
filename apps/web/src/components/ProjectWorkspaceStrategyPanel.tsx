/* Hallmark · component: Project workspace strategy · genre: modern-minimal · theme: Loomrail
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited from @loomrail/ui semantic tokens
 * pre-emit critique: P5 H4 E4 S5 R5 V5
 */
import { useState } from "react";
import type { ListedProject, ProjectWorkspaceStrategySelection } from "@loomrail/contracts";
import { Button, Checkbox } from "@loomrail/ui";

import { useI18n } from "../i18n";
import { useProjectWorkspaceStrategy, useSetProjectWorkspaceStrategy } from "../workspace";

type ProjectWorkspaceStrategyViewProps = {
  acceptedRisk: boolean;
  confirmingShared: boolean;
  error: string | null;
  onAcceptedRiskChange: (accepted: boolean) => void;
  onCancelShared: () => void;
  onConfirmShared: () => void;
  onRequestShared: () => void;
  onSelectIsolated: () => void;
  repositoryPath: string;
  saving: boolean;
  selection: ProjectWorkspaceStrategySelection;
};

export const ProjectWorkspaceStrategyView = ({
  acceptedRisk,
  confirmingShared,
  error,
  onAcceptedRiskChange,
  onCancelShared,
  onConfirmShared,
  onRequestShared,
  onSelectIsolated,
  repositoryPath,
  saving,
  selection,
}: ProjectWorkspaceStrategyViewProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <div className="workspace-strategy-settings">
      <div className="workspace-strategy-settings__heading">
        <h4>{t("settings.workspaceStrategy.title")}</h4>
        <p>{t("settings.workspaceStrategy.description")}</p>
      </div>

      <fieldset className="workspace-strategy-settings__choices">
        <legend>{t("settings.workspaceStrategy.label")}</legend>
        <label>
          <input
            checked={selection.strategy === "ISOLATED_WORKTREE"}
            disabled={saving}
            name="project-workspace-strategy"
            onChange={onSelectIsolated}
            type="radio"
            value="ISOLATED_WORKTREE"
          />
          <span>
            <strong>{t("settings.workspaceStrategy.isolated")}</strong>
            <small>{t("settings.workspaceStrategy.isolatedDescription")}</small>
          </span>
        </label>
        <label>
          <input
            checked={selection.strategy === "SHARED_CURRENT_DIRECTORY"}
            disabled={saving}
            name="project-workspace-strategy"
            onChange={onRequestShared}
            type="radio"
            value="SHARED_CURRENT_DIRECTORY"
          />
          <span>
            <strong>{t("settings.workspaceStrategy.shared")}</strong>
            <small>{t("settings.workspaceStrategy.sharedDescription", { path: repositoryPath })}</small>
          </span>
        </label>
      </fieldset>

      <p className="workspace-strategy-settings__scope" role="note">
        {t("settings.workspaceStrategy.scope")}
      </p>

      {confirmingShared ? (
        <div className="workspace-strategy-settings__confirmation" role="note">
          <strong>{t("settings.workspaceStrategy.confirmTitle")}</strong>
          <p>{t("settings.workspaceStrategy.confirmDescription", { path: repositoryPath })}</p>
          <ul>
            <li>{t("settings.workspaceStrategy.confirmFiles")}</li>
            <li>{t("settings.workspaceStrategy.confirmExternalTools")}</li>
            <li>{t("settings.workspaceStrategy.confirmSerial")}</li>
          </ul>
          <Checkbox
            checked={acceptedRisk}
            label={t("settings.workspaceStrategy.acknowledge")}
            onCheckedChange={(checked) => {
              onAcceptedRiskChange(checked === true);
            }}
          />
          <div className="workspace-strategy-settings__actions">
            <Button disabled={!acceptedRisk} loading={saving} onClick={onConfirmShared} variant="primary">
              {t("settings.workspaceStrategy.confirm")}
            </Button>
            <Button disabled={saving} onClick={onCancelShared}>
              {t("action.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {error === null ? null : (
        <p className="workspace-strategy-settings__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export const ProjectWorkspaceStrategyPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const strategyQuery = useProjectWorkspaceStrategy(project.id);
  const setStrategy = useSetProjectWorkspaceStrategy();
  const [confirmingShared, setConfirmingShared] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const selection = strategyQuery.data?.selection;

  const operationError =
    setStrategy.error instanceof Error
      ? setStrategy.error.message
      : strategyQuery.error instanceof Error
        ? strategyQuery.error.message
        : null;

  if (selection === undefined) {
    return (
      <div className="workspace-strategy-settings">
        <div className="workspace-strategy-settings__heading">
          <h4>{t("settings.workspaceStrategy.title")}</h4>
          <p>{t("settings.workspaceStrategy.description")}</p>
        </div>
        <p className="settings__note">{operationError ?? t("settings.workspaceStrategy.loading")}</p>
      </div>
    );
  }

  return (
    <ProjectWorkspaceStrategyView
      acceptedRisk={acceptedRisk}
      confirmingShared={confirmingShared}
      error={operationError}
      onAcceptedRiskChange={setAcceptedRisk}
      onCancelShared={() => {
        setConfirmingShared(false);
        setAcceptedRisk(false);
      }}
      onConfirmShared={() => {
        if (!acceptedRisk) return;
        setStrategy.mutate(
          { selection, strategy: "SHARED_CURRENT_DIRECTORY" },
          {
            onSuccess: () => {
              setConfirmingShared(false);
              setAcceptedRisk(false);
            },
          },
        );
      }}
      onRequestShared={() => {
        if (selection.strategy === "SHARED_CURRENT_DIRECTORY") return;
        setStrategy.reset();
        setAcceptedRisk(false);
        setConfirmingShared(true);
      }}
      onSelectIsolated={() => {
        setConfirmingShared(false);
        setAcceptedRisk(false);
        if (selection.strategy === "ISOLATED_WORKTREE") return;
        setStrategy.reset();
        setStrategy.mutate({ selection, strategy: "ISOLATED_WORKTREE" });
      }}
      repositoryPath={project.repositoryPath}
      saving={setStrategy.isPending}
      selection={selection}
    />
  );
};
