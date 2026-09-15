import { useState } from "react";
import type {
  ActivityOrigin,
  AgentFleetLatestAction,
  AgentRunActivityEntry,
  ProviderSession,
  WorkItem,
  WorkspaceToolCallStatus,
  WorkspaceToolFailureCode,
  WorkspaceToolOperation,
} from "@loomrail/contracts";
import { Badge, Button, Icon, InspectorSection, Skeleton } from "@loomrail/ui";

import { LocalConnectionRecovery } from "./LocalConnectionRecovery";
import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import {
  useAgentFleet,
  useAgentRunActivity,
  useStageAttemptSessions,
  useWorkItemWorkflow,
} from "../workspace";

// `workspace_tool_calls.operation` is a closed, NOT NULL SQL enum (migration 0055): a
// DAEMON_AUDITED entry's `label` is always one of these six codes. Checked at runtime, per this
// task's own rule against casts, rather than assumed from `origin` alone -- mirrors
// AgentFleetPage.tsx's own guard for the exact same fact.
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

const WORKSPACE_TOOL_STATUSES: readonly WorkspaceToolCallStatus[] = [
  "STARTED",
  "SUCCEEDED",
  "DENIED",
  "FAILED",
  "UNKNOWN_OUTCOME",
];
const isWorkspaceToolStatus = (value: string): value is WorkspaceToolCallStatus =>
  (WORKSPACE_TOOL_STATUSES as readonly string[]).includes(value);

// The same "this denial actually means approval is needed" fold the old Activity timeline applied
// to WORKSPACE_TOOL_CALL_CHANGED (WorkbenchPage.tsx, before this task removed that branch).
// Preserved here because it is the same underlying `workspace_tool_calls` row, just read through
// the merged feed instead of the domain Event -- losing the distinction would be a regression, not
// a simplification.
const APPROVAL_REQUIRED_FAILURE_CODES = new Set<WorkspaceToolFailureCode>([
  "WORKSPACE_ACCESS_DENIED",
  "RECIPE_NOT_APPROVED",
  "RECIPE_AUTHORITY_CHANGED",
  "NETWORK_POLICY_UNAVAILABLE",
]);

const originKey = (origin: ActivityOrigin): TranslationKey => `runActivity.origin.${origin}`;
const kindKey = (kind: AgentRunActivityEntry["kind"]): TranslationKey => `runActivity.kind.${kind}`;
const operationKey = (operation: WorkspaceToolOperation): TranslationKey =>
  `workspaceTool.operation.${operation}`;

// A DAEMON_AUDITED label/status is a closed code meant for the shared `workspaceTool.*` lookup Run
// Activity reuses (from the old Activity timeline, and from Agent Fleet's latest-action column). A
// PROVIDER_REPORTED label/status/detail is the provider's own free text: untrusted, rendered as
// plain text and never looked up -- React's own text-node escaping is the entire defense here,
// nothing interprets it as HTML, Markdown, or a link.
const entryLabel = (entry: AgentRunActivityEntry, t: Translator): string => {
  if (entry.label === null) return "";
  if (entry.origin === "DAEMON_AUDITED" && isWorkspaceToolOperation(entry.label)) {
    return t(operationKey(entry.label));
  }
  return entry.label;
};

const entryStatus = (entry: AgentRunActivityEntry, t: Translator): string | null => {
  if (entry.status === null) return null;
  if (entry.origin !== "DAEMON_AUDITED") return entry.status;
  const needsApproval =
    entry.status === "DENIED" &&
    entry.failureCode !== null &&
    APPROVAL_REQUIRED_FAILURE_CODES.has(entry.failureCode);
  if (needsApproval) return t("workspaceTool.status.APPROVAL_REQUIRED");
  return isWorkspaceToolStatus(entry.status) ? t(`workspaceTool.status.${entry.status}`) : entry.status;
};

// A provider entry's `label` is frequently null (an AGENT_TEXT block carries its text in `detail`,
// not `label` -- see the spec's capture table). Falling back to `detail`, then `status`, mirrors
// `describeLatestAction` in apps/daemon/src/agent-fleet.ts exactly, so the heading shown here and
// the one Agent Fleet shows for the same row never disagree about which field won.
const entryHeading = (
  entry: AgentRunActivityEntry,
  t: Translator,
): { detail: string | null; heading: string } => {
  const label = entryLabel(entry, t);
  if (label !== "") return { detail: entry.detail, heading: label };
  if (entry.detail !== null) return { detail: null, heading: entry.detail };
  const status = entryStatus(entry, t);
  if (status !== null) return { detail: null, heading: status };
  return { detail: null, heading: t("runActivity.untitled") };
};

