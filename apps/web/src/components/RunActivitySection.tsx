import { useState } from "react";
import type {
  ActivityOrigin,
  AgentFleetLatestAction,
  AgentRunActivityEntry,
  WorkItem,
  WorkspaceToolCallStatus,
  WorkspaceToolFailureCode,
  WorkspaceToolOperation,
} from "@loomrail/contracts";
import { Badge, Button, Icon, InspectorSection, Skeleton } from "@loomrail/ui";

import { LocalConnectionRecovery } from "./LocalConnectionRecovery";
import { anyPageHasGap } from "./runActivityPaging";
import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import { useAgentFleet, useWorkItemActivity } from "../workspace";

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
// Same lookup AgentFleetPage.tsx and AttentionPage.tsx already use for a WorkflowStage -- one
// shared `stage.*` vocabulary, not a Run-Activity-specific copy of the six stage names.
const stageKey = (stage: AgentRunActivityEntry["stage"]): TranslationKey => `stage.${stage}`;

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

type RunActivityGroup = {
  readonly agentRunId: string;
  readonly stage: AgentRunActivityEntry["stage"];
  readonly ordinal: number;
  readonly entries: readonly AgentRunActivityEntry[];
};

// A group under construction: `entries` is mutable here so the loop below can extend the currently
// open group in place, unlike the public `RunActivityGroup.entries` this widens into on return.
type OpenRunActivityGroup = Omit<RunActivityGroup, "entries"> & { entries: AgentRunActivityEntry[] };

/**
 * Consecutive entries sharing an `agentRunId` form one group (spec 128: "соседние записи с одним
 * agentRunId образуют группу"), headed by that run's stage and its ordinal among the runs seen so
 * far in this oldest-first feed. Deliberately NOT a `groupBy(agentRunId)` -- the merged feed is
 * chronological across the WorkItem's whole run history, so two runs' entries are never expected
 * to interleave in practice, but if they somehow did, folding every entry that shares a run id back
 * into one group (wherever it appears in the list) would misrepresent the feed's own order. Walking
 * the list once and starting a new group only when the run id actually changes is what "consecutive"
 * means here.
 *
 * The ordinal is keyed by `agentRunId`, not by which group instance this is: a run whose entries
 * happen to split across two groups still reads as the same "Run N" in both, because it IS the same
 * run, not two different ones.
 */
const groupEntriesByRun = (entries: readonly AgentRunActivityEntry[]): readonly RunActivityGroup[] => {
  const groups: OpenRunActivityGroup[] = [];
  const ordinalByRun = new Map<string, number>();
  for (const entry of entries) {
    let ordinal = ordinalByRun.get(entry.agentRunId);
    if (ordinal === undefined) {
      ordinal = ordinalByRun.size + 1;
      ordinalByRun.set(entry.agentRunId, ordinal);
    }
    const openGroup = groups.at(-1);
    if (openGroup?.agentRunId === entry.agentRunId) {
      openGroup.entries.push(entry);
      continue;
    }
    groups.push({ agentRunId: entry.agentRunId, stage: entry.stage, ordinal, entries: [entry] });
  }
  return groups;
};

