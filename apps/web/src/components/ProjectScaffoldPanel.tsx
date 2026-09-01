import { useEffect, useId, useState } from "react";

import type { ScaffoldOperation, ScaffoldProposal } from "@loomrail/contracts";
import { Button, Field, Icon, TextField } from "@loomrail/ui";

import { useI18n } from "../i18n";
import {
  useProposeProjectScaffold,
  useOpenProjectScaffolds,
  usePublishProjectScaffold,
  useRetryProjectScaffold,
  useWorkspace,
} from "../workspace";

export const ProjectScaffoldPanel = (): React.JSX.Element => {
  const { t } = useI18n();
  const { selectProject } = useWorkspace();
  const inputId = useId();
  const headingId = useId();
  const [targetPath, setTargetPath] = useState("");
  const [proposal, setProposal] = useState<ScaffoldProposal | null>(null);
  const [operation, setOperation] = useState<ScaffoldOperation | null>(null);
  const proposeMutation = useProposeProjectScaffold();
  const openOperationsQuery = useOpenProjectScaffolds();
  const publishMutation = usePublishProjectScaffold();
  const retryMutation = useRetryProjectScaffold();
  const recoveredOperation = openOperationsQuery.data?.at(0) ?? null;
  const trimmed = targetPath.trim();
  const error =
    proposeMutation.error instanceof Error
      ? proposeMutation.error.message
      : publishMutation.error instanceof Error
        ? publishMutation.error.message
        : retryMutation.error instanceof Error
          ? retryMutation.error.message
          : null;

  const selectCompletedProject = (completed: ScaffoldOperation): void => {
    setOperation(completed);
    if (completed.status === "COMPLETED") selectProject(completed.projectId);
  };

  useEffect(() => {
    if (proposal !== null || operation !== null || recoveredOperation === null) return;
    setTargetPath(recoveredOperation.proposal.targetPath);
    setProposal(recoveredOperation.proposal);
    setOperation(recoveredOperation);
  }, [operation, proposal, recoveredOperation]);

  return (
    <section aria-labelledby={headingId} className="project-scaffold">
      <div className="project-scaffold__heading">
        <div>
          <h4 id={headingId}>{t("settings.projects.create.title")}</h4>
          <p>{t("settings.projects.create.description")}</p>
        </div>
        <span>{t("settings.projects.create.recipe")}</span>
      </div>

      {proposal === null ? (
        <form
          className="project-scaffold__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            proposeMutation.mutate(trimmed, {
              onSuccess: (nextProposal) => {
                setProposal(nextProposal);
                setOperation(null);
              },
            });
          }}
        >
          <Field
            description={t("settings.projects.create.pathDescription")}
            htmlFor={inputId}
            label={t("settings.projects.create.path")}
            {...(error === null ? {} : { error })}
          >
            <TextField
              autoComplete="off"
              id={inputId}
              invalid={error !== null}
              onChange={(event) => {
                setTargetPath(event.target.value);
                proposeMutation.reset();
              }}
              placeholder={t("settings.projects.create.placeholder")}
              size="md"
              spellCheck={false}
              value={targetPath}
            />
          </Field>
          <p className="project-scaffold__boundary" role="note">
            {t("settings.projects.create.boundary")}
          </p>
          <Button disabled={trimmed === ""} loading={proposeMutation.isPending} type="submit">
            {t("settings.projects.create.review")}
          </Button>
        </form>
      ) : (
        <div className="project-scaffold__review">
          <dl>
            <div>
              <dt>{t("settings.projects.create.target")}</dt>
              <dd title={proposal.targetPath}>{proposal.targetPath}</dd>
            </div>
            <div>
              <dt>{t("settings.projects.create.version")}</dt>
              <dd>
                {proposal.recipeId}@{proposal.recipeVersion}
              </dd>
            </div>
          </dl>

          <div className="project-scaffold__files">
            <strong>{t("settings.projects.create.files")}</strong>
            <ul>
              {proposal.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>
                  <span>{t("settings.projects.create.bytes", { count: file.bytes })}</span>
                </li>
              ))}
              <li>
                <code>{proposal.systemFiles[0]}</code>
                <span>{t("settings.projects.create.marker")}</span>
              </li>
            </ul>
          </div>

          <p className="project-scaffold__digest">
            <span>{t("settings.projects.create.digest")}</span>
            <code>{proposal.proposalDigest}</code>
          </p>
          <p className="project-scaffold__boundary" role="note">
            {t("settings.projects.create.confirmation")}
          </p>

          {operation?.status === "COMPLETED" ? (
            <div aria-live="polite" className="project-scaffold__result is-complete" role="status">
              <Icon name="check" size={16} />
              <div>
                <strong>{t("settings.projects.create.completed")}</strong>
                <p>{t("settings.projects.create.next")}</p>
                <ol>
                  <li>
                    {t("settings.projects.create.openTerminal")} <code>{proposal.targetPath}</code>
                  </li>
                  <li>
                    <code>pnpm install</code>
                  </li>
                  <li>
                    <code>pnpm test</code>
                  </li>
                </ol>
              </div>
            </div>
          ) : operation?.status === "FAILED" ? (
            <div aria-live="polite" className="project-scaffold__result is-failed" role="alert">
              <Icon name="warning" size={16} />
              <div>
                <strong>{t("settings.projects.create.failed")}</strong>
                <p>
                  {t("settings.projects.create.failedDescription", {
                    code: operation.lastErrorCode ?? "SCAFFOLD_WRITE_FAILED",
                  })}
                </p>
              </div>
            </div>
          ) : operation?.status === "PENDING" ? (
            <div aria-live="polite" className="project-scaffold__result" role="status">
              <div>
                <strong>{t("settings.projects.create.pending")}</strong>
                <p>{t("settings.projects.create.pendingDescription")}</p>
              </div>
            </div>
          ) : null}

          {error === null ? null : (
            <p className="project-scaffold__error" role="alert">
              {error}
            </p>
          )}

          <div className="project-scaffold__actions">
            {operation === null ? (
              <>
                <Button
                  disabled={publishMutation.isPending}
                  onClick={() => {
                    setProposal(null);
                    publishMutation.reset();
                  }}
                  type="button"
                  variant="secondary"
                >
                  {t("action.back")}
                </Button>
                <Button
                  loading={publishMutation.isPending}
                  onClick={() => {
                    publishMutation.mutate(proposal, { onSuccess: selectCompletedProject });
                  }}
                  type="button"
                  variant="primary"
                >
                  {t("settings.projects.create.confirm")}
                </Button>
              </>
            ) : operation.status === "FAILED" ? (
              <Button
                loading={retryMutation.isPending}
                onClick={() => {
                  retryMutation.mutate(operation, { onSuccess: selectCompletedProject });
                }}
                type="button"
              >
                {t("settings.projects.create.retry")}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setProposal(null);
                  setOperation(null);
                  setTargetPath("");
                }}
                type="button"
                variant="secondary"
              >
                {t("settings.projects.create.another")}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
