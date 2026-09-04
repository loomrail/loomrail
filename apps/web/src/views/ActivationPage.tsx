import { useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { guidedActivationContract } from "@loomrail/contracts";
import { Button, Icon, Skeleton } from "@loomrail/ui";

import {
  guidedActivationPhases,
  projectGuidedActivation,
  selectGuidedActivationTask,
  type GuidedActivationPhase,
} from "../activationView";
import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type TranslationKey } from "../i18n";
import { useOpenAppSettings } from "../shell/appSettings";
import {
  useCreateGuidedActivationWorkItem,
  useInitializeFixtureWorkspace,
  useMoveWorkItem,
  useProjectProviderSelection,
  useProjectWorkItems,
  useSetProjectProviderPreference,
  useStartMockPipeline,
  useWorkspace,
  useWorkItemWorkflow,
} from "../workspace";

const phaseLabel: Readonly<Record<GuidedActivationPhase, TranslationKey>> = {
  WORKSPACE: "activation.phase.workspace",
  PROVIDER: "activation.phase.provider",
  TASK: "activation.phase.task",
  READY: "activation.phase.ready",
  RUN: "activation.phase.run",
  REQUEST: "activation.phase.request",
  REVIEW: "activation.phase.review",
  QA: "activation.phase.qa",
  ACCEPTANCE: "activation.phase.acceptance",
  COMPLETE: "activation.phase.complete",
};

const phaseCopy: Readonly<Record<GuidedActivationPhase, TranslationKey>> = {
  WORKSPACE: "activation.copy.workspace",
  PROVIDER: "activation.copy.provider",
  TASK: "activation.copy.task",
  READY: "activation.copy.ready",
  RUN: "activation.copy.run",
  REQUEST: "activation.copy.request",
  REVIEW: "activation.copy.review",
  QA: "activation.copy.qa",
  ACCEPTANCE: "activation.copy.acceptance",
  COMPLETE: "activation.copy.complete",
};