const RunActivityGroupSection = ({
  group,
  locale,
  t,
}: {
  group: RunActivityGroup;
  locale: Locale;
  t: Translator;
}): React.JSX.Element => (
  <li className="run-activity__group">
    {/* Not a <summary>/<button>: the spec keeps keyboard focus and the visible focus ring on the
        section's single top-level <summary> only -- a per-group heading must never become a second
        tab stop. */}
    <div className="run-activity__group-heading">
      <span className="run-activity__group-stage">{t(stageKey(group.stage))}</span>
      <span className="run-activity__group-ordinal">
        {t("runActivity.group.ordinal", { ordinal: group.ordinal })}
      </span>
    </div>
    <ol className="run-activity__group-entries">
      {group.entries.map((entry) => (
        <RunActivityEntryRow entry={entry} key={entry.id} locale={locale} t={t} />
      ))}
    </ol>
  </li>
);

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
  /** Oldest-first, whatever has been loaded from `/work-items/:workItemId/activity` so far. */
  entries: readonly AgentRunActivityEntry[];
  error: Error | null;
  expanded: boolean;
  gap: boolean;
  hasMore: boolean;
  loading: boolean;
  /** A "Show more" fetch is in flight -- distinct from `loading`, which is only the first page. */
  loadingMore: boolean;
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
  loadingMore,
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
  //
  // When it does, and more of the feed exists beyond this loaded page (`hasMore`), that entry is
  // NOT provably the latest action either -- it is only the newest thing loaded so far, oldest-
  // first, from a run with no live Fleet entry to check against. `approximate` says so instead of
  // presenting a possibly-stale row as a confident "this is what happened last".
  const summary =
    collapsedAction !== null
      ? {
          approximate: false,
          label: collapsedActionLabel(collapsedAction, t),
          origin: collapsedAction.origin,
        }
      : latestEntry !== undefined
        ? { approximate: hasMore, label: entryHeading(latestEntry, t).heading, origin: latestEntry.origin }
        : null;
  const count = entries.length;
  const groups = groupEntriesByRun(entries);

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
              {summary.approximate ? (
                <span className="run-activity__latest-note">{t("runActivity.latestApproximate")}</span>
              ) : null}
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
            {/* A failed "Show more" must not blank a list the owner is already reading -- the
                recovery affordance renders alongside whatever loaded, never instead of it. Only
                an initial-load failure (no entries to keep) hides the empty-state copy in favour
                of the recovery panel. */}
            {entries.length > 0 ? (
              <ol className="run-activity__entries">
                {groups.map((group) => (
                  // Each group's own first entry `id` is unique across the whole merged feed (the
                  // one identity the contract promises -- `seq` is not, and `agentRunId` alone would
                  // collide when the same run's entries split into two non-consecutive groups).
                  <RunActivityGroupSection
                    group={group}
                    key={group.entries[0]?.id ?? group.agentRunId}
                    locale={locale}
                    t={t}
                  />
                ))}
              </ol>
            ) : loading ? (
              <RunActivitySkeleton />
            ) : error ? null : (
              <p className="inspector-copy">{t("runActivity.noActivity")}</p>
            )}
            {error ? <LocalConnectionRecovery error={error} onRetry={onRetry} retrying={loading} /> : null}
            {hasMore ? (
              <Button
                className="run-activity__more"
                disabled={loadingMore}
                loading={loadingMore}
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

/**
 * Run Activity (spec docs/plans/128-work-item-activity-spec.ru.md): what agents actually did while
 * working this WorkItem, merged from the daemon-audited workspace tool gateway and each run's own
 * unverified account of itself. Complements Activity, which stays the work item's lifecycle
 * history -- WORKSPACE_TOOL_CALL_CHANGED no longer renders there (see WorkbenchPage.tsx).
 *
 * Bound to the WorkItem itself, not to a resolved "current" AgentRun -- spec 128's whole point, and
 * the gap ADR-0034 left open: an audited action made on an earlier stage attempt used to become
 * invisible the moment the pipeline moved past it, because the section's query was keyed to that
 * one attempt's own AgentRun. Fetching by `item.id` also fixes the side effect that scoping had: the
 * old lookup chased `run.currentStageAttemptId` through its sessions to find an `agentRunId` to key
 * on, and during the window between one attempt ending and the next one's first ProviderSession
 * existing, that chain resolved to nothing -- this component returned null, unmounted, and lost the
 * owner's `expanded` state. A query keyed on the WorkItem never goes through that window.
 *
 * The collapsed Agent Fleet hint is looked up the same direct way: by `workItem.id`
 * (`agentFleetEntrySchema.workItem`), not through an AgentRun id resolved from stage-attempt
 * sessions -- a Fleet entry already names its own WorkItem, so no resolution step is needed here
 * either.
 *
 * Always renders the section, unlike the previous run-scoped version, which hid itself entirely
 * (no header at all) whenever it could not resolve a "current" AgentRun. That heuristic could not
 * survive the rescope: a WorkItem that has started but produced no activity yet -- e.g. paused for
 * budget approval before its retry ran anything -- has no live Fleet entry and an empty first page,
 * which is indistinguishable at this layer from "never started at all". `RunActivityView`'s own
 * empty state ("No run activity recorded yet") already says the honest thing for both, so guessing
 * which one it is here would only add a chance of hiding the section for a task that IS running,
 * confirmed live against e2e/run-activity.spec.ts (an earlier version of this gate did exactly that).
 */
export const RunActivitySection = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const fleetQuery = useAgentFleet();
  const fleetEntry = fleetQuery.data?.entries.find((entry) => entry.workItem.id === item.id) ?? null;
  const activityQuery = useWorkItemActivity(item.id);
  const entries = activityQuery.data?.pages.flatMap((page) => page.entries) ?? [];
  const lastPage = activityQuery.data?.pages.at(-1);
  const gap = anyPageHasGap(activityQuery.data?.pages ?? []);

  return (
    <RunActivityView
      collapsedAction={fleetEntry === null ? null : fleetEntry.latestAction}
      degraded={lastPage?.degraded ?? false}
      entries={entries}
      error={activityQuery.error instanceof Error ? activityQuery.error : null}
      expanded={expanded}
      gap={gap}
      hasMore={activityQuery.hasNextPage}
      loading={activityQuery.isPending}
      loadingMore={activityQuery.isFetchingNextPage}
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
