import { useNavigate } from "@tanstack/react-router";

import type {
  AgentFleetEntry,
  AgentFleetResponse,
  AgentFleetWaitReason,
  WorkspaceToolOperation,
} from "@loomrail/contracts";
import { FeedbackState, Skeleton } from "@loomrail/ui";

import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type Translator, type TranslationKey } from "../i18n";
import { useAgentFleet, useWorkspace } from "../workspace";

const roleKey = (role: AgentFleetEntry["profile"]["role"]): TranslationKey => `fleet.role.${role}`;
const stageKey = (stage: AgentFleetEntry["stage"]): TranslationKey => `stage.${stage}`;
const statusKey = (status: AgentFleetEntry["status"]): TranslationKey => `fleet.status.${status}`;
const waitKey = (reason: AgentFleetWaitReason): TranslationKey => `fleet.wait.${reason}`;
const originKey = (origin: NonNullable<AgentFleetEntry["latestAction"]>["origin"]): TranslationKey =>
  `fleet.latestAction.origin.${origin}`;
const operationKey = (operation: WorkspaceToolOperation): TranslationKey =>
  `workspaceTool.operation.${operation}`;

// `workspace_tool_calls.operation` is a closed, NOT NULL SQL enum (migration 0055), so a
// DAEMON_AUDITED label is always one of these six codes -- this list exists only to let the UI
// confirm that at runtime instead of trusting `origin` and casting, per this task's own rule.
const WORKSPACE_TOOL_OPERATIONS: readonly WorkspaceToolOperation[] = [
  "LIST_DIRECTORY",
  "READ_FILE",
  "WRITE_FILE",
  "EDIT_FILE",
  "DELETE_FILE",
  "RUN_RECIPE",
];
const isWorkspaceToolOperation = (value: string): value is WorkspaceToolOperation =>
  (WORKSPACE_TOOL_OPERATIONS as readonly string[]).includes(value);

// A DAEMON_AUDITED entry's label is a WorkspaceToolOperation code meant for the same
// `workspaceTool.operation.*` lookup the Run Activity feed already uses elsewhere. A
// PROVIDER_REPORTED entry's label is the provider's own free text -- untrusted, rendered as plain
// text and never looked up or interpreted as markup (React's own text-node escaping is the whole
// mechanism here; nothing renders it as HTML or Markdown). An audited label that somehow does not
// match a known operation degrades to raw text rather than a broken translation lookup.
const latestActionLabel = (action: NonNullable<AgentFleetEntry["latestAction"]>, t: Translator): string =>
  action.origin === "DAEMON_AUDITED" && isWorkspaceToolOperation(action.label)
    ? t(operationKey(action.label))
    : action.label;

type AgentFleetViewProps = {
  capacity: AgentFleetResponse["capacity"] | null;
  entries: AgentFleetEntry[];
  error: unknown;
  fetching: boolean;
  loading: boolean;
  onOpenTask: (entry: AgentFleetEntry) => void;
  onRetry: () => void;
};

export const AgentFleetView = ({
  capacity,
  entries,
  error,
  fetching,
  loading,
  onOpenTask,
  onRetry,
}: AgentFleetViewProps): React.JSX.Element => {
  const { locale, t } = useI18n();

  if (loading) {
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

  if (error) {
    return (
      <div className="agent-fleet agent-fleet--state">
        <LocalConnectionRecovery error={error} onRetry={onRetry} retrying={fetching} />
      </div>
    );
  }

  const stats = capacity ?? { active: 0, globalLimit: 0 };

  return (
    <div className="agent-fleet">
      <header className="agent-fleet__header">
        <div>
          <h1>{t("fleet.title")}</h1>
          <p>{t("fleet.description")}</p>
        </div>
        <span className="agent-fleet__capacity">
          {t("fleet.capacity", { active: stats.active, limit: stats.globalLimit })}
        </span>
      </header>

      {fetching ? (
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
                <th scope="col">{t("fleet.column.latestAction")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.agentRunId ?? entry.dispatchId ?? entry.stageAttemptId}>
                  <td data-label={t("fleet.column.task")}>
                    <button
                      className="agent-fleet__task"
                      onClick={() => {
                        onOpenTask(entry);
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
                  <td data-label={t("fleet.column.latestAction")}>
                    {entry.latestAction === null ? (
                      <span aria-label={t("fleet.noActivity")}>—</span>
                    ) : (
                      <span className="agent-fleet__latest-action">
                        <span className="agent-fleet__latest-action-label">
                          {latestActionLabel(entry.latestAction, t)}
                        </span>
                        <span
                          className="agent-fleet__latest-action-origin"
                          data-origin={entry.latestAction.origin}
                        >
                          {t(originKey(entry.latestAction.origin))}
                        </span>
                      </span>
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

export const AgentFleetPage = (): React.JSX.Element => {
  const { selectProject } = useWorkspace();
  const navigate = useNavigate({ from: "/fleet" });
  const fleetQuery = useAgentFleet();

  const openTask = (entry: AgentFleetEntry): void => {
    selectProject(entry.project.id);
    void navigate({ to: "/", search: { project: entry.project.id, task: entry.workItem.id } });
  };

  return (
    <AgentFleetView
      capacity={fleetQuery.data?.capacity ?? null}
      entries={fleetQuery.data?.entries ?? []}
      error={fleetQuery.error}
      fetching={fleetQuery.isFetching}
      loading={fleetQuery.isPending}
      onOpenTask={openTask}
      onRetry={() => void fleetQuery.refetch()}
    />
  );
};