export const ActivationPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const openAppSettings = useOpenAppSettings();
  const navigate = useNavigate({ from: "/try" });
  const search = useSearch({ from: "/try" });
  const { error, projects, projectsPending, retryConnection, selectedProject, selectProject } =
    useWorkspace();
  const project =
    projects.find(
      ({ fixtureId, repositoryStatus }) =>
        fixtureId === guidedActivationContract.fixtureId && repositoryStatus === "READY",
    ) ??
    projects.find(({ fixtureId }) => fixtureId === guidedActivationContract.fixtureId) ??
    null;
  const providerSelectionQuery = useProjectProviderSelection(project?.id);
  const workItemsQuery = useProjectWorkItems(project?.id);
  const workItem = selectGuidedActivationTask(workItemsQuery.data?.workItems ?? [], search.task);
  const workflowQuery = useWorkItemWorkflow(workItem?.id);
  const initializeMutation = useInitializeFixtureWorkspace();
  const setProviderMutation = useSetProjectProviderPreference();
  const createMutation = useCreateGuidedActivationWorkItem();
  const moveMutation = useMoveWorkItem();
  const startMutation = useStartMockPipeline();

  useEffect(() => {
    if (project !== null && project.id !== selectedProject?.id) selectProject(project.id);
  }, [project, selectProject, selectedProject?.id]);

  useEffect(() => {
    if (workItem !== null && search.task !== workItem.id) {
      void navigate({ replace: true, search: { task: workItem.id } });
    }
  }, [navigate, search.task, workItem]);

  const queryError =
    error ?? providerSelectionQuery.error ?? workItemsQuery.error ?? workflowQuery.error ?? null;
  if (queryError !== null) {
    return (
      <div className="activation activation--state">
        <LocalConnectionRecovery
          error={queryError}
          onRetry={() => {
            retryConnection();
            void providerSelectionQuery.refetch();
            void workItemsQuery.refetch();
            void workflowQuery.refetch();
          }}
          retrying={
            providerSelectionQuery.isFetching || workItemsQuery.isFetching || workflowQuery.isFetching
          }
        />
      </div>
    );
  }

  const queriesPending =
    projectsPending ||
    (project !== null && (providerSelectionQuery.isPending || workItemsQuery.isPending)) ||
    (workItem !== null && workflowQuery.isPending);
  if (queriesPending) {
    return (
      <div aria-busy="true" aria-label={t("activation.loading")} className="activation">
        <header className="activation__header">
          <Skeleton width="180px" />
          <Skeleton width="520px" />
        </header>
        <div className="activation__loading">
          <Skeleton width="100%" />
          <Skeleton width="76%" />
          <Skeleton width="88%" />
        </div>
      </div>
    );
  }

  const projection = projectGuidedActivation(
    project,
    providerSelectionQuery.data ?? null,
    workItem,
    workflowQuery.data ?? null,
  );
  const openHumanRequest = workflowQuery.data?.humanRequests.some(
    ({ status }) => status === "OPEN" || status === "CLAIMED" || status === "SNOOZED",
  );
  const mutationError =
    initializeMutation.error ??
    setProviderMutation.error ??
    createMutation.error ??
    moveMutation.error ??
    startMutation.error ??
    null;
  const taskUrlSearch =
    project !== null && workItem !== null ? { project: project.id, task: workItem.id } : {};

  const primaryAction = (): React.JSX.Element | null => {
    switch (projection.current) {
      case "WORKSPACE":
        return (
          <Button
            icon="projects"
            loading={initializeMutation.isPending}
            onClick={() => {
              initializeMutation.mutate();
            }}
            variant="primary"
          >
            {t("activation.action.workspace")}
          </Button>
        );
      case "PROVIDER":
        if (project === null) return null;
        return (
          <Button
            disabled={providerSelectionQuery.data?.environmentOverrideLocked}
            icon="agents"
            loading={setProviderMutation.isPending}
            onClick={() => {
              setProviderMutation.mutate({ preference: "MOCK", project });
            }}
            variant="primary"
          >
            {t("activation.action.provider")}
          </Button>
        );
      case "TASK":
        if (project === null) return null;
        return (
          <Button
            icon="add"
            loading={createMutation.isPending}
            onClick={() => {
              createMutation.mutate(project.id, {
                onSuccess: (created) => {
                  void navigate({ replace: true, search: { task: created.id } });
                },
              });
            }}
            variant="primary"
          >
            {t("activation.action.task")}
          </Button>
        );
      case "READY":
        if (workItem === null) return null;
        return (
          <Button
            icon="check"
            loading={moveMutation.isPending}
            onClick={() => {
              moveMutation.mutate({ targetState: "READY", workItem });
            }}
            variant="primary"
          >
            {t("activation.action.ready")}
          </Button>
        );
      case "RUN":
        if (workItem === null) return null;
        return (
          <Button
            icon="play"
            loading={startMutation.isPending}
            onClick={() => {
              startMutation.mutate({ policy: guidedActivationContract.policy, workItem });
            }}
            variant="primary"
          >
            {t("activation.action.run")}
          </Button>
        );
      case "REQUEST":
      case "REVIEW":
      case "QA":
        return (
          <Button
            icon={openHumanRequest ? "question" : "board"}
            onClick={() => {
              if (openHumanRequest) {
                void navigate({ to: "/attention" });
              } else if (project !== null && workItem !== null) {
                void navigate({ to: "/", search: taskUrlSearch });
              }
            }}
            variant="primary"
          >
            {t(openHumanRequest ? "activation.action.attention" : "activation.action.cockpit")}
          </Button>
        );
      case "ACCEPTANCE":
        return (
          <Button
            icon="check"
            onClick={() => {
              if (project !== null && workItem !== null) {
                void navigate({ to: "/", search: taskUrlSearch });
              }
            }}
            variant="primary"
          >
            {t("activation.action.acceptance")}
          </Button>
        );
      case "COMPLETE":
        return null;
    }
  };

  return (
    <div className="activation">
      <header className="activation__header">
        <div>
          <span>{t("activation.eyebrow")}</span>
          <h1>{t("activation.title")}</h1>
          <p>{t("activation.description")}</p>
        </div>
        <p className="activation__boundary">
          <Icon name="info" size={15} />
          {t("activation.zeroQuota")}
        </p>
      </header>

      <div className="activation__body">
        <nav aria-label={t("activation.progress")} className="activation-progress">
          <ol>
            {guidedActivationPhases.map((phase, index) => {
              const complete = projection.completed.includes(phase);
              const current = projection.current === phase;
              return (
                <li
                  aria-current={current ? "step" : undefined}
                  className={complete ? "is-complete" : current ? "is-current" : undefined}
                  key={phase}
                >
                  <span aria-hidden="true">{complete ? <Icon name="check" size={13} /> : index + 1}</span>
                  <div>
                    <strong>{t(phaseLabel[phase])}</strong>
                    <small>
                      {t(
                        complete
                          ? "activation.status.complete"
                          : current
                            ? "activation.status.current"
                            : "activation.status.upcoming",
                      )}
                    </small>
                  </div>
                </li>
              );
            })}
          </ol>
        </nav>

        <section aria-live="polite" className="activation-step">
          <header>
            <span>
              {t("activation.step", {
                current: (guidedActivationPhases.indexOf(projection.current) + 1).toString(),
                total: guidedActivationPhases.length.toString(),
              })}
            </span>
            <h2>{t(phaseLabel[projection.current])}</h2>
            <p>{t(phaseCopy[projection.current])}</p>
          </header>

          {projection.current === "PROVIDER" && providerSelectionQuery.data?.environmentOverrideLocked ? (
            <p className="activation-step__warning" role="alert">
              {t("activation.providerLocked")}
            </p>
          ) : null}

          {mutationError !== null ? <LocalConnectionRecovery error={mutationError} /> : null}
          <div className="activation-step__action">{primaryAction()}</div>

          <details className="activation-recipe">
            <summary>{t("activation.recipe.title")}</summary>
            <p>{guidedActivationContract.task.description}</p>
            <ol>
              {guidedActivationContract.task.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ol>
            <dl>
              <div>
                <dt>{t("activation.recipe.provider")}</dt>
                <dd>Mock</dd>
              </div>
              <div>
                <dt>{t("activation.recipe.model")}</dt>
                <dd>{guidedActivationContract.policy.modelTierOverride}</dd>
              </div>
              <div>
                <dt>{t("activation.recipe.budget")}</dt>
                <dd>{guidedActivationContract.policy.maxEstimatedTokens.toLocaleString()}</dd>
              </div>
            </dl>
          </details>

          {projection.current === "COMPLETE" ? (
            <div className="activation-next">
              <h3>{t("activation.next.title")}</h3>
              <div>
                <Button
                  onClick={() => {
                    if (project !== null && workItem !== null) {
                      void navigate({ to: "/", search: taskUrlSearch });
                    }
                  }}
                  variant="secondary"
                >
                  {t("activation.next.local")}
                </Button>
                <Button onClick={openAppSettings} variant="secondary">
                  {t("activation.next.repository")}
                </Button>
              </div>
              <details className="activation-next__guided">
                <summary>{t("activation.next.guidedAction")}</summary>
                <p>{t("activation.next.guided")}</p>
              </details>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