const collapsedActionLabel = (action: AgentFleetLatestAction, t: Translator): string =>
  action.origin === "DAEMON_AUDITED" && isWorkspaceToolOperation(action.label)
    ? t(operationKey(action.label))
    : action.label;

const entryTime = (at: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));

const RunActivityEntryRow = ({
  entry,
  locale,
  t,
}: {
  entry: AgentRunActivityEntry;
  locale: Locale;
  t: Translator;
}): React.JSX.Element => {
  const { detail, heading } = entryHeading(entry, t);
  const status = entryStatus(entry, t);

  return (
    <li className="run-activity__entry">
      <time className="run-activity__entry-time" dateTime={entry.at}>
        {entryTime(entry.at, locale)}
      </time>
      <div className="run-activity__entry-body">
        <div className="run-activity__entry-heading">
          <strong>{heading}</strong>
          {/* Always-visible text, not colour alone (spec: "происхождение записи различимо без
              цвета") -- a DAEMON_AUDITED row and a PROVIDER_REPORTED row must read as different
              things even in greyscale. */}
          <span className="run-activity__entry-origin" data-origin={entry.origin}>
            {t(originKey(entry.origin))}
          </span>
        </div>
        {detail === null ? null : <p className="run-activity__entry-detail">{detail}</p>}
        <div className="run-activity__entry-meta">
          <span className="run-activity__entry-kind">{t(kindKey(entry.kind))}</span>
          {status === null ? null : <span className="run-activity__entry-status">{status}</span>}
          {entry.truncated ? (
            <span className="run-activity__entry-truncated">{t("runActivity.truncated")}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
};

const RunActivitySkeleton = (): React.JSX.Element => (
  <div aria-hidden="true" className="run-activity__skeleton">
    <Skeleton width="62%" />
    <Skeleton width="84%" />
    <Skeleton width="48%" />
  </div>
);

export type RunActivityViewProps = {
  // The newest-first hint reused from Agent Fleet's own read (Task 10's
  // LIST_LATEST_AGENT_RUN_ACTIVITY, via useAgentFleet), preferred over the merged feed's own last
  // loaded row for the collapsed summary -- see the precedence note beside `summary` below.
  // `null` once this AgentRun has no live Fleet entry (typically because it finished), at which
  // point the merged feed's own last loaded entry takes over.
  collapsedAction: AgentFleetLatestAction | null;
  degraded: boolean;
  /** Oldest-first, whatever has been loaded from `/agent-runs/:runId/activity` so far. */
  entries: readonly AgentRunActivityEntry[];
  error: Error | null;
  expanded: boolean;
  gap: boolean;
  hasMore: boolean;
  loading: boolean;
  omittedCount: number;
  onLoadMore: () => void;
  onRetry: () => void;
  onToggle: () => void;
};

export const RunActivityView = ({
  collapsedAction,
  degraded,
  entries,
  error,
  expanded,
  gap,
  hasMore,
  loading,
  omittedCount,
  onLoadMore,
  onRetry,
  onToggle,
}: RunActivityViewProps): React.JSX.Element => {
  const { locale, t } = useI18n();
  const latestEntry = entries.at(-1);
  // `collapsedAction` wins whenever it is available: it is Task 10's own newest-first read, while
  // `latestEntry` is only the tail of an oldest-first page -- correct as "the latest of what has
  // loaded", but not provably "the latest, full stop" for a run with more history than one page.
  // Only once this AgentRun has left the Fleet (collapsedAction turns null -- typically because it
  // finished) does the merged feed's own last loaded entry take over.
  const summary =
    collapsedAction !== null
      ? { label: collapsedActionLabel(collapsedAction, t), origin: collapsedAction.origin }
      : latestEntry !== undefined
        ? { label: entryHeading(latestEntry, t).heading, origin: latestEntry.origin }
        : null;
  const count = entries.length;

  return (
    <InspectorSection title={t("runActivity.title")}>
      <details
        className="run-activity"
        onToggle={() => {
          onToggle();
        }}
        open={expanded}
      >
        <summary>
          <Icon aria-hidden="true" className="run-activity__chevron" name="chevronRight" size={12} />
          {summary === null ? (
            <span className="run-activity__latest run-activity__latest--empty">
              {t(loading ? "runActivity.loading" : "runActivity.noActivity")}
            </span>
          ) : (
            <>
              <span className="run-activity__latest">{summary.label}</span>
              <span className="run-activity__entry-origin" data-origin={summary.origin}>
                {t(originKey(summary.origin))}
              </span>
            </>
          )}
          {count > 0 ? (
            <span className="run-activity__count">
              {t(hasMore ? "runActivity.countMore" : "runActivity.count", { count })}
            </span>
          ) : null}
          {degraded ? <Badge tone="warning">{t("runActivity.degradedBadge")}</Badge> : null}
        </summary>
        {/* Not just CSS-hidden by the closed <details> -- entirely absent from the tree while
            collapsed. That is what keeps a big run's history from ever costing a render (or a
            fetch beyond the first cheap page) before the owner actually asks to see it, matching
            the spec's "не становится основным содержимым Cockpit". */}
        {expanded ? (
          <div className="run-activity__body">
            <p className="run-activity__explainer">{t("runActivity.explainer")}</p>
            {degraded ? (
              <p className="run-activity__notice" role="status">
                {t("runActivity.degraded")}
              </p>
            ) : null}
            {gap ? (
              <p className="run-activity__notice" role="status">
                {t("runActivity.gap")}
              </p>
            ) : null}
            {omittedCount > 0 ? (
              <p className="run-activity__notice" role="status">
                {t("runActivity.omitted", { count: omittedCount })}
              </p>
            ) : null}
            {error ? (
              <LocalConnectionRecovery error={error} onRetry={onRetry} retrying={loading} />
            ) : loading ? (
              <RunActivitySkeleton />
            ) : entries.length > 0 ? (
              <ol className="run-activity__entries">
                {entries.map((entry) => (
                  <RunActivityEntryRow entry={entry} key={entry.id} locale={locale} t={t} />
                ))}
              </ol>
            ) : (
              <p className="inspector-copy">{t("runActivity.noActivity")}</p>
            )}
            {hasMore ? (
              <Button
                className="run-activity__more"
                disabled={loading}
                loading={loading}
                onClick={onLoadMore}
                size="sm"
              >
                {t("runActivity.loadMore")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </details>
    </InspectorSection>
  );
};

// The most recent AgentRun the work item's current stage attempt has produced a ProviderSession
// for, highest ordinal wins. Nullable sessions (recorded before migration 0020) are skipped rather
// than treated as "no run": an older session simply cannot name one.
const latestAgentRunId = (sessions: readonly ProviderSession[]): string | null => {
  let latest: ProviderSession | null = null;
  for (const session of sessions) {
    if (session.agentRunId === null) continue;
    if (latest === null || session.ordinal > latest.ordinal) latest = session;
  }
  return latest?.agentRunId ?? null;
};

/**
 * Run Activity (spec docs/plans/126-agent-run-activity-spec.ru.md): what the agent actually did
 * during a run, merged from the daemon-audited workspace tool gateway and the provider's own
 * unverified account of itself. Complements Activity, which stays the work item's lifecycle
 * history -- WORKSPACE_TOOL_CALL_CHANGED no longer renders there (see WorkbenchPage.tsx).
 *
 * Scoped to the work item's *current* stage attempt, mirroring AttemptSessionsPanel in
 * WorkbenchPage.tsx exactly: `run.currentStageAttemptId` still names the last attempt once the
 * pipeline is done (its status simply stops being RUNNING), so this keeps working for a finished
 * run, not only a live one.
 */
export const RunActivitySection = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const workflowQuery = useWorkItemWorkflow(item.id);
  const run = workflowQuery.data?.run ?? null;
  const currentAttempt =
    run === null
      ? null
      : (workflowQuery.data?.stageAttempts.find(({ id }) => id === run.currentStageAttemptId) ?? null);
  const sessionsQuery = useStageAttemptSessions(currentAttempt?.id);
  const agentRunId = latestAgentRunId(sessionsQuery.data?.sessions ?? []);
  const fleetQuery = useAgentFleet();
  const fleetEntry =
    agentRunId === null
      ? null
      : (fleetQuery.data?.entries.find((entry) => entry.agentRunId === agentRunId) ?? null);
  const activityQuery = useAgentRunActivity(item.id, agentRunId ?? undefined);
  const entries = activityQuery.data?.pages.flatMap((page) => page.entries) ?? [];
  const lastPage = activityQuery.data?.pages.at(-1);

  return (
    <RunActivityView
      collapsedAction={fleetEntry === null ? null : fleetEntry.latestAction}
      degraded={lastPage?.degraded ?? false}
      entries={entries}
      error={activityQuery.error instanceof Error ? activityQuery.error : null}
      expanded={expanded}
      gap={lastPage?.gap ?? false}
      hasMore={activityQuery.hasNextPage}
      loading={agentRunId !== null && activityQuery.isPending}
      omittedCount={lastPage?.omittedCount ?? 0}
      onLoadMore={() => {
        void activityQuery.fetchNextPage();
      }}
      onRetry={() => {
        void activityQuery.refetch();
      }}
      onToggle={() => {
        setExpanded((current) => !current);
      }}
    />
  );
};
