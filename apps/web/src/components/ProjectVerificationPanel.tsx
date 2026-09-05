import { useState } from "react";
import type {
  HumanRequest,
  PipelineRun,
  QACorrectionRun,
  VerificationCheck,
  VerificationCorrectionGateAction,
  VerificationCorrectionRun,
  VerificationPlan,
  VerificationRecipe,
  VerificationRun,
  VerificationRunSnapshotResponse,
  WorkItem,
} from "@loomrail/contracts";
import { Button, InspectorSection, Skeleton, Status, type StatusTone } from "@loomrail/ui";

import { LocalConnectionRecovery } from "./LocalConnectionRecovery";
import { useI18n, type TranslationKey, type Translator } from "../i18n";
import {
  useCancelVerificationRun,
  useStartVerificationRun,
  useResolveVerificationCorrectionGate,
  useVerificationCheckOutput,
  useVerificationPlanSettings,
  useWorkItemVerificationRuns,
  useWorkItemWorkflow,
  useWorkItemWorkspace,
  useWorkItemQA,
} from "../workspace";

const activeRunStatuses = new Set<VerificationRun["status"]>(["QUEUED", "RUNNING"]);
const terminalPipelineStatuses = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

const correctionStatusTones: Record<VerificationCorrectionRun["status"], StatusTone> = {
  ACTIVE: "running",
  PASSED: "complete",
  SUPERSEDED: "queued",
  EXHAUSTED: "paused",
  CANCELLED: "paused",
};

type VerificationCorrectionGate = {
  correctionRun: VerificationCorrectionRun | null;
  qaCorrectionRun: QACorrectionRun | null;
  request: HumanRequest;
  run: PipelineRun;
};

const runStatusKeys: Record<VerificationRun["status"], TranslationKey> = {
  QUEUED: "verification.status.QUEUED",
  RUNNING: "verification.status.RUNNING",
  PASSED: "verification.status.PASSED",
  FAILED: "verification.status.FAILED",
  ERROR: "verification.status.ERROR",
  INTERRUPTED: "verification.status.INTERRUPTED",
};

const runStatusTones: Record<VerificationRun["status"], StatusTone> = {
  QUEUED: "queued",
  RUNNING: "running",
  PASSED: "complete",
  FAILED: "paused",
  ERROR: "paused",
  INTERRUPTED: "paused",
};

const staleReasonKeys: Record<VerificationRunSnapshotResponse["staleReasons"][number], TranslationKey> = {
  PLAN_UNAVAILABLE: "verification.stale.PLAN_UNAVAILABLE",
  PLAN_REPLACED: "verification.stale.PLAN_REPLACED",
  PLAN_UNPUBLISHED: "verification.stale.PLAN_UNPUBLISHED",
  TREE_CHANGED: "verification.stale.TREE_CHANGED",
};

const formatDuration = (milliseconds: number | null, t: Translator): string => {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return t("verification.duration.ms", { count: milliseconds });
  return t("verification.duration.seconds", { count: (milliseconds / 1_000).toFixed(1) });
};

const ExactCommand = ({ recipe }: { recipe: VerificationRecipe }): React.JSX.Element => (
  <span aria-label={[recipe.executable, ...recipe.argv].join(" ")} className="verification-command">
    <code>{recipe.executable}</code>
    {recipe.argv.map((argument, index) => (
      <code key={`${index.toString()}-${argument}`}>{argument}</code>
    ))}
  </span>
);

type OutputState = {
  checkId: string | null;
  error: Error | null;
  pending: boolean;
  text: string | undefined;
};

