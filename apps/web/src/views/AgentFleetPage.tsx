import { useNavigate } from "@tanstack/react-router";

import type { AgentFleetEntry, AgentFleetWaitReason } from "@loomrail/contracts";
import { FeedbackState, Skeleton } from "@loomrail/ui";

import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type TranslationKey } from "../i18n";
import { useAgentFleet, useWorkspace } from "../workspace";

const roleKey = (role: AgentFleetEntry["profile"]["role"]): TranslationKey => `fleet.role.${role}`;
const stageKey = (stage: AgentFleetEntry["stage"]): TranslationKey => `stage.${stage}`;
const statusKey = (status: AgentFleetEntry["status"]): TranslationKey => `fleet.status.${status}`;
const waitKey = (reason: AgentFleetWaitReason): TranslationKey => `fleet.wait.${reason}`;

export const AgentFleetPage = (): React.JSX.Element => {
  const { locale, t } = useI18n();
  const { selectProject } = useWorkspace();
  const navigate = useNavigate({ from: "/fleet" });
  const fleetQuery = useAgentFleet();
  const entries = fleetQuery.data?.entries ?? [];

  const openTask = (entry: AgentFleetEntry): void => {
    selectProject(entry.project.id);
    void navigate({ to: "/", search: { project: entry.project.id, task: entry.workItem.id } });
  };

  if (fleetQuery.isPending) {
    return (
      <div aria-busy="true" aria-label={t("fleet.loading")} className="agent-fleet">
        <header className="agent-fleet__header">
          <div>
            <Skeleton width="160px" />
            <Skeleton width="320px" />
          </div>
          <Skeleton width="82px" />
        </header>
        <div className="agent-fleet__skeleton">
          <Skeleton width="100%" />
          <Skeleton width="100%" />
          <Skeleton width="100%" />
        </div>
      </div>
    );
  }

  if (fleetQuery.error) {
    return (
      <div className="agent-fleet agent-fleet--state">
        <LocalConnectionRecovery
          error={fleetQuery.error}
          onRetry={() => void fleetQuery.refetch()}
          retrying={fleetQuery.isFetching}
        />
      </div>
    );
  }

  return (
    <div className="agent-fleet">
      <header className="agent-fleet__header">
        <div>
          <h1>{t("fleet.title")}</h1>
          <p>{t("fleet.description")}</p>
        </div>
        <span className="agent-fleet__capacity">
          {t("fleet.capacity", {
            active: fleetQuery.data.capacity.active,
            limit: fleetQuery.data.capacity.globalLimit,
          })}
        </span>
      </header>

      {fleetQuery.isFetching ? (
        <p className="agent-fleet__refresh" role="status">
          {t("fleet.refreshing")}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <div className="agent-fleet__empty">
          <FeedbackState description={t("fleet.emptyDescription")} title={t("fleet.emptyTitle")} />
        </div>
      ) : (
        <div className="agent-fleet__table-scroll">
          <table className="agent-fleet__table">
            <thead>
              <tr>
                <th scope="col">{t("fleet.column.task")}</th>
                <th scope="col">{t("fleet.column.role")}</th>
                <th scope="col">{t("fleet.column.stage")}</th>
                <th scope="col">{t("fleet.column.provider")}</th>
                <th scope="col">{t("fleet.column.status")}</th>
                <th scope="col">{t("fleet.column.since")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.agentRunId ?? entry.dispatchId ?? entry.stageAttemptId}>
                  <td data-label={t("fleet.column.task")}>
                    <button
                      className="agent-fleet__task"
                      onClick={() => {
                        openTask(entry);
                      }}
                      type="button"
                    >
                      <strong>{entry.workItem.title}</strong>
                      <span>{entry.project.name}</span>
                    </button>
                  </td>
                  <td data-label={t("fleet.column.role")}>{t(roleKey(entry.profile.role))}</td>
                  <td data-label={t("fleet.column.stage")}>{t(stageKey(entry.stage))}</td>
                  <td data-label={t("fleet.column.provider")}>{entry.provider.replace("_", " ")}</td>
                  <td data-label={t("fleet.column.status")}>
                    <span className="agent-fleet__status" data-status={entry.status}>
                      <span aria-hidden="true" />
                      {t(statusKey(entry.status))}
                    </span>
                    {entry.waitReason === null ? null : (
                      <small className="agent-fleet__wait">{t(waitKey(entry.waitReason))}</small>
                    )}
                  </td>
                  <td data-label={t("fleet.column.since")}>
                    {entry.startedAt === null ? (
                      <span aria-label={t("fleet.notStarted")}>—</span>
                    ) : (
                      <time dateTime={entry.startedAt}>
                        {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(entry.startedAt))}
                      </time>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