const CheckRow = ({
  check,
  onToggleOutput,
  output,
  recipe,
}: {
  check: VerificationCheck | undefined;
  onToggleOutput: (checkId: string) => void;
  output: OutputState;
  recipe: VerificationRecipe;
}): React.JSX.Element => {
  const { t } = useI18n();
  const outputOpen = output.checkId === check?.id;

  return (
    <li className="verification-check">
      <div className="verification-check__main">
        <div>
          <strong>{recipe.label}</strong>
          <span>
            {t(recipe.required ? "verification.required" : "verification.optional")} · {recipe.kind}
          </span>
        </div>
        {check === undefined ? (
          <Status label={t("verification.status.NOT_RUN")} tone="queued" />
        ) : (
          <Status label={t(runStatusKeys[check.status])} tone={runStatusTones[check.status]} />
        )}
      </div>
      <ExactCommand recipe={recipe} />
      {check === undefined || (check.durationMs === null && check.exitCode === null) ? null : (
        <span className="verification-check__measurement">
          {t("verification.measurement", {
            duration: formatDuration(check.durationMs, t),
            exit: check.exitCode ?? "—",
          })}
        </span>
      )}
      {check?.output?.available ? (
        <div className="verification-output">
          <Button
            aria-expanded={outputOpen}
            onClick={() => {
              onToggleOutput(check.id);
            }}
            size="sm"
            type="button"
          >
            {t(outputOpen ? "verification.output.hide" : "verification.output.view")}
          </Button>
          {outputOpen ? (
            output.pending ? (
              <p aria-live="polite">{t("verification.output.loading")}</p>
            ) : output.error ? (
              <p className="verification-output__error" role="alert">
                {output.error.message}
              </p>
            ) : (
              <pre tabIndex={0}>{output.text ?? ""}</pre>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

const outcomeMessage = (snapshot: VerificationRunSnapshotResponse, t: Translator): string => {
  if (snapshot.freshness === "STALE") {
    return t("verification.outcome.stale", {
      reasons: snapshot.staleReasons.map((reason) => t(staleReasonKeys[reason])).join(", "),
    });
  }
  switch (snapshot.run.status) {
    case "QUEUED":
    case "RUNNING":
      return t("verification.outcome.active");
    case "PASSED":
      return t("verification.outcome.passed");
    case "FAILED":
    case "ERROR":
      return t("verification.outcome.failed");
    case "INTERRUPTED":
      return t("verification.outcome.interrupted");
    default: {
      const unhandled: never = snapshot.run.status;
      throw new Error(`Unhandled verification status: ${String(unhandled)}`);
    }
  }
};

const RunEvidence = ({
  onToggleOutput,
  output,
  snapshot,
}: {
  onToggleOutput: (checkId: string) => void;
  output: OutputState;
  snapshot: VerificationRunSnapshotResponse;
}): React.JSX.Element => {
  const { t } = useI18n();
  const checks = new Map(snapshot.checks.map((check) => [check.recipeId, check]));
  const stale = snapshot.freshness === "STALE";

  return (
    <div className="verification-run">
      <div className="verification-run__summary">
        <Status
          label={t(stale ? "verification.status.STALE" : runStatusKeys[snapshot.run.status])}
          tone={stale ? "paused" : runStatusTones[snapshot.run.status]}
        />
        <span>
          {t("verification.runMeta", {
            ordinal: snapshot.run.ordinal,
            platform: t(`verification.platform.${snapshot.run.platform}`),
            revision: snapshot.run.planRevision,
          })}
        </span>
      </div>
      <p className="verification-run__outcome" role="status">
        {outcomeMessage(snapshot, t)}
      </p>
      <ol className="verification-checks">
        {snapshot.plan.recipes.map((recipe) => (
          <CheckRow
            check={checks.get(recipe.id)}
            key={recipe.id}
            onToggleOutput={onToggleOutput}
            output={output}
            recipe={recipe}
          />
        ))}
      </ol>
    </div>
  );
};

type RunAvailability = "READY" | "PLAN_REQUIRED" | "PIPELINE_REQUIRED" | "WORKSPACE_REQUIRED";

export const ProjectVerificationView = ({
  actionPending,
  availability,
  correctionGate,
  correctionPendingAction,
  correctionRuns,
  currentPlan,
  loadError,
  loading,
  onCancel,
  onRetryLoad,
  onResolveCorrection,
  onRun,
  onToggleOutput,
  operationError,
  output,
  runs,
}: {
  actionPending: boolean;
  availability: RunAvailability;
  correctionGate: VerificationCorrectionGate | null;
  correctionPendingAction: VerificationCorrectionGateAction | null;
  correctionRuns: readonly VerificationCorrectionRun[];
  currentPlan: VerificationPlan | null;
  loadError: Error | null;
  loading: boolean;
  onCancel: (run: VerificationRun) => void;
  onRetryLoad: () => void;
  onResolveCorrection: (action: VerificationCorrectionGateAction) => void;
  onRun: (retryOf?: VerificationRun) => void;
  onToggleOutput: (checkId: string) => void;
  operationError: Error | null;
  output: OutputState;
  runs: readonly VerificationRunSnapshotResponse[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const latest = runs[0];
  const active = latest !== undefined && activeRunStatuses.has(latest.run.status) ? latest : null;
  const availabilityMessage: Record<Exclude<RunAvailability, "READY">, TranslationKey> = {
    PLAN_REQUIRED: "verification.unavailable.plan",
    PIPELINE_REQUIRED: "verification.unavailable.pipeline",
    WORKSPACE_REQUIRED: "verification.unavailable.workspace",
  };

  return (
    <InspectorSection title={t("verification.title")}>
      <div className="project-verification">
        {loading ? (
          <div aria-label={t("verification.loading")} className="verification-loading">
            <Skeleton width="42%" />
            <Skeleton width="86%" />
            <Skeleton width="68%" />
          </div>
        ) : loadError ? (
          <LocalConnectionRecovery error={loadError} onRetry={onRetryLoad} retrying={false} />
        ) : (
          <>
            {latest ? (
              <RunEvidence onToggleOutput={onToggleOutput} output={output} snapshot={latest} />
            ) : currentPlan ? (
              <div className="verification-run">
                <p className="verification-run__outcome">{t("verification.intro")}</p>
                <ol className="verification-checks">
                  {currentPlan.recipes.map((recipe) => (
                    <CheckRow
                      check={undefined}
                      key={recipe.id}
                      onToggleOutput={onToggleOutput}
                      output={output}
                      recipe={recipe}
                    />
                  ))}
                </ol>
              </div>
            ) : null}

            {runs.length > 1 ? (
              <details className="verification-history">
                <summary>{t("verification.history", { count: runs.length - 1 })}</summary>
                <div>
                  {runs.slice(1).map((snapshot) => (
                    <RunEvidence
                      key={snapshot.run.id}
                      onToggleOutput={onToggleOutput}
                      output={output}
                      snapshot={snapshot}
                    />
                  ))}
                </div>
              </details>
            ) : null}

            {correctionRuns.length > 0 ? (
              <div className="verification-corrections">
                <strong>{t("verification.correction.timeline")}</strong>
                <ol>
                  {correctionRuns.map((correction) => (
                    <li key={correction.id}>
                      <div>
                        <strong>
                          {t("verification.correction.position", { position: correction.budgetPosition })}
                        </strong>
                        <span>
                          {t(
                            correction.automatic
                              ? "verification.correction.automatic"
                              : "verification.correction.ownerAuthorized",
                          )}
                        </span>
                      </div>
                      <Status
                        label={t(`verification.correction.status.${correction.status}`)}
                        tone={correctionStatusTones[correction.status]}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {correctionGate ? (
              <div className="human-request-card verification-correction-gate">
                <h3>{t("verification.correctionGate.title")}</h3>
                <p>
                  {correctionGate.correctionRun === null
                    ? correctionGate.request.context
                    : t("verification.correctionGate.description", {
                        position: correctionGate.correctionRun.budgetPosition,
                      })}
                </p>
                {correctionGate.request.recommendation ? (
                  <div className="human-request-card__recommendation">
                    <strong>{t("humanRequest.recommendation")}</strong>
                    <span>{correctionGate.request.recommendation}</span>
                  </div>
                ) : null}
                <div className="verification-actions">
                  {correctionGate.request.options.length === 2 ? (
                    <Button
                      disabled={correctionPendingAction !== null}
                      loading={correctionPendingAction === "AUTHORIZE_FINAL"}
                      onClick={() => {
                        onResolveCorrection("AUTHORIZE_FINAL");
                      }}
                      type="button"
                      variant="primary"
                    >
                      {t("verification.correctionGate.authorizeFinal")}
                    </Button>
                  ) : null}
                  <Button
                    disabled={correctionPendingAction !== null}
                    loading={correctionPendingAction === "CANCEL"}
                    onClick={() => {
                      onResolveCorrection("CANCEL");
                    }}
                    type="button"
                    variant="destructive"
                  >
                    {t("verification.correctionGate.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}

            {availability === "READY" || active !== null ? null : (
              <p className="verification-unavailable">{t(availabilityMessage[availability])}</p>
            )}

            {operationError ? (
              <p className="verification-operation-error" role="alert">
                {operationError.message}
              </p>
            ) : null}

            <div className="verification-actions">
              {correctionGate ? null : active ? (
                <Button
                  loading={actionPending}
                  onClick={() => {
                    onCancel(active.run);
                  }}
                  type="button"
                  variant="destructive"
                >
                  {t("verification.cancel")}
                </Button>
              ) : availability === "READY" && currentPlan ? (
                <Button
                  loading={actionPending}
                  onClick={() => {
                    onRun(latest?.run);
                  }}
                  type="button"
                  variant="primary"
                >
                  {t(latest ? "verification.runAgain" : "verification.run")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </InspectorSection>
  );
};

export const ProjectVerificationPanel = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const runsQuery = useWorkItemVerificationRuns(item.id);
  const planQuery = useVerificationPlanSettings(item.projectId);
  const workflowQuery = useWorkItemWorkflow(item.id);
  const workspaceQuery = useWorkItemWorkspace(item.id);
  const qaQuery = useWorkItemQA(item.id);
  const start = useStartVerificationRun();
  const cancel = useCancelVerificationRun();
  const resolveCorrection = useResolveVerificationCorrectionGate();
  const outputMutation = useVerificationCheckOutput();
  const [outputCheckId, setOutputCheckId] = useState<string | null>(null);
  const plan = planQuery.data?.plan ?? null;
  const publication = planQuery.data?.publication ?? null;
  const planReady =
    plan?.status === "ACTIVE" &&
    publication?.status === "APPLIED" &&
    publication.planId === plan.id &&
    publication.contentHash === plan.contentHash;
  const pipelineStatus = workflowQuery.data?.run?.status;
  const pipelineReady = pipelineStatus !== undefined && !terminalPipelineStatuses.has(pipelineStatus);
  const workspaceReady = workspaceQuery.data?.workspace?.status === "READY";
  const currentRun = workflowQuery.data?.run ?? null;
  const currentAttempt =
    currentRun === null
      ? null
      : (workflowQuery.data?.stageAttempts.find(({ id }) => id === currentRun.currentStageAttemptId) ?? null);
  const hasCorrectionGate =
    currentAttempt?.stage === "QA" &&
    currentAttempt.status === "WAITING_HUMAN" &&
    currentAttempt.failureCode === "VERIFICATION_CORRECTION_EXHAUSTED";
  const exhaustedCorrection =
    hasCorrectionGate && (currentAttempt.verificationCorrectionRunId ?? null) !== null
      ? (runsQuery.data?.correctionRuns.find(
          ({ id, status }) => id === currentAttempt.verificationCorrectionRunId && status === "EXHAUSTED",
        ) ?? null)
      : null;
  const suspendedQACorrection =
    hasCorrectionGate && currentAttempt.correctionRunId !== null
      ? (qaQuery.data?.correctionRuns.find(
          ({ id, status }) => id === currentAttempt.correctionRunId && status === "ACTIVE",
        ) ?? null)
      : null;
  const correctionRequest = !hasCorrectionGate
    ? null
    : (workflowQuery.data?.humanRequests.find(
        ({ stageAttemptId, status }) => stageAttemptId === currentAttempt.id && status === "OPEN",
      ) ?? null);
  const correctionGate =
    currentRun !== null &&
    correctionRequest !== null &&
    ((exhaustedCorrection !== null &&
      (exhaustedCorrection.resumesQACorrectionRunId ?? null) === (suspendedQACorrection?.id ?? null)) ||
      (exhaustedCorrection === null && suspendedQACorrection !== null))
      ? {
          correctionRun: exhaustedCorrection,
          qaCorrectionRun: suspendedQACorrection,
          request: correctionRequest,
          run: currentRun,
        }
      : null;
  const availability: RunAvailability = !planReady
    ? "PLAN_REQUIRED"
    : !pipelineReady
      ? "PIPELINE_REQUIRED"
      : !workspaceReady
        ? "WORKSPACE_REQUIRED"
        : "READY";
  const loadError = [
    runsQuery.error,
    planQuery.error,
    workflowQuery.error,
    workspaceQuery.error,
    qaQuery.error,
  ].find((error): error is Error => error instanceof Error);
  const operationError = [start.error, cancel.error, resolveCorrection.error].find(
    (error): error is Error => error instanceof Error,
  );

  return (
    <ProjectVerificationView
      actionPending={start.isPending || cancel.isPending}
      availability={availability}
      correctionGate={correctionGate}
      correctionPendingAction={resolveCorrection.isPending ? resolveCorrection.variables.action : null}
      correctionRuns={runsQuery.data?.correctionRuns ?? []}
      currentPlan={planReady ? plan : null}
      loadError={loadError ?? null}
      loading={
        runsQuery.isPending ||
        planQuery.isPending ||
        workflowQuery.isPending ||
        workspaceQuery.isPending ||
        qaQuery.isPending
      }
      onCancel={(run) => {
        cancel.mutate(run);
      }}
      onRetryLoad={() => {
        void Promise.all([
          runsQuery.refetch(),
          planQuery.refetch(),
          workflowQuery.refetch(),
          workspaceQuery.refetch(),
          qaQuery.refetch(),
        ]);
      }}
      onResolveCorrection={(action) => {
        if (correctionGate === null) return;
        resolveCorrection.mutate({ ...correctionGate, action });
      }}
      onRun={(retryOf) => {
        if (!planReady) return;
        start.mutate({ workItem: item, plan, ...(retryOf === undefined ? {} : { retryOf }) });
      }}
      onToggleOutput={(checkId) => {
        if (outputCheckId === checkId) {
          setOutputCheckId(null);
          outputMutation.reset();
          return;
        }
        setOutputCheckId(checkId);
        outputMutation.mutate(checkId);
      }}
      operationError={operationError ?? null}
      output={{
        checkId: outputCheckId,
        error: outputMutation.error instanceof Error ? outputMutation.error : null,
        pending: outputMutation.isPending,
        text: outputMutation.data,
      }}
      runs={runsQuery.data?.runs ?? []}
    />
  );
};
