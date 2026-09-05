import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  isSessionPauseFailureCode,
  modelTierSchema,
  prioritySchema,
  riskSchema,
  type AcceptanceAction,
  type AcceptancePackage,
  type AgentRunStatus,
  type Checkpoint,
  type ContextWindowUsage,
  type DomainEvent,
  type EvidenceArtifact,
  type HumanRequest,
  type ModelTier,
  type PipelineRun,
  type ProjectProviderSelectionResponse,
  type ProviderSession,
  type QADefect,
  type QAObservation,
  type QARunStatus,
  type QAStateResponse,
  type ReadinessCheck,
  type ReviewFinding,
  type ReviewFindingOwnerDisposition,
  type ReviewStateResponse,
  type SessionPauseFailureCode,
  type StageAttempt,
  type StageAttemptStatus,
  type VerificationCheck,
  type VerificationFailure,
  type WorkItem,
  type WorkItemChangedField,
  type WorkItemState,
  type PublishedWorkItemWorkspace,
  type WorkItemWorkspaceStatus,
} from "@loomrail/contracts";
import {
  ActionMenu,
  AppliedFilterBar,
  Badge,
  Button,
  CascadingFilter,
  Checkbox,
  cn,
  DialogSurface,
  FeedbackState,
  Field,
  Icon,
  IconButton,
  InspectorSection,
  KanbanColumn,
  PopoverSurface,
  ProviderSessionTimeline,
  RunSummary,
  SelectControl,
  Skeleton,
  Status,
  Switch,
  TaskCard,
  Textarea,
  TextField,
  TimelineEvent,
  Tooltip,
  type BadgeTone,
  type CheckpointGroup,
  type CheckpointViewModel,
  type FilterMessages,
  type FilterNode,
  type ProviderSessionTimelineAttempt,
  type ProviderSessionViewModel,
  type StatusTone,
  type TimelineEventProps,
} from "@loomrail/ui";

import { ChangesSection } from "./ChangesSection";
import { workItemAcceptanceExportUrl, workItemQAAttachmentUrl } from "../api";
import {
  defaultBoardView,
  isBoardOrdering,
  orderWorkItems,
  scopeShows,
  type BoardOrdering,
  type BoardScope,
  type BoardView,
} from "../boardView";
import { PanelResizer } from "../components/PanelResizer";
import { ProjectProviderAllowanceStrip } from "../components/ProviderAllowanceStrip";
import { ProjectVerificationPanel } from "../components/ProjectVerificationPanel";
import { HumanRequestAnswerForm } from "../components/HumanRequestAnswerForm";
import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import type { SummaryFilter } from "../router";
import { moveShortcutsFor, transitionTargets } from "../taskMoves";
import {
  suggestedAgentRunBudget,
  suggestedPipelineBudget,
  workflowPolicyFormValues,
} from "../workflowPolicy";
import {
  useInitializeFixtureWorkspace,
  useApproveBudgetOverride,
  useDisposeReviewFinding,
  useMoveWorkItem,
  usePipelineControl,
  useProjectProviderSelection,
  useProjectHumanRequests,
  useProjectWorkItems,
  useProviderCapabilities,
  useResolveAcceptance,
  useResolveQACorrectionGate,
  useStageAttemptSessions,
  useStartMockPipeline,
  useUpdateWorkItem,
  useWaiveQADefect,
  useWorkspace,
  useWorkItemEvents,
  useWorkItemQA,
  useWorkItemWorkflow,
  useWorkItemReviews,
  useWorkItemWorkspace,
} from "../workspace";

const viewOrderingOptions = (t: Translator): readonly { label: string; value: BoardOrdering }[] => [
  { label: t("property.priority"), value: "priority" },
  { label: t("view.created"), value: "created" },
  { label: t("view.updated"), value: "updated" },
  { label: t("view.title"), value: "title" },
];

type ViewSettingsProps = {
  onViewChange: (value: BoardView) => void;
  view: BoardView;
};

const ViewSettings = ({ onViewChange, view }: ViewSettingsProps): React.JSX.Element => {
  const { t } = useI18n();
  const nextDirection = view.direction === "asc" ? "desc" : "asc";

  return (
    <div className="view-settings">
      <div className="view-settings__controls">
        <div className="view-settings__row">
          <span>{t("view.ordering")}</span>
          <div className="view-settings__ordering">
            <Tooltip label={t(`view.direction.${nextDirection}`)}>
              <IconButton
                className={cn("view-settings__direction", view.direction === "desc" && "is-descending")}
                label={t(`view.direction.${nextDirection}`)}
                name="sortAscending"
                onClick={() => {
                  onViewChange({ ...view, direction: nextDirection });
                }}
                size="sm"
              />
            </Tooltip>
            <SelectControl
              ariaLabel={t("view.orderBy")}
              onValueChange={(value) => {
                if (isBoardOrdering(value)) onViewChange({ ...view, ordering: value });
              }}
              options={viewOrderingOptions(t)}
              size="sm"
              value={view.ordering}
              variant="compact"
            />
          </div>
        </div>
      </div>
      <div className="view-settings__section">
        <span className="view-settings__section-title">{t("view.boardOptions")}</span>
        <Switch
          checked={view.showEmptyColumns}
          label={t("view.showEmptyColumns")}
          onCheckedChange={(checked) => {
            onViewChange({ ...view, showEmptyColumns: checked });
          }}
        />
      </div>
    </div>
  );
};

type BoardToolbarProps = {
  filters: readonly string[];
  onClearFilters: () => void;
  onFiltersChange: (value: readonly string[]) => void;
  onScopeChange: (value: BoardScope) => void;
  onSummaryFilterChange: (value: SummaryFilter | null) => void;
  onViewChange: (value: BoardView) => void;
  options: readonly FilterNode[];
  scope: BoardScope;
  summaryFilter: SummaryFilter | null;
  view: BoardView;
};

const BoardToolbar = ({
  filters,
  onClearFilters,
  onFiltersChange,
  onScopeChange,
  onSummaryFilterChange,
  onViewChange,
  options,
  scope,
  summaryFilter,
  view,
}: BoardToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  const hasActiveFilters = filters.length > 0 || summaryFilter !== null;
  const summaryFilterLabel = summaryFilter ? t(`work.summary.${summaryFilter}`) : null;
  const filterMessages: Partial<FilterMessages> = {
    add: t("filter.add"),
    addFilterPlaceholder: t("filter.addPlaceholder"),
    backTo: t("filter.backTo"),
    clear: t("filter.clear"),
    close: t("filter.close"),
    description: t("filter.description"),
    edit: t("filter.edit"),
    filterPlaceholder: t("filter.placeholder"),
    is: t("filter.is"),
    isAnyOf: t("filter.isAnyOf"),
    noMatchingProperties: t("filter.noProperties"),
    noMatchingValues: t("filter.noValues"),
    oneValue: t("filter.oneValue"),
    options: t("filter.options"),
    remove: t("filter.remove"),
    rootTitle: t("filter.rootTitle"),
    search: t("filter.search"),
    selectedValues: t("filter.selectedValues"),
  };

  return (
    <div className="board-toolbar-stack">
      <div className="board-toolbar">
        <div className="board-view-tabs">
          {(
            [
              { labelKey: "view.active", value: "active" },
              { labelKey: "view.backlog", value: "backlog" },
              { labelKey: "view.allIssues", value: "all" },
            ] as const
          ).map(({ labelKey, value }) => (
            <Button
              aria-pressed={scope === value}
              key={value}
              onClick={() => {
                onScopeChange(value);
              }}
              shape="pill"
              variant="surface"
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
        <div className="board-toolbar__actions">
          <CascadingFilter
            ariaLabel={t("view.filter")}
            messages={filterMessages}
            onValueChange={onFiltersChange}
            options={options}
            trigger={<IconButton label={t("view.filter")} name="filter" variant="surface" />}
            triggerTooltip={t("view.filter")}
            value={filters}
          />
          <PopoverSurface
            className="view-settings-popover"
            label={t("view.display")}
            trigger={<IconButton label={t("view.display")} name="settings" variant="surface" />}
            triggerTooltip={t("view.display")}
          >
            <ViewSettings onViewChange={onViewChange} view={view} />
          </PopoverSurface>
          <ActionMenu
            align="end"
            groups={[
              [
                {
                  icon: "link",
                  label: t("view.copyLink"),
                  // Filters, ordering and scope live in the URL, so the address is the shareable view.
                  onSelect: () => {
                    void navigator.clipboard.writeText(window.location.href);
                  },
                },
              ],
            ]}
            trigger={<IconButton label={t("view.actions")} name="more" variant="surface" />}
            triggerTooltip={t("view.actions")}
          />
        </div>
      </div>
      {hasActiveFilters ? (
        <AppliedFilterBar
          addFilter={
            <CascadingFilter
              ariaLabel={t("view.filter")}
              messages={filterMessages}
              onValueChange={onFiltersChange}
              options={options}
              trigger={
                <IconButton className="board-add-filter" label={t("view.filter")} name="add" size="sm" />
              }
              triggerTooltip={t("view.filter")}
              value={filters}
            />
          }
          ariaLabel={t("view.filter")}
          className="board-applied-filters"
          messages={filterMessages}
          onClear={onClearFilters}
          onValueChange={onFiltersChange}
          options={options}
          supplementalConditions={
            summaryFilter && summaryFilterLabel ? (
              <div className="lr-applied-filter board-summary-filter">
                <span className="lr-applied-filter__property">
                  <Icon name="filter" size={12} />
                  {t("work.summary.filter")}
                </span>
                <span className="lr-applied-filter__value">{summaryFilterLabel}</span>
                <Tooltip label={t("work.summary.clear")}>
                  <button
                    aria-label={t("work.summary.clear")}
                    className="lr-applied-filter__remove"
                    onClick={() => {
                      onSummaryFilterChange(null);
                    }}
                    type="button"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </Tooltip>
              </div>
            ) : null
          }
          value={filters}
        />
      ) : null}
    </div>
  );
};

const boardColumns = [
  { labelKey: "state.BACKLOG", state: "BACKLOG", tone: "queued" },
  { labelKey: "state.READY", state: "READY", tone: "ready" },
  { labelKey: "state.IN_PROGRESS", state: "IN_PROGRESS", tone: "running" },
  { labelKey: "state.BLOCKED", state: "BLOCKED", tone: "waiting" },
  { labelKey: "state.DONE", state: "DONE", tone: "complete" },
  { labelKey: "state.CANCELLED", state: "CANCELLED", tone: "paused" },
] as const satisfies readonly {
  labelKey: TranslationKey;
  state: WorkItemState;
  tone: StatusTone;
}[];

const columnsFor = (scope: BoardScope): readonly (typeof boardColumns)[number][] =>
  boardColumns.filter((column) => scopeShows(scope, column.state));

const stateLabelKeys: Record<WorkItemState, TranslationKey> = {
  BACKLOG: "state.BACKLOG",
  READY: "state.READY",
  IN_PROGRESS: "state.IN_PROGRESS",
  BLOCKED: "state.BLOCKED",
  DONE: "state.DONE",
  CANCELLED: "state.CANCELLED",
};

const stateLabel = (state: WorkItemState, t: Translator): string => t(stateLabelKeys[state]);

const priorityLabelKeys: Record<WorkItem["priority"], TranslationKey> = {
  LOW: "priority.LOW",
  MEDIUM: "priority.MEDIUM",
  HIGH: "priority.HIGH",
  URGENT: "priority.URGENT",
};

const riskLabelKeys: Record<WorkItem["risk"], TranslationKey> = {
  LOW: "risk.LOW",
  MEDIUM: "risk.MEDIUM",
  HIGH: "risk.HIGH",
  CRITICAL: "risk.CRITICAL",
};

const typeLabelKeys: Record<WorkItem["type"], TranslationKey> = {
  EPIC: "type.EPIC",
  FEATURE: "type.FEATURE",
  TASK: "type.TASK",
  BUG: "type.BUG",
  SPIKE: "type.SPIKE",
  SUBTASK: "type.SUBTASK",
};

const stageLabelKeys: Record<NonNullable<WorkItem["currentStage"]>, TranslationKey> = {
  DISCOVERY: "stage.DISCOVERY",
  PLAN: "stage.PLAN",
  IMPLEMENT: "stage.IMPLEMENT",
  REVIEW: "stage.REVIEW",
  QA: "stage.QA",
  ACCEPTANCE: "stage.ACCEPTANCE",
};

const stateTones: Record<WorkItemState, StatusTone> = {
  BACKLOG: "queued",
  READY: "ready",
  IN_PROGRESS: "running",
  BLOCKED: "waiting",
  DONE: "complete",
  CANCELLED: "paused",
};

const priorityTone = (priority: WorkItem["priority"]): BadgeTone => {
  if (priority === "URGENT") return "danger";
  if (priority === "HIGH") return "warning";
  return "neutral";
};

const displayWorkItemId = (id: string): string => {
  const suffix = id.split("-").at(-1) ?? id;
  return suffix.length > 10 ? suffix.slice(0, 8).toUpperCase() : suffix.toUpperCase();
};

const filterOptionsFor = (
  items: readonly WorkItem[],
  columns: readonly (typeof boardColumns)[number][],
  t: Translator,
): readonly FilterNode[] => {
  const count = (predicate: (item: WorkItem) => boolean): number => items.filter(predicate).length;
  return [
    {
      id: "status",
      label: t("filter.status"),
      icon: "clock",
      children: columns.map((column) => ({
        id: `status-${column.state.toLowerCase()}`,
        label: t(column.labelKey),
        count: count((item) => item.state === column.state),
      })),
    },
    {
      id: "priority",
      label: t("filter.priority"),
      icon: "filter",
      children: (["URGENT", "HIGH", "MEDIUM", "LOW"] as const).map((priority) => ({
        id: `priority-${priority.toLowerCase()}`,
        label: t(priorityLabelKeys[priority]),
        count: count((item) => item.priority === priority),
      })),
    },
    {
      id: "risk",
      label: t("filter.risk"),
      icon: "warning",
      children: (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((risk) => ({
        id: `risk-${risk.toLowerCase()}`,
        label: t(riskLabelKeys[risk]),
        count: count((item) => item.risk === risk),
      })),
    },
  ];
};

const matchesFilters = (item: WorkItem, filters: readonly string[]): boolean =>
  filters.every((filter) => {
    if (filter.startsWith("status-")) return filter === `status-${item.state.toLowerCase()}`;
    if (filter.startsWith("priority-")) return filter === `priority-${item.priority.toLowerCase()}`;
    if (filter.startsWith("risk-")) return filter === `risk-${item.risk.toLowerCase()}`;
    return true;
  });

const changedFieldLabelKeys: Record<WorkItemChangedField, TranslationKey> = {
  title: "field.title",
  description: "field.description",
  priority: "field.priority",
  risk: "field.risk",
  acceptanceCriteria: "field.acceptanceCriteria",
};

const readinessCheckKeys: Record<ReadinessCheck["key"], TranslationKey> = {
  SECURITY_ACTIVE_CONSTITUTION: "settings.readiness.check.activeConstitution",
  SECURITY_SECRET_PATHS: "settings.readiness.check.secretPaths",
  SECURITY_ENV_IGNORED: "settings.readiness.check.envIgnored",
  SECURITY_CI_HARDENING: "settings.readiness.check.ciHardening",
  LEGAL_LICENSE: "settings.readiness.check.license",
  LEGAL_OWNER_REVIEW: "settings.readiness.check.legalOwner",
  PAYMENTS_OWNER_REVIEW: "settings.readiness.check.paymentsOwner",
  ANALYTICS_OWNER_REVIEW: "settings.readiness.check.analyticsOwner",
};

const readinessStatusKeys: Record<ReadinessCheck["status"], TranslationKey> = {
  PASSED: "settings.readiness.status.passed",
  ACTION_REQUIRED: "settings.readiness.status.action",
  CONFIRMED: "settings.readiness.status.confirmed",
  NOT_APPLICABLE: "settings.readiness.status.na",
};

// A total Record over the contract's own union, so a new quality cannot arrive without this file
// failing to compile -- the same discipline `hardPauseLabelKeys` below is written under. Its codes
// come from @loomrail/contracts rather than a local copy, so the cockpit's reading of "is this a
// session pause" cannot drift from the domain's.
const usageQualityLabelKeys: Record<ContextWindowUsage["quality"], TranslationKey> = {
  ACTUAL: "workflow.sessions.usageQuality.ACTUAL",
  PROVIDER_ESTIMATE: "workflow.sessions.usageQuality.PROVIDER_ESTIMATE",
  LOOMRAIL_ESTIMATE: "workflow.sessions.usageQuality.LOOMRAIL_ESTIMATE",
};

const hardPauseLabelKeys: Record<SessionPauseFailureCode, TranslationKey> = {
  NO_PROGRESS: "workflow.hardPause.noProgress",
  CONTEXT_FLOOR_EXCEEDED: "workflow.hardPause.contextFloor",
  PROVIDER_REJECTED_PACK: "workflow.hardPause.providerRejected",
  PROVIDER_START_FAILED: "workflow.hardPause.providerStartFailed",
  PROVIDER_OUTCOME_REJECTED: "workflow.hardPause.providerOutcomeRejected",
  SESSION_LIMIT_REACHED: "workflow.hardPause.sessionLimit",
};

// A HARD_PAUSED attempt is not necessarily budget-paused: the session loop hard-pauses for reasons
// that have nothing to do with tokens, and decideApproveBudgetOverride refuses a session pause.
// `failureCode` is what tells the two apart; `budgetFallbackKey` lets both call sites below (the
// pipeline-level Status badge and the per-stage list label) keep their own text for the
// genuinely-budget case.
const hardPauseLabel = (
  failureCode: string | null,
  budgetFallbackKey: TranslationKey,
  t: Translator,
): string =>
  isSessionPauseFailureCode(failureCode) ? t(hardPauseLabelKeys[failureCode]) : t(budgetFallbackKey);

const stageAttemptStatusLabel = (attempt: StageAttempt, t: Translator): string => {
  if (attempt.status === "QUEUED") return t("workflow.stage.QUEUED");
  if (attempt.status === "RUNNING") return t("workflow.stage.RUNNING");
  if (attempt.status === "WAITING_HUMAN") return t("workflow.stage.WAITING_HUMAN");
  if (attempt.status === "SOFT_PAUSED") return t("workflow.stage.SOFT_PAUSED");
  if (attempt.status === "HARD_PAUSED") {
    return hardPauseLabel(attempt.failureCode, "workflow.stage.HARD_PAUSED", t);
  }
  if (attempt.status === "INTERRUPTED") return t("workflow.stage.INTERRUPTED");
  if (attempt.status === "CANCELLED") return t("workflow.stage.CANCELLED");
  if (attempt.status === "SUCCEEDED") return t("workflow.stage.SUCCEEDED");
  return t("workflow.stage.other");
};

// A total Record over the contract's own union, matching `stateTones` and `pipelineStatusTones`
// below: a status added to `stageAttemptStatusSchema` without a tone here must fail to compile
// rather than silently fall through, since the attempt header (D5) is the one place on screen that
// names which attempt the sessions list belongs to.
const stageAttemptStatusTones: Record<StageAttemptStatus, StatusTone> = {
  PENDING: "queued",
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_HUMAN: "waiting",
  SOFT_PAUSED: "paused",
  HARD_PAUSED: "waiting",
  SUCCEEDED: "complete",
  FAILED: "paused",
  CANCELLED: "paused",
  INTERRUPTED: "paused",
  RECOVERING: "running",
  STALE: "waiting",
};

const pipelineStatusLabelKeys: Record<PipelineRun["status"], TranslationKey> = {
  RUNNING: "workflow.status.RUNNING",
  WAITING_HUMAN: "workflow.status.WAITING_HUMAN",
  SOFT_PAUSED: "workflow.status.SOFT_PAUSED",
  HARD_PAUSED: "workflow.status.HARD_PAUSED",
  INTERRUPTED: "workflow.status.INTERRUPTED",
  SUCCEEDED: "workflow.status.SUCCEEDED",
  FAILED: "workflow.status.FAILED",
  CANCELLED: "workflow.status.CANCELLED",
};

const pipelineStatusTones: Record<PipelineRun["status"], StatusTone> = {
  RUNNING: "running",
  WAITING_HUMAN: "waiting",
  SOFT_PAUSED: "paused",
  HARD_PAUSED: "waiting",
  INTERRUPTED: "paused",
  SUCCEEDED: "complete",
  FAILED: "paused",
  CANCELLED: "paused",
};

const acceptanceStatusLabelKeys: Record<AcceptancePackage["status"], TranslationKey> = {
  PENDING: "acceptance.status.PENDING",
  ACCEPTED: "acceptance.status.ACCEPTED",
  RETURNED: "acceptance.status.RETURNED",
  REJECTED: "acceptance.status.REJECTED",
};

const acceptanceStatusTones: Record<AcceptancePackage["status"], StatusTone> = {
  PENDING: "waiting",
  ACCEPTED: "complete",
  RETURNED: "paused",
  REJECTED: "paused",
};

const agentRunStatusLabelKeys: Record<AgentRunStatus, TranslationKey> = {
  RUNNING: "agentRun.status.RUNNING",
  SUCCEEDED: "agentRun.status.SUCCEEDED",
  FAILED: "agentRun.status.FAILED",
  CANCELLED: "agentRun.status.CANCELLED",
  INTERRUPTED: "agentRun.status.INTERRUPTED",
  WAITING_HUMAN: "agentRun.status.WAITING_HUMAN",
  SOFT_PAUSED: "agentRun.status.SOFT_PAUSED",
  HARD_PAUSED: "agentRun.status.HARD_PAUSED",
};

const verificationCheckStatusLabelKeys: Record<VerificationCheck["status"], TranslationKey> = {
  QUEUED: "verification.status.QUEUED",
  RUNNING: "verification.status.RUNNING",
  PASSED: "verification.status.PASSED",
  FAILED: "verification.status.FAILED",
  ERROR: "verification.status.ERROR",
  INTERRUPTED: "verification.status.INTERRUPTED",
};

const verificationFailureReasonLabelKeys: Record<VerificationFailure["reason"], TranslationKey> = {
  REQUIRED_CHECK_FAILED: "verification.failure.REQUIRED_CHECK_FAILED",
  REQUIRED_CHECK_ERROR: "verification.failure.REQUIRED_CHECK_ERROR",
  RUN_INTERRUPTED: "verification.failure.RUN_INTERRUPTED",
  STALE: "verification.failure.STALE",
};

const eventPresentation = (event: DomainEvent, t: Translator): Omit<TimelineEventProps, "time"> => {
  switch (event.type) {
    case "WORK_ITEM_CREATED":
      return {
        detail: t("event.createdDetail"),
        icon: "add",
        label: t("event.created"),
        tone: "success",
      };
    case "WORK_ITEM_UPDATED":
      return {
        detail: t("event.updatedDetail", {
          fields: event.data.changedFields.map((field) => t(changedFieldLabelKeys[field])).join(", "),
        }),
        icon: "settings",
        label: t("event.updated"),
      };
    case "WORK_ITEM_STATE_CHANGED":
      return {
        detail: t("event.stateChangedDetail", {
          from: stateLabel(event.data.previousState, t),
          to: stateLabel(event.data.workItem.state, t),
        }),
        icon: event.data.workItem.state === "BLOCKED" ? "pause" : "play",
        label: t("event.stateChanged"),
        tone: event.data.workItem.state === "BLOCKED" ? "warning" : "accent",
      };
    case "PROJECT_REGISTERED":
      return { detail: event.data.project.name, icon: "projects", label: t("event.projectRegistered") };
    case "PROJECT_SCAFFOLD_REQUESTED":
      return {
        detail: event.data.operation.proposal.projectName,
        icon: "clock",
        label: t("event.projectScaffoldRequested"),
      };
    case "PROJECT_SCAFFOLD_COMPLETED":
      return {
        detail: event.data.operation.proposal.projectName,
        icon: "check",
        label: t("event.projectScaffoldCompleted"),
        tone: "success",
      };
    case "PROJECT_SCAFFOLD_FAILED":
      return {
        detail: event.data.operation.lastErrorCode ?? t("error.unknown"),
        icon: "warning",
        label: t("event.projectScaffoldFailed"),
        tone: "warning",
      };
    case "PROJECT_PROVIDER_PREFERENCE_CHANGED":
      return {
        detail: t("event.providerPreferenceChangedDetail", {
          from: event.data.previousPreference,
          to: event.data.selection.preference,
        }),
        icon: "settings",
        label: t("event.providerPreferenceChanged"),
      };
    case "PROVIDER_ALLOWANCE_RECORDED":
      return {
        detail: t("event.providerAllowanceRecordedDetail", {
          provider: event.data.snapshot.provider.replace("_", " "),
          freshness: t(
            event.data.snapshot.freshness === "LIVE"
              ? "providerAllowance.freshness.live"
              : event.data.snapshot.freshness === "STALE"
                ? "providerAllowance.freshness.stale"
                : "providerAllowance.freshness.unavailable",
          ),
        }),
        icon: "budget",
        label: t("event.providerAllowanceRecorded"),
      };
    case "MCP_PROFILE_CONSENTED":
      return {
        detail: t("event.mcpProfileConsentedDetail", {
          name: event.data.revision.name,
          revision: event.data.revision.revision,
        }),
        icon: "settings",
        label: t("event.mcpProfileConsented"),
      };
    case "MCP_GRANT_CHANGED":
      return {
        detail: t("event.mcpGrantChangedDetail", {
          count: event.data.grant.tools.length,
          state: t(event.data.grant.enabled ? "event.mcpGrant.enabled" : "event.mcpGrant.revoked"),
        }),
        icon: event.data.grant.enabled ? "check" : "pause",
        label: t("event.mcpGrantChanged"),
        tone: event.data.grant.enabled ? "success" : "warning",
      };
    case "PROJECT_CONSTITUTION_PROPOSED":
      return {
        detail: t("event.constitutionProposedDetail", { preset: event.data.proposal.presetId }),
        icon: "settings",
        label: t("event.constitutionProposed"),
      };
    case "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED":
      return {
        detail: t("event.constitutionPublicationRequestedDetail", {
          ordinal: event.data.constitution.ordinal,
        }),
        icon: "clock",
        label: t("event.constitutionPublicationRequested"),
        tone: "accent",
      };
    case "PROJECT_CONSTITUTION_ACTIVATED":
      return {
        detail: t("event.constitutionActivatedDetail", {
          ordinal: event.data.constitution.ordinal,
        }),
        icon: "check",
        label: t("event.constitutionActivated"),
        tone: "success",
      };
    case "PROJECT_CONSTITUTION_PUBLICATION_FAILED":
      return {
        detail: event.data.publication.lastErrorCode ?? t("error.unknown"),
        icon: "pause",
        label: t("event.constitutionPublicationFailed"),
        tone: "warning",
      };
    case "VERIFICATION_PLAN_ADOPTED":
      return {
        detail: t("event.verificationPlanAdoptedDetail", {
          count: event.data.plan.recipes.length,
          revision: event.data.plan.revision,
        }),
        icon: "settings",
        label: t("event.verificationPlanAdopted"),
        tone: "accent",
      };
    case "VERIFICATION_PLAN_PUBLICATION_APPLIED":
      return {
        detail: t("event.verificationPlanPublicationAppliedDetail", {
          revision: event.data.plan.revision,
        }),
        icon: "check",
        label: t("event.verificationPlanPublicationApplied"),
        tone: "success",
      };
    case "VERIFICATION_PLAN_PUBLICATION_FAILED":
      return {
        detail: event.data.publication.lastErrorCode ?? t("error.unknown"),
        icon: "warning",
        label: t("event.verificationPlanPublicationFailed"),
        tone: "warning",
      };
    case "VERIFICATION_PLAN_PUBLICATION_RETRIED":
      return {
        detail: t("event.verificationPlanPublicationRetriedDetail", {
          revision: event.data.plan.revision,
        }),
        icon: "clock",
        label: t("event.verificationPlanPublicationRetried"),
        tone: "accent",
      };
    case "VERIFICATION_RUN_RESERVED":
      return {
        detail: t("event.verificationRunReservedDetail", {
          count: event.data.checks.length,
          ordinal: event.data.run.ordinal,
        }),
        icon: "test",
        label: t("event.verificationRunReserved"),
        tone: "accent",
      };
    case "VERIFICATION_CHECK_STARTED":
      return {
        detail: t("event.verificationCheckStartedDetail", { ordinal: event.data.check.ordinal }),
        icon: "play",
        label: t("event.verificationCheckStarted"),
        tone: "accent",
      };
    case "VERIFICATION_CHECK_COMPLETED":
      return {
        detail: t("event.verificationCheckCompletedDetail", {
          ordinal: event.data.check.ordinal,
          status: t(verificationCheckStatusLabelKeys[event.data.check.status]),
        }),
        icon: event.data.check.status === "PASSED" ? "check" : "warning",
        label: t("event.verificationCheckCompleted"),
        tone: event.data.check.status === "PASSED" ? "success" : "warning",
      };
    case "VERIFICATION_RUN_INTERRUPTED":
      return {
        detail: t("event.verificationRunInterruptedDetail", { ordinal: event.data.run.ordinal }),
        icon: "pause",
        label: t("event.verificationRunInterrupted"),
        tone: "warning",
      };
    case "VERIFICATION_FAILURE_RECORDED":
      return {
        detail: t("event.verificationFailureRecordedDetail", {
          reason: t(verificationFailureReasonLabelKeys[event.data.failure.reason]),
        }),
        icon: "warning",
        label: t("event.verificationFailureRecorded"),
        tone: "warning",
      };
    case "VERIFICATION_CORRECTION_STARTED":
      return {
        detail: t("event.verificationCorrectionStartedDetail", {
          ordinal: event.data.correctionRun.budgetPosition,
        }),
        icon: "play",
        label: t("event.verificationCorrectionStarted"),
        tone: "accent",
      };
    case "VERIFICATION_CORRECTION_PASSED":
      return {
        detail: t("event.verificationCorrectionPassedDetail", {
          ordinal: event.data.correctionRun.budgetPosition,
        }),
        icon: "check",
        label: t("event.verificationCorrectionPassed"),
        tone: "success",
      };
    case "VERIFICATION_CORRECTION_SUPERSEDED":
      return {
        detail: t("event.verificationCorrectionSupersededDetail", {
          ordinal: event.data.correctionRun.budgetPosition,
        }),
        icon: "warning",
        label: t("event.verificationCorrectionSuperseded"),
        tone: "warning",
      };
    case "VERIFICATION_CORRECTION_EXHAUSTED":
      return {
        detail: t("event.verificationCorrectionExhaustedDetail", {
          ordinal: event.data.correctionRun.budgetPosition,
        }),
        icon: "pause",
        label: t("event.verificationCorrectionExhausted"),
        tone: "warning",
      };
    case "VERIFICATION_CORRECTION_CANCELLED":
      return {
        detail: t("event.verificationCorrectionCancelledDetail", {
          ordinal: event.data.correctionRun.budgetPosition,
        }),
        icon: "pause",
        label: t("event.verificationCorrectionCancelled"),
        tone: "warning",
      };
    case "PROJECT_READINESS_ASSESSED":
      return {
        detail: t("event.readinessAssessedDetail", {
          count: event.data.checks.filter((check) => check.status === "ACTION_REQUIRED").length,
        }),
        icon: event.data.run.status === "READY" ? "check" : "warning",
        label: t("event.readinessAssessed"),
        tone: event.data.run.status === "READY" ? "success" : "warning",
      };
    case "PROJECT_READINESS_ATTESTED":
      return {
        detail: t("event.readinessAttestedDetail", {
          check: t(readinessCheckKeys[event.data.check.key]),
          outcome: t(readinessStatusKeys[event.data.check.status]),
        }),
        icon: "check",
        label: t("event.readinessAttested"),
        tone: "success",
      };
    case "PIPELINE_STARTED":
      return {
        detail: t("event.pipelineStartedDetail", {
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
        }),
        icon: "play",
        label: t("event.pipelineStarted"),
        tone: "accent",
      };
    case "STAGE_ATTEMPT_CHANGED":
      return {
        detail: t("event.stageChangedDetail", {
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
          status: stageAttemptStatusLabel(event.data.stageAttempt, t),
        }),
        icon: event.data.stageAttempt.status === "SUCCEEDED" ? "check" : "clock",
        label: t("event.stageChanged"),
        tone: event.data.stageAttempt.status === "SUCCEEDED" ? "success" : "accent",
      };
    case "HUMAN_REQUEST_OPENED":
      return {
        detail: t("event.humanRequestOpenedDetail", { title: event.data.request.title }),
        icon: "question",
        label: t("event.humanRequestOpened"),
        tone: "warning",
      };
    case "HUMAN_REQUEST_RESOLVED":
      return {
        detail: t("event.humanRequestResolvedDetail"),
        icon: "check",
        label: t("event.humanRequestResolved"),
        tone: "success",
      };
    case "USAGE_RECORDED":
      return {
        detail: t("event.usageRecordedDetail", {
          amount: event.data.usageRecord.amount,
          total: event.data.cumulativeAmount,
        }),
        icon: "clock",
        label: t("event.usageRecorded"),
      };
    case "BUDGET_THRESHOLD_REACHED":
      return {
        detail: t("event.budgetThresholdDetail", {
          threshold: Math.round(event.data.threshold * 100),
          total: event.data.cumulativeAmount,
        }),
        icon: "filter",
        label: t("event.budgetThreshold"),
        tone: event.data.threshold >= 1 ? "warning" : "accent",
      };
    case "PIPELINE_PAUSED":
      return {
        detail: t("event.pipelinePausedDetail", {
          kind: event.data.kind,
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
        }),
        icon: "pause",
        label: t("event.pipelinePaused"),
        tone: "warning",
      };
    case "PIPELINE_RESUMED":
      return {
        detail: t("event.pipelineResumedDetail", {
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
        }),
        icon: "play",
        label: t("event.pipelineResumed"),
        tone: "accent",
      };
    case "PIPELINE_CANCELLED":
      return {
        detail: t("event.pipelineCancelledDetail", {
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
        }),
        icon: "pause",
        label: t("event.pipelineCancelled"),
        tone: "warning",
      };
    case "BUDGET_OVERRIDE_APPROVED":
      return {
        detail: t("event.budgetOverrideDetail", {
          revision: event.data.budgetPolicy.revision,
          limit: event.data.budgetPolicy.maxEstimatedTokens,
        }),
        icon: "settings",
        label: t("event.budgetOverride"),
        tone: "accent",
      };
    case "RECOVERY_REPORT_CREATED":
      return {
        detail: t("event.recoveryCreatedDetail", {
          stage: t(stageLabelKeys[event.data.stageAttempt.stage]),
        }),
        icon: "clock",
        label: t("event.recoveryCreated"),
        tone: "warning",
      };
    case "EVIDENCE_ARTIFACT_RECORDED":
      return {
        detail: t("event.evidenceRecordedDetail", { title: event.data.artifact.title }),
        icon: "check",
        label: t("event.evidenceRecorded"),
        tone: "success",
      };
    case "REVIEW_REPORT_RECORDED":
      return {
        detail: t("event.reviewReportRecordedDetail", {
          round: event.data.report.round,
          verdict: t(`review.verdict.${event.data.report.verdict}`),
        }),
        icon: "check",
        label: t("event.reviewReportRecorded"),
        tone: event.data.report.verdict === "PASSED" ? "success" : "warning",
      };
    case "REVIEW_FINDING_RECORDED":
      return {
        detail: event.data.finding.title,
        icon: "warning",
        label: t("event.reviewFindingRecorded"),
        tone: "warning",
      };
    case "REVIEW_FINDING_RESOLVED":
      return {
        detail: event.data.finding.title,
        icon: "check",
        label: t("event.reviewFindingResolved"),
        tone: "success",
      };
    case "REVIEW_LOOP_EXHAUSTED":
      return {
        detail: t("event.reviewLoopExhaustedDetail", { round: event.data.report.round }),
        icon: "pause",
        label: t("event.reviewLoopExhausted"),
        tone: "warning",
      };
    case "ACCEPTANCE_REQUESTED":
      return {
        detail: t("event.acceptanceRequestedDetail"),
        icon: "question",
        label: t("event.acceptanceRequested"),
        tone: "warning",
      };
    case "ACCEPTANCE_RESOLVED":
      return {
        detail: t("event.acceptanceResolvedDetail", { action: event.data.action }),
        icon: event.data.action === "ACCEPT" ? "check" : "pause",
        label: t("event.acceptanceResolved"),
        tone: event.data.action === "ACCEPT" ? "success" : "warning",
      };
    case "PIPELINE_COMPLETED":
      return {
        detail: t("event.pipelineCompletedDetail"),
        icon: "check",
        label: t("event.pipelineCompleted"),
        tone: "success",
      };
    case "SQUAD_ASSIGNED":
      return {
        detail: t("event.squadAssignedDetail", { count: event.data.assignment.stages.length }),
        icon: "agents",
        label: t("event.squadAssigned"),
      };
    case "AGENT_RUN_STARTED":
      return {
        detail: t("event.agentRunStartedDetail", {
          role: t(`fleet.role.${event.data.run.profile.role}`),
          provider: event.data.run.provider.replace("_", " "),
        }),
        icon: "agents",
        label: t("event.agentRunStarted"),
        tone: "accent",
      };
    case "AGENT_RUN_FINISHED":
      return {
        detail: t("event.agentRunFinishedDetail", {
          role: t(`fleet.role.${event.data.run.profile.role}`),
          status: t(agentRunStatusLabelKeys[event.data.run.status]),
        }),
        icon: "agents",
        label: t("event.agentRunFinished"),
        tone: event.data.run.status === "SUCCEEDED" ? "success" : "warning",
      };
    case "QA_RUN_RESERVED":
      return {
        detail: t("event.qaRunReservedDetail", {
          targets: event.data.qaRun.plan.targets.length,
          scenarios: event.data.qaRun.plan.scenarios.length,
        }),
        icon: "sessions",
        label: t("event.qaRunReserved"),
        tone: "accent",
      };
    case "QA_RUN_COMPLETED":
      return {
        detail: t("event.qaRunCompletedDetail", {
          status: event.data.qaRun.status,
          defects: event.data.defectIds.length,
        }),
        icon: event.data.qaRun.status === "PASSED" ? "check" : "warning",
        label: t("event.qaRunCompleted"),
        tone: event.data.qaRun.status === "PASSED" ? "success" : "warning",
      };
    case "QA_DEFECT_WAIVED":
      return {
        detail: event.data.defect.title,
        icon: "check",
        label: t("event.qaDefectWaived"),
        tone: "warning",
      };
    case "QA_CORRECTION_STARTED":
      return {
        detail: t("event.qaCorrectionStartedDetail", {
          ordinal: event.data.correctionRun.ordinal,
          cells: event.data.retestPlan.cells.length,
        }),
        icon: "play",
        label: t("event.qaCorrectionStarted"),
        tone: "accent",
      };
    case "QA_CORRECTION_EXHAUSTED":
      return {
        detail: t("event.qaCorrectionExhaustedDetail", {
          ordinal: event.data.correctionRun.ordinal,
        }),
        icon: "pause",
        label: t("event.qaCorrectionExhausted"),
        tone: "warning",
      };
    case "QA_CORRECTION_PASSED":
      return {
        detail: t("event.qaCorrectionPassedDetail", {
          ordinal: event.data.correctionRun.ordinal,
          defects: event.data.resolvedDefects.length,
        }),
        icon: "check",
        label: t("event.qaCorrectionPassed"),
        tone: "success",
      };
    case "QA_CORRECTION_CANCELLED":
      return {
        detail: t("event.qaCorrectionCancelledDetail", {
          ordinal: event.data.correctionRun.ordinal,
        }),
        icon: "warning",
        label: t("event.qaCorrectionCancelled"),
        tone: "warning",
      };
    case "PROVIDER_SESSION_STARTED":
      return {
        detail: t("event.providerSessionStartedDetail", { ordinal: event.data.session.ordinal }),
        icon: "sessions",
        label: t("event.providerSessionStarted"),
        tone: "accent",
      };
    case "CHECKPOINT_PUBLISHED":
      return {
        detail: t("event.checkpointPublishedDetail", { summary: event.data.checkpoint.summary }),
        icon: "check",
        label: t("event.checkpointPublished"),
        tone: "success",
      };
    case "CONTEXT_HANDOFF_REQUESTED":
      return {
        detail: t("event.contextHandoffRequestedDetail", { ordinal: event.data.session.ordinal }),
        icon: "clock",
        label: t("event.contextHandoffRequested"),
        tone: "warning",
      };
    case "PROVIDER_SESSION_ENDED":
      return {
        detail: t("event.providerSessionEndedDetail", { reason: event.data.session.endReason ?? "" }),
        icon: "sessions",
        label: t("event.providerSessionEnded"),
        tone: event.data.session.endReason === "COMPLETED" ? "success" : "neutral",
      };
    case "CONTEXT_FLOOR_EXCEEDED":
      return {
        detail: t("event.contextFloorExceededDetail", {
          ordinal: event.data.sessionOrdinal,
          requiredBytes: event.data.requiredBytes,
          budgetBytes: event.data.budgetBytes,
        }),
        icon: "pause",
        label: t("event.contextFloorExceeded"),
        tone: "warning",
      };
    case "WORK_ITEM_WORKSPACE_CREATED":
      return {
        detail: t("event.workspaceCreatedDetail", { branch: event.data.workspace.branch }),
        icon: "branch",
        label: t("event.workspaceCreated"),
        tone: "success",
      };
    case "WORK_ITEM_WORKSPACE_ORPHANED":
      return {
        detail: t("event.workspaceOrphanedDetail"),
        icon: "warning",
        label: t("event.workspaceOrphaned"),
        tone: "warning",
      };
  }
};

const eventTime = (occurredAt: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(occurredAt));

const WorkItemButton = ({
  item,
  onSelect,
  selected,
}: {
  item: WorkItem;
  onSelect: (id: string) => void;
  selected: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The board scrolls horizontally, so a selected task can sit in an off-screen column - including
  // after a workflow moves it there. Reveal it instead of leaving the visible columns looking empty.
  useEffect(() => {
    if (!selected) return;
    buttonRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <button
      aria-label={item.title}
      aria-pressed={selected}
      className="task-card-button"
      onClick={() => {
        onSelect(item.id);
      }}
      ref={buttonRef}
      type="button"
    >
      <TaskCard
        agent={t(typeLabelKeys[item.type])}
        badge={{ label: t(priorityLabelKeys[item.priority]), tone: priorityTone(item.priority) }}
        description={item.description}
        id={displayWorkItemId(item.id)}
        meta={stateLabel(item.state, t)}
        selected={selected}
        title={item.title}
      />
    </button>
  );
};

const criteriaFromText = (value: string): readonly string[] =>
  value
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);

const TaskEditDialog = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const { t } = useI18n();
  const updateMutation = useUpdateWorkItem();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [priority, setPriority] = useState(item.priority);
  const [risk, setRisk] = useState(item.risk);
  const [criteriaText, setCriteriaText] = useState(item.acceptanceCriteria.join("\n"));
  const acceptanceCriteria = criteriaFromText(criteriaText);
  const criteriaValid =
    acceptanceCriteria.length <= 50 && acceptanceCriteria.every((criterion) => criterion.length <= 500);
  const changed =
    title.trim() !== item.title ||
    description.trim() !== item.description ||
    priority !== item.priority ||
    risk !== item.risk ||
    acceptanceCriteria.length !== item.acceptanceCriteria.length ||
    acceptanceCriteria.some((criterion, index) => criterion !== item.acceptanceCriteria[index]);

  const resetDraft = (): void => {
    setTitle(item.title);
    setDescription(item.description);
    setPriority(item.priority);
    setRisk(item.risk);
    setCriteriaText(item.acceptanceCriteria.join("\n"));
    updateMutation.reset();
  };

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const normalizedDescription = description.trim();
    if (!normalizedTitle || !criteriaValid || !changed) return;

    const patch = {
      ...(normalizedTitle === item.title ? {} : { title: normalizedTitle }),
      ...(normalizedDescription === item.description ? {} : { description: normalizedDescription }),
      ...(priority === item.priority ? {} : { priority }),
      ...(risk === item.risk ? {} : { risk }),
      ...(acceptanceCriteria.length === item.acceptanceCriteria.length &&
      acceptanceCriteria.every((criterion, index) => criterion === item.acceptanceCriteria[index])
        ? {}
        : { acceptanceCriteria: [...acceptanceCriteria] }),
    };

    updateMutation.mutate(
      { patch, workItem: item },
      {
        onSuccess: () => {
          setOpen(false);
        },
      },
    );
  };

  return (
    <DialogSurface
      closeLabel={t("action.closeDialog")}
      description={t("task.edit.description")}
      footer={
        <>
          <Button
            disabled={updateMutation.isPending}
            onClick={() => {
              setOpen(false);
              resetDraft();
            }}
          >
            {t("action.cancel")}
          </Button>
          <Button
            disabled={!title.trim() || !criteriaValid || !changed}
            loading={updateMutation.isPending}
            onClick={() => {
              formRef.current?.requestSubmit();
            }}
            type="button"
            variant="primary"
          >
            {t("task.edit.submit")}
          </Button>
        </>
      }
      onOpenChange={(nextOpen) => {
        if (nextOpen) resetDraft();
        setOpen(nextOpen);
      }}
      open={open}
      size="lg"
      title={t("task.edit")}
      trigger={<IconButton label={t("task.edit")} name="edit" size="sm" variant="surface" />}
      triggerTooltip={t("task.edit")}
    >
      <form className="edit-task-form" onSubmit={submit} ref={formRef}>
        {updateMutation.error ? (
          <LocalConnectionRecovery
            error={updateMutation.error}
            onRetry={() => {
              formRef.current?.requestSubmit();
            }}
            retrying={updateMutation.isPending}
          />
        ) : null}
        <Field htmlFor="edit-task-title" label={t("task.create.title")} required>
          <TextField
            autoFocus
            id="edit-task-title"
            maxLength={200}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
            required
            value={title}
          />
        </Field>
        <Field htmlFor="edit-task-description" label={t("task.create.brief")}>
          <Textarea
            id="edit-task-description"
            maxLength={20_000}
            onChange={(event) => {
              setDescription(event.currentTarget.value);
            }}
            rows={5}
            value={description}
          />
        </Field>
        <div className="edit-task-form__row">
          <Field htmlFor="edit-task-priority" label={t("task.priority")}>
            <SelectControl
              ariaLabel={t("task.priority")}
              id="edit-task-priority"
              onValueChange={(value) => {
                setPriority(prioritySchema.parse(value));
              }}
              options={(Object.keys(priorityLabelKeys) as WorkItem["priority"][]).map((value) => ({
                label: t(priorityLabelKeys[value]),
                value,
              }))}
              value={priority}
            />
          </Field>
          <Field htmlFor="edit-task-risk" label={t("task.risk")}>
            <SelectControl
              ariaLabel={t("task.risk")}
              id="edit-task-risk"
              onValueChange={(value) => {
                setRisk(riskSchema.parse(value));
              }}
              options={(Object.keys(riskLabelKeys) as WorkItem["risk"][]).map((value) => ({
                label: t(riskLabelKeys[value]),
                value,
              }))}
              value={risk}
            />
          </Field>
        </div>
        <Field
          description={t("task.edit.criteriaDescription")}
          htmlFor="edit-work-item-criteria"
          label={t("task.acceptanceCriteria")}
          {...(criteriaValid ? {} : { error: t("task.edit.criteriaError") })}
        >
          <Textarea
            aria-describedby="edit-work-item-criteria-description"
            id="edit-work-item-criteria"
            invalid={!criteriaValid}
            onChange={(event) => {
              setCriteriaText(event.currentTarget.value);
            }}
            rows={5}
            value={criteriaText}
          />
        </Field>
      </form>
    </DialogSurface>
  );
};

type ReviewReportView = ReviewStateResponse["reports"][number];

const reviewSeverityTones: Record<ReviewFinding["severity"], BadgeTone> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "danger",
};

const reviewFindingStatusTones: Record<ReviewFinding["status"], BadgeTone> = {
  OPEN: "danger",
  RESOLVED: "success",
  WAIVED: "warning",
  FALSE_POSITIVE: "neutral",
};

const reviewLocation = (finding: ReviewFinding): string | null => {
  if (finding.path === null) return null;
  if (finding.startLine === null) return finding.path;
  return `${finding.path}:${finding.startLine.toString()}-${(finding.endLine ?? finding.startLine).toString()}`;
};

const ReviewPanel = ({ item }: { item: WorkItem }): React.JSX.Element | null => {
  const { t } = useI18n();
  const reviewQuery = useWorkItemReviews(item.id);
  const dispositionMutation = useDisposeReviewFinding();
  const [selected, setSelected] = useState<{
    finding: ReviewFinding;
    disposition: ReviewFindingOwnerDisposition;
  } | null>(null);
  const [reason, setReason] = useState("");

  if (reviewQuery.error) {
    return (
      <LocalConnectionRecovery
        error={reviewQuery.error}
        onRetry={() => {
          void reviewQuery.refetch();
        }}
        retrying={reviewQuery.isFetching}
      />
    );
  }
  const review = reviewQuery.data;
  const latest: ReviewReportView | undefined = review?.reports[0];
  if (latest === undefined && (review?.findings.length ?? 0) === 0) return null;

  const submitDisposition = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selected === null || reason.trim().length === 0) return;
    dispositionMutation.mutate(
      { ...selected, reason: reason.trim() },
      {
        onSuccess: () => {
          setSelected(null);
          setReason("");
        },
      },
    );
  };

  return (
    <section aria-label={t("review.title")} className="review-panel">
      {latest ? (
        <header className="review-panel__heading">
          <div>
            <span>{t("review.round", { round: latest.round })}</span>
            <strong>{latest.title}</strong>
          </div>
          <Badge tone={latest.verdict === "PASSED" ? "success" : "danger"}>
            {t(`review.verdict.${latest.verdict}`)}
          </Badge>
        </header>
      ) : null}
      {latest ? (
        <div className="review-panel__summary">
          <p>{latest.summary}</p>
          <dl>
            <div>
              <dt>{t("review.reviewer")}</dt>
              <dd>{latest.reviewerProvider}</dd>
            </div>
            <div>
              <dt>{t("review.relation")}</dt>
              <dd>{t(`review.relation.${latest.providerRelation}`)}</dd>
            </div>
            <div>
              <dt>{t("review.tree")}</dt>
              <dd>
                <code title={latest.reviewedTree}>{latest.reviewedTree.slice(0, 8)}</code>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
      {review && review.findings.length > 0 ? (
        <ol aria-label={t("review.findings")} className="review-finding-list">
          {review.findings.map((finding) => {
            const location = reviewLocation(finding);
            return (
              <li key={finding.id}>
                <div className="review-finding__heading">
                  <strong>{finding.title}</strong>
                  <span>
                    <Badge tone={reviewSeverityTones[finding.severity]}>
                      {t(`review.severity.${finding.severity}`)}
                    </Badge>
                    <Badge tone={reviewFindingStatusTones[finding.status]}>
                      {t(`review.findingStatus.${finding.status}`)}
                    </Badge>
                  </span>
                </div>
                <p>{finding.description}</p>
                {location ? <code className="review-finding__location">{location}</code> : null}
                <div className="review-finding__detail">
                  <strong>{t("review.reproduction")}</strong>
                  <span>{finding.reproduction}</span>
                </div>
                {finding.status === "OPEN" ? (
                  <div className="review-finding__actions">
                    <Button
                      onClick={() => {
                        dispositionMutation.reset();
                        setReason("");
                        setSelected({ finding, disposition: "WAIVED" });
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {t("review.waive")}
                    </Button>
                    <Button
                      onClick={() => {
                        dispositionMutation.reset();
                        setReason("");
                        setSelected({ finding, disposition: "FALSE_POSITIVE" });
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {t("review.falsePositive")}
                    </Button>
                  </div>
                ) : finding.resolutionReason ? (
                  <p className="review-finding__resolution">{finding.resolutionReason}</p>
                ) : null}
                {selected?.finding.id === finding.id ? (
                  <form className="review-disposition" onSubmit={submitDisposition}>
                    <Field htmlFor={`review-disposition-${finding.id}`} label={t("review.reason")}>
                      <Textarea
                        autoFocus
                        id={`review-disposition-${finding.id}`}
                        maxLength={4_000}
                        onChange={(event) => {
                          setReason(event.currentTarget.value);
                        }}
                        placeholder={t("review.reasonPlaceholder")}
                        rows={3}
                        value={reason}
                      />
                    </Field>
                    {dispositionMutation.error ? (
                      <LocalConnectionRecovery error={dispositionMutation.error} />
                    ) : null}
                    <div>
                      <Button
                        disabled={reason.trim().length === 0}
                        loading={dispositionMutation.isPending}
                        size="sm"
                        type="submit"
                        variant="primary"
                      >
                        {t(
                          selected.disposition === "WAIVED"
                            ? "review.confirmWaive"
                            : "review.confirmFalsePositive",
                        )}
                      </Button>
                      <Button
                        disabled={dispositionMutation.isPending}
                        onClick={() => {
                          setSelected(null);
                          setReason("");
                        }}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        {t("action.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="review-panel__empty">{t("review.noFindings")}</p>
      )}
    </section>
  );
};

type QARunView = QAStateResponse["runs"][number];

const qaRunStatusTones: Record<QARunStatus, BadgeTone> = {
  RUNNING: "info",
  PASSED: "success",
  FAILED: "danger",
  ERROR: "warning",
};

const qaObservationTones: Record<QAObservation["severity"], BadgeTone> = {
  INFO: "neutral",
  WARNING: "warning",
  ERROR: "danger",
};

const qaDefectTones: Record<QADefect["severity"], BadgeTone> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "danger",
};

const qaDefectStatusTones: Record<QADefect["status"], BadgeTone> = {
  OPEN: "danger",
  RESOLVED: "success",
  WAIVED: "warning",
};

const qaCorrectionStatusTones: Record<QAStateResponse["correctionRuns"][number]["status"], BadgeTone> = {
  ACTIVE: "info",
  PASSED: "success",
  SUPERSEDED: "neutral",
  EXHAUSTED: "warning",
  CANCELLED: "neutral",
};

const BrowserQAPanel = ({
  correctionGate,
  item,
}: {
  correctionGate: { correctionRunId: string; request: HumanRequest; run: PipelineRun } | null;
  item: WorkItem;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const qaQuery = useWorkItemQA(item.id);
  const gateMutation = useResolveQACorrectionGate();
  const waiverMutation = useWaiveQADefect();
  const [selectedDefect, setSelectedDefect] = useState<QADefect | null>(null);
  const [waiverReason, setWaiverReason] = useState("");
  if (qaQuery.error) {
    return (
      <LocalConnectionRecovery
        error={qaQuery.error}
        onRetry={() => {
          void qaQuery.refetch();
        }}
        retrying={qaQuery.isFetching}
      />
    );
  }

  const qa = qaQuery.data;
  const latest: QARunView | undefined = qa?.runs.at(-1);
  if (qa === undefined || latest === undefined) return null;
  const evidence = qa.evidence.find(({ qaRunId }) => qaRunId === latest.id);
  const attachments = qa.attachments.filter(({ qaRunId }) => qaRunId === latest.id);
  const defects = qa.defects;
  const environment = evidence?.environment;
  const exhaustedCorrection =
    correctionGate === null
      ? undefined
      : qa.correctionRuns.find(({ id }) => id === correctionGate.correctionRunId);

  const submitWaiver = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedDefect === null || waiverReason.trim().length === 0) return;
    waiverMutation.mutate(
      { defect: selectedDefect, reason: waiverReason.trim() },
      {
        onSuccess: () => {
          setSelectedDefect(null);
          setWaiverReason("");
        },
      },
    );
  };

  return (
    <section aria-label={t("qa.title")} className="qa-panel">
      <header className="qa-panel__heading">
        <div>
          <span>{t("qa.planRevision", { revision: latest.plan.revision })}</span>
          <strong>{t("qa.title")}</strong>
        </div>
        <Badge tone={qaRunStatusTones[latest.status]}>{t(`qa.status.${latest.status}`)}</Badge>
      </header>

      {correctionGate !== null && exhaustedCorrection?.status === "EXHAUSTED" ? (
        <div className="human-request-card">
          <h3>{t("qa.correctionGate.title")}</h3>
          <p>{t("qa.correctionGate.description", { ordinal: exhaustedCorrection.ordinal })}</p>
          {correctionGate.request.recommendation ? (
            <div className="human-request-card__recommendation">
              <strong>{t("humanRequest.recommendation")}</strong>
              <span>{correctionGate.request.recommendation}</span>
            </div>
          ) : null}
          {gateMutation.error ? <LocalConnectionRecovery error={gateMutation.error} /> : null}
          <div className="workflow-panel__actions">
            {exhaustedCorrection.ordinal === 2 ? (
              <Button
                disabled={gateMutation.isPending}
                loading={gateMutation.isPending && gateMutation.variables.action === "AUTHORIZE_FINAL"}
                onClick={() => {
                  gateMutation.mutate({
                    action: "AUTHORIZE_FINAL",
                    correctionRun: exhaustedCorrection,
                    request: correctionGate.request,
                    run: correctionGate.run,
                  });
                }}
                variant="primary"
              >
                {t("qa.correctionGate.authorizeFinal")}
              </Button>
            ) : null}
            <Button
              disabled={gateMutation.isPending}
              loading={gateMutation.isPending && gateMutation.variables.action === "CANCEL"}
              onClick={() => {
                gateMutation.mutate({
                  action: "CANCEL",
                  correctionRun: exhaustedCorrection,
                  request: correctionGate.request,
                  run: correctionGate.run,
                });
              }}
              variant="secondary"
            >
              {t("qa.correctionGate.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      <dl className="qa-panel__facts">
        <div>
          <dt>{t("qa.tree")}</dt>
          <dd>
            <code title={latest.testedTree}>{latest.testedTree.slice(0, 8)}</code>
          </dd>
        </div>
        <div>
          <dt>{t("qa.target")}</dt>
          <dd>{latest.targetOrigin}</dd>
        </div>
        <div>
          <dt>{t("qa.environment")}</dt>
          <dd>
            {environment
              ? `${environment.browserName} ${environment.browserVersion} · ${environment.osFamily} · Node ${environment.runtimeVersion}`
              : t("qa.notRun")}
          </dd>
        </div>
      </dl>

      {latest.error ? <p className="qa-panel__error">{latest.error.summary}</p> : null}

      {qa.correctionRuns.length > 0 ? (
        <div className="qa-panel__section">
          <strong>{t("qa.correctionTimeline")}</strong>
          <ol aria-label={t("qa.correctionTimeline")} className="qa-correction-list">
            {qa.correctionRuns.map((correction) => {
              const retestPlan = qa.retestPlans.find(
                (candidate) => candidate.correctionRunId === correction.id,
              );
              return (
                <li key={correction.id}>
                  <div className="qa-correction__heading">
                    <strong>{t("qa.correction", { ordinal: correction.ordinal })}</strong>
                    <Badge tone={qaCorrectionStatusTones[correction.status]}>
                      {t(`qa.correctionStatus.${correction.status}`)}
                    </Badge>
                  </div>
                  <dl className="qa-correction__lineage">
                    <div>
                      <dt>{t("qa.correctionSource")}</dt>
                      <dd>
                        <code title={correction.sourceQARunId}>{correction.sourceQARunId}</code>
                        <span>
                          {t("qa.correctionTree", { tree: correction.sourceTestedTree.slice(0, 8) })}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("qa.correctionEvidence")}</dt>
                      <dd>
                        <code title={correction.sourceEvidenceBundleId}>
                          {correction.sourceEvidenceBundleId}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("qa.correctionBaseline")}</dt>
                      <dd>
                        <code title={correction.baselineQARunId}>{correction.baselineQARunId}</code>
                      </dd>
                    </div>
                  </dl>
                  {retestPlan ? (
                    <div className="qa-correction__scope">
                      <strong>{t("qa.retestScope", { count: retestPlan.cells.length })}</strong>
                      <ol>
                        {retestPlan.cells.map((cell) => (
                          <li key={`${cell.targetId}:${cell.scenarioId}`}>
                            <code>{cell.targetId}</code>
                            <span aria-hidden="true">/</span>
                            <code>{cell.scenarioId}</code>
                            <span className="qa-correction__reasons">
                              {cell.reasons.map((reason) => (
                                <span key={reason}>{t(`qa.retestReason.${reason}`)}</span>
                              ))}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="qa-panel__section">
        <strong>{t("qa.matrix")}</strong>
        <ol className="qa-matrix">
          {latest.plan.targets.flatMap((target) =>
            latest.plan.scenarios.map((scenario) => {
              const execution = evidence?.executions.find(
                (candidate) => candidate.targetId === target.id && candidate.scenarioId === scenario.id,
              );
              const failedAssertions =
                execution?.assertions.filter(({ status }) => status === "FAILED") ?? [];
              const failedSteps = execution?.steps.filter(({ status }) => status === "FAILED") ?? [];
              const passed =
                execution !== undefined && failedAssertions.length === 0 && failedSteps.length === 0;
              return (
                <li key={`${target.id}:${scenario.id}`}>
                  <div className="qa-matrix__heading">
                    <div>
                      <strong>{scenario.title}</strong>
                      <span>
                        {target.viewport.width}×{target.viewport.height} · {target.locale} ·{" "}
                        {t(target.theme === "LIGHT" ? "theme.light" : "theme.dark")}
                      </span>
                    </div>
                    <Badge tone={execution === undefined ? "neutral" : passed ? "success" : "danger"}>
                      {execution === undefined
                        ? t("qa.notRun")
                        : t(passed ? "qa.status.PASSED" : "qa.status.FAILED")}
                    </Badge>
                  </div>
                  {execution ? (
                    <span className="qa-matrix__progress">
                      {t("qa.scenarioProgress", {
                        steps: execution.steps.length,
                        assertions: execution.assertions.length,
                      })}
                    </span>
                  ) : null}
                  {failedAssertions.length > 0 ? (
                    <ul className="qa-matrix__failures">
                      {failedAssertions.map((assertion) => {
                        const plan = scenario.assertions.find(({ id }) => id === assertion.id);
                        return (
                          <li key={assertion.id}>
                            {t("qa.assertionFailed", { title: plan?.title ?? assertion.id })}
                            {assertion.details ? <span>{assertion.details}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            }),
          )}
        </ol>
      </div>

      {evidence && evidence.observations.length > 0 ? (
        <div className="qa-panel__section">
          <strong>{t("qa.observations")}</strong>
          <ul className="qa-observation-list">
            {evidence.observations.map((observation, index) => (
              <li key={`${observation.targetId}:${observation.scenarioId}:${index.toString()}`}>
                <span>
                  <Badge tone={qaObservationTones[observation.severity]}>
                    {t(`qa.observation.${observation.kind}`)}
                  </Badge>
                  {observation.blocking ? <Badge tone="danger">{t("qa.blocking")}</Badge> : null}
                </span>
                <p>{observation.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {defects.length > 0 ? (
        <div className="qa-panel__section">
          <strong>{t("qa.defects")}</strong>
          <ol className="qa-defect-list">
            {defects.map((defect) => (
              <li key={defect.id}>
                <div>
                  <strong>{defect.title}</strong>
                  <span className="qa-defect__badges">
                    <Badge tone={qaDefectTones[defect.severity]}>
                      {t(`review.severity.${defect.severity}`)}
                    </Badge>
                    <Badge tone={qaDefectStatusTones[defect.status]}>
                      {t(`qa.defectStatus.${defect.status}`)}
                    </Badge>
                  </span>
                </div>
                <p>{defect.description}</p>
                <span>
                  <strong>{t("qa.reproduction")}: </strong>
                  {defect.reproduction.join(" · ")}
                </span>
                {defect.status === "OPEN" ? (
                  <div className="qa-defect__actions">
                    <Button
                      onClick={() => {
                        waiverMutation.reset();
                        setWaiverReason("");
                        setSelectedDefect(defect);
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {t("qa.waive")}
                    </Button>
                  </div>
                ) : defect.resolutionReason ? (
                  <p className="qa-defect__resolution">{defect.resolutionReason}</p>
                ) : null}
                {defect.status === "RESOLVED" && defect.resolvedByQARunId ? (
                  <span className="qa-defect__provenance">
                    <strong>{t("qa.resolvedBy")}: </strong>
                    <code title={defect.resolvedByQARunId}>{defect.resolvedByQARunId}</code>
                  </span>
                ) : null}
                {selectedDefect?.id === defect.id ? (
                  <form className="qa-defect-waiver" onSubmit={submitWaiver}>
                    <Field htmlFor={`qa-defect-waiver-${defect.id}`} label={t("qa.waiverReason")}>
                      <Textarea
                        autoFocus
                        id={`qa-defect-waiver-${defect.id}`}
                        maxLength={4_000}
                        onChange={(event) => {
                          setWaiverReason(event.currentTarget.value);
                        }}
                        placeholder={t("qa.waiverReasonPlaceholder")}
                        rows={3}
                        value={waiverReason}
                      />
                    </Field>
                    {waiverMutation.error ? <LocalConnectionRecovery error={waiverMutation.error} /> : null}
                    <div>
                      <Button
                        disabled={waiverReason.trim().length === 0}
                        loading={waiverMutation.isPending}
                        size="sm"
                        type="submit"
                        variant="primary"
                      >
                        {t("qa.confirmWaive")}
                      </Button>
                      <Button
                        disabled={waiverMutation.isPending}
                        onClick={() => {
                          setSelectedDefect(null);
                          setWaiverReason("");
                        }}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        {t("action.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="qa-panel__section">
          <strong>{t("qa.attachments")}</strong>
          <ul className="qa-attachment-list">
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <span>{t(`qa.attachment.${attachment.kind}`)}</span>
                <a href={workItemQAAttachmentUrl(item.id, attachment.id)} rel="noreferrer" target="_blank">
                  {t("qa.openAttachment")}
                  <Icon name="external" size={13} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};

const AcceptancePanel = ({
  acceptancePackage,
  artifacts,
  item,
  run,
}: {
  acceptancePackage: AcceptancePackage;
  artifacts: readonly EvidenceArtifact[];
  item: WorkItem;
  run: PipelineRun;
}): React.JSX.Element => {
  const { t } = useI18n();
  const resolveMutation = useResolveAcceptance();
  const [lastAction, setLastAction] = useState<AcceptanceAction | null>(null);
  const resolve = (action: AcceptanceAction): void => {
    setLastAction(action);
    resolveMutation.mutate({ acceptancePackage, action, run, workItem: item });
  };

  return (
    <div className="acceptance-package">
      <div className="acceptance-package__heading">
        <div className="acceptance-package__title">
          <span>{t("acceptance.eyebrow")}</span>
          <h3>{t("acceptance.title")}</h3>
        </div>
        <div className="acceptance-package__heading-actions">
          <Status
            label={t(acceptanceStatusLabelKeys[acceptancePackage.status])}
            tone={acceptanceStatusTones[acceptancePackage.status]}
          />
          <a
            className="acceptance-package__export"
            download
            href={workItemAcceptanceExportUrl(item.id, acceptancePackage.id)}
          >
            <Icon name="external" size={13} />
            {t("acceptance.export")}
          </a>
        </div>
      </div>
      <p>{acceptancePackage.releaseNote}</p>

      <div className="acceptance-evidence" aria-label={t("acceptance.evidence")}>
        {artifacts.map((artifact) => (
          <article key={artifact.id}>
            <div>
              <Icon name="check" size={13} />
              <strong>
                {artifact.kind === "REVIEW_REPORT"
                  ? t("acceptance.reviewEvidence")
                  : t("acceptance.qaEvidence")}
              </strong>
            </div>
            <span>{artifact.summary}</span>
            <small>{t("acceptance.checks", { count: artifact.checks.length })}</small>
          </article>
        ))}
      </div>

      <div className="acceptance-matrix">
        <strong>{t("acceptance.matrix")}</strong>
        {acceptancePackage.criteria.length > 0 ? (
          <ol>
            {acceptancePackage.criteria.map((criterion, index) => {
              const bound = criterion.reviewCheck !== undefined && criterion.qaCheck !== undefined;
              return (
                <li key={`${index.toString()}:${criterion.criterion}`}>
                  <div>
                    <Icon name={bound ? "check" : "warning"} size={13} />
                    <strong>{criterion.criterion}</strong>
                  </div>
                  {!bound ? (
                    <span className="acceptance-matrix__legacy">{t("acceptance.legacyEvidence")}</span>
                  ) : null}
                  <dl>
                    <div>
                      <dt>{t("acceptance.implementation")}</dt>
                      <dd>{criterion.implementation}</dd>
                    </div>
                    {bound ? (
                      <>
                        <div>
                          <dt>{t("acceptance.reviewCheck")}</dt>
                          <dd>{criterion.reviewCheck}</dd>
                        </div>
                        <div>
                          <dt>{t("acceptance.qaCheck")}</dt>
                          <dd>{criterion.qaCheck}</dd>
                        </div>
                      </>
                    ) : null}
                    <div>
                      <dt>{t("acceptance.ownerVerification")}</dt>
                      <dd>{criterion.verification}</dd>
                    </div>
                    <div>
                      <dt>{t("acceptance.knownRisk")}</dt>
                      <dd>{criterion.knownRisk ?? t("acceptance.noKnownRisk")}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ol>
        ) : (
          <span>{t("acceptance.noCriteria")}</span>
        )}
      </div>

      {resolveMutation.error ? (
        <LocalConnectionRecovery
          error={resolveMutation.error}
          onRetry={() => {
            if (lastAction) resolve(lastAction);
          }}
          retrying={resolveMutation.isPending}
        />
      ) : null}
      {acceptancePackage.status === "PENDING" ? (
        <div className="acceptance-package__actions">
          <Button
            disabled={resolveMutation.isPending}
            loading={resolveMutation.isPending && lastAction === "ACCEPT"}
            onClick={() => {
              resolve("ACCEPT");
            }}
            variant="primary"
          >
            {t("acceptance.accept")}
          </Button>
          <Button
            disabled={resolveMutation.isPending}
            loading={resolveMutation.isPending && lastAction === "RETURN_TO_WORK"}
            onClick={() => {
              resolve("RETURN_TO_WORK");
            }}
          >
            {t("acceptance.return")}
          </Button>
          <Button
            disabled={resolveMutation.isPending}
            loading={resolveMutation.isPending && lastAction === "REJECT"}
            onClick={() => {
              resolve("REJECT");
            }}
          >
            {t("acceptance.reject")}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

// The skeleton is shared by the workflow section and by the whole-inspector loading state; only the
// outermost loading container announces itself, so the label - and with it the live region - is optional.
const WorkflowSkeleton = ({ label }: { label?: string }): React.JSX.Element => (
  <div
    aria-label={label}
    className="inspector-workflow-skeleton"
    role={label === undefined ? undefined : "status"}
  >
    <div className="inspector-workflow-skeleton__status">
      <Skeleton width="42%" />
      <Skeleton width="68px" />
    </div>
    <div className="inspector-workflow-skeleton__panel">
      <div>
        <Skeleton width="48%" />
        <Skeleton width="54px" />
      </div>
      <Skeleton className="inspector-workflow-skeleton__meter" width="100%" />
      <Skeleton width="36%" />
    </div>
    <div className="inspector-workflow-skeleton__steps">
      <Skeleton width="58%" />
      <Skeleton width="44%" />
    </div>
  </div>
);

// Spec D5's accepted price: splitting the attempt from its execution unit means a healthy long
// stage no longer looks like a series of failures, but only if the cockpit shows the nesting it
// introduced. `session.status === "RUNNING"` is checked first because a running session always
// carries a null endReason, which the switch below still has to type-check against.
const sessionStatusPresentation = (
  session: ProviderSession,
  t: Translator,
): { label: string; tone: StatusTone } => {
  if (session.status === "RUNNING") return { label: t("workflow.sessions.status.RUNNING"), tone: "running" };
  switch (session.endReason) {
    case "COMPLETED":
      return { label: t("workflow.sessions.status.COMPLETED"), tone: "complete" };
    case "HANDOFF":
      return { label: t("workflow.sessions.status.HANDOFF"), tone: "waiting" };
    case "CONTEXT_EXHAUSTED":
      return { label: t("workflow.sessions.status.CONTEXT_EXHAUSTED"), tone: "paused" };
    case "INTERRUPTED":
      return { label: t("workflow.sessions.status.INTERRUPTED"), tone: "paused" };
    case "CANCELLED":
      return { label: t("workflow.sessions.status.CANCELLED"), tone: "queued" };
    case null:
      return { label: t("workflow.stage.other"), tone: "queued" };
  }
};

// Spec §8: a checkpoint is provider output Loomrail feeds into the next session's context, and it
// mitigates a High-rated threat only if the owner can read what is actually being carried forward
// -- so every list renders here, not just a summary line, and an empty list is left out rather than
// shown as a hollow heading.
const checkpointGroups = (checkpoint: Checkpoint, t: Translator): readonly CheckpointGroup[] => [
  { label: t("workflow.checkpoints.completed"), items: checkpoint.completed },
  { label: t("workflow.checkpoints.remaining"), items: checkpoint.remaining },
  { label: t("workflow.checkpoints.deadEnds"), items: checkpoint.deadEnds },
  { label: t("workflow.checkpoints.openQuestions"), items: checkpoint.openQuestions },
];

/**
 * The sessions inside the current stage attempt (spec §D5), with the highest window occupancy each
 * session reached, whether a handoff was requested, and the full text of every checkpoint it
 * published.
 * Renders nothing while there is no attempt to nest sessions under, or once it has none yet -- a
 * brand-new attempt has not started its first session, and an empty "Sessions" heading would just
 * be noise.
 */
const AttemptSessionsPanel = ({ attempt }: { attempt: StageAttempt }): React.JSX.Element | null => {
  const { locale, t } = useI18n();
  const sessionsQuery = useStageAttemptSessions(attempt.id);
  const capabilitiesQuery = useProviderCapabilities();
  const sessions = sessionsQuery.data?.sessions ?? [];
  const checkpoints = sessionsQuery.data?.checkpoints ?? [];
  const usageReports = sessionsQuery.data?.usageReports ?? [];
  const peakContextWindowUsage = sessionsQuery.data?.peakContextWindowUsage ?? {};

  if (sessions.length === 0) return null;

  // The single most recently published checkpoint across the whole attempt -- the one that would
  // feed the next session's context right now -- opens by default; every earlier one stays
  // collapsed behind its own summary rather than crowding the panel.
  const mostRecentCheckpointId = checkpoints.reduce<{ id: string; createdAt: string } | null>(
    (latest, checkpoint) =>
      latest === null || checkpoint.createdAt > latest.createdAt
        ? { id: checkpoint.id, createdAt: checkpoint.createdAt }
        : latest,
    null,
  )?.id;

  const sessionViewModels: ProviderSessionViewModel[] = [...sessions]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((session) => {
      const presentation = sessionStatusPresentation(session, t);
      const usage = peakContextWindowUsage[session.id];
      const spend = usageReports.find((report) => report.providerSessionId === session.id);
      const occupancyPercent = usage ? Math.round((usage.usedTokens / usage.windowTokens) * 100) : undefined;
      const sessionCheckpoints: CheckpointViewModel[] = checkpoints
        .filter((checkpoint) => checkpoint.providerSessionId === session.id)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((checkpoint) => ({
          id: checkpoint.id,
          summary: checkpoint.summary,
          timeLabel: eventTime(checkpoint.createdAt, locale),
          defaultOpen: checkpoint.id === mostRecentCheckpointId,
          groups: checkpointGroups(checkpoint, t),
        }));

      return {
        id: session.id,
        ordinal: session.ordinal,
        ariaLabel: t("workflow.sessions.ordinal", { ordinal: session.ordinal }),
        statusLabel: presentation.label,
        tone: presentation.tone,
        checkpoints: sessionCheckpoints,
        // exactOptionalPropertyTypes: an optional field left undefined must be omitted, not set to
        // undefined, so each one is spread in only when it has a real value.
        ...(session.handoffRequestedAt !== null
          ? { handoffRequestedLabel: t("workflow.sessions.handoffRequested") }
          : {}),
        // Spec §4.3 and §5.2 make `usageQuality` the thing that separates a measured occupancy from
        // a guessed one; dropping it here rendered a measured 92% and an estimated 92% identically.
        //
        // Occupancy is saved on every report, not only on the one that crosses the threshold, so
        // the number no longer implies a handoff and the label must not claim one -- a session
        // still running at 40% would have read as having handed off. A session that did ask for a
        // handoff stopped reporting at that moment, so its peak really is the reading at handoff
        // and keeps saying so; for every other session the honest thing to name is the peak.
        // e2e/attempt-nesting.spec.ts renders both branches.
        ...(occupancyPercent === undefined || usage === undefined
          ? {}
          : {
              occupancyPercent,
              occupancyLabel: t(
                session.handoffRequestedAt === null
                  ? "workflow.sessions.occupancyPeak"
                  : "workflow.sessions.occupancyAtHandoff",
                { percent: occupancyPercent },
              ),
              occupancyQualityLabel: t(usageQualityLabelKeys[usage.quality]),
            }),
        ...(spend === undefined
          ? {}
          : {
              usageLabel: t("workflow.sessions.tokenUsage", {
                total: spend.totalTokens.toLocaleString(locale),
                input: spend.inputTokens.toLocaleString(locale),
                output: spend.outputTokens.toLocaleString(locale),
              }),
              usageQualityLabel: t(usageQualityLabelKeys[spend.quality]),
              ...(spend.costUsd === null
                ? {}
                : {
                    usageCostLabel: t("workflow.sessions.tokenCost", {
                      cost: spend.costUsd.toLocaleString(locale, {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 4,
                      }),
                    }),
                  }),
            }),
        ...(sessionCheckpoints.length === 0
          ? { emptyCheckpointsLabel: t("workflow.checkpoints.empty") }
          : {}),
      };
    });

  const attemptHeader: ProviderSessionTimelineAttempt = {
    heading: t("workflow.sessions.attemptHeading", { attempt: attempt.attempt }),
    statusLabel: stageAttemptStatusLabel(attempt, t),
    tone: stageAttemptStatusTones[attempt.status],
  };

  return (
    <ProviderSessionTimeline
      attempt={attemptHeader}
      {...(capabilitiesQuery.data?.checkpointOnRequest === false
        ? { note: t("workflow.sessions.noCheckpointOnRequest") }
        : {})}
      sessions={sessionViewModels}
      title={t("workflow.sessions.title")}
    />
  );
};

const workspaceStatusLabelKeys: Record<WorkItemWorkspaceStatus, TranslationKey> = {
  READY: "workspace.status.READY",
  ORPHANED: "workspace.status.ORPHANED",
  REMOVED: "workspace.status.REMOVED",
};

const workspaceStatusTones: Record<WorkItemWorkspaceStatus, StatusTone> = {
  READY: "ready",
  ORPHANED: "paused",
  REMOVED: "queued",
};

/**
 * How much of the base commit the card prints.
 *
 * Twelve hex characters, not forty and not seven. The owner's use for this value is pasting it into
 * `git show`, and git resolves any unambiguous prefix, so the question is only how long a prefix
 * stays unambiguous. Seven -- git's own `--oneline` default -- collides in large repositories;
 * twelve is what `core.abbrev=auto` grows towards well past a million objects. The full forty
 * characters would wrap to a second line in a 320px inspector column and buy nothing, since a
 * prefix and the full id resolve identically.
 *
 * The complete sha is still on the element's `title`, so nothing is hidden -- only unprinted.
 */
const baseCommitDisplayLength = 12;

/**
 * Where this work item's agent writes: the repository, the branch, the base commit it was cut from,
 * and the worktree path.
 *
 * Returns null rather than an empty panel when the item has no workspace. A prose-only stage and an
 * item before its first code stage both genuinely have none, and headings standing over blanks read
 * as a load that failed rather than as an absence -- so the section itself lives in here, not
 * around the call site.
 *
 * The paths are deliberately not in the `RunSummary` grid the overview above uses. That grid gives
 * a value roughly half the inspector's width and clips what does not fit, which for the one field
 * the owner is here to copy -- the worktree path -- would mean an ellipsis where an actionable
 * directory should be. They get full-width rows that wrap instead, so the whole path is on screen
 * and selectable in one drag.
 */
const WorkspacePanel = ({ item }: { item: WorkItem }): React.JSX.Element | null => {
  const { t } = useI18n();
  const { projects } = useWorkspace();
  // The published shape, not the stored one: the route deliberately does not send `leaseHolder`, and
  // the card has no use for it.
  const workspace: PublishedWorkItemWorkspace | null = useWorkItemWorkspace(item.id).data?.workspace ?? null;

  if (!workspace) return null;

  // The Project names the repository the branch actually lives in -- the worktree is a checkout of
  // it, not a repository of its own -- which is where an owner goes to delete the branch or merge
  // it. Read from the Project list the app already holds rather than added to the workspace
  // response, since the workspace row records no repository path of its own.
  const project = projects.find((candidate) => candidate.id === item.projectId) ?? null;

  return (
    <InspectorSection title={t("workspace.title")}>
      <div className="workspace-identity">
        <RunSummary
          properties={[
            {
              label: t("workspace.state"),
              value: (
                <Status
                  label={t(workspaceStatusLabelKeys[workspace.status])}
                  tone={workspaceStatusTones[workspace.status]}
                />
              ),
            },
            {
              label: t("workspace.baseCommit"),
              value:
                workspace.baseCommit === null ? (
                  t("workspace.baseCommit.none")
                ) : (
                  <code className="workspace-identity__sha" title={workspace.baseCommit}>
                    {workspace.baseCommit.slice(0, baseCommitDisplayLength)}
                  </code>
                ),
            },
          ]}
        />
        <dl className="workspace-identity__locations">
          {project ? (
            <div>
              <dt>{t("workspace.repository")}</dt>
              <dd>{project.repositoryPath}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t("workspace.branch")}</dt>
            <dd>{workspace.branch}</dd>
          </div>
          <div>
            <dt>{t("workspace.worktree")}</dt>
            <dd>{workspace.worktreePath}</dd>
          </div>
        </dl>
        {workspace.status === "READY" ? null : (
          // No action offered, because there is none: ORPHANED is terminal -- nothing in Loomrail
          // returns a workspace to READY (session-loop.ts, workspaceNotReadyRefusal) -- and a
          // button that cannot work is worse than the plain fact.
          <p className="workspace-identity__note" role="status">
            {t("workspace.notReady")}
          </p>
        )}
        <p className="inspector-copy">{t("workspace.uncommitted")}</p>
      </div>
    </InspectorSection>
  );
};

const modelTiers = ["FAST", "STANDARD", "DEEP"] as const;

const modelPolicyOptions = (
  selection: ProjectProviderSelectionResponse | undefined,
  t: Translator,
): readonly { description?: string; label: string; value: ModelTier }[] =>
  modelTiers.map((tier) => {
    if (selection === undefined) {
      return { label: t(`workflow.modelTier.${tier}`), value: tier };
    }
    const preference = selection.selection.preference;
    if (preference === "CODEX" || preference === "CLAUDE_CODE") {
      const provider = selection.providers.find(({ provider: id }) => id === preference);
      const model = provider?.models?.[tier];
      if (model !== undefined) {
        return {
          description: t("workflow.model.providerDescription", {
            provider: preference === "CODEX" ? "Codex" : "Claude Code",
            tier: t(`workflow.modelTier.${tier}`),
          }),
          label: model,
          value: tier,
        };
      }
    }
    if (preference === "AUTO") {
      const codex = selection.providers.find(({ provider }) => provider === "CODEX")?.models?.[tier];
      const claude = selection.providers.find(({ provider }) => provider === "CLAUDE_CODE")?.models?.[tier];
      if (codex !== undefined && claude !== undefined) {
        return {
          description: t("workflow.model.autoDescription", { claude, codex }),
          label: t("workflow.model.autoOption", { tier: t(`workflow.modelTier.${tier}`) }),
          value: tier,
        };
      }
    }
    return {
      description: preference === "MOCK" ? t("workflow.model.mockDescription") : t("workflow.model.loading"),
      label: t(`workflow.modelTier.${tier}`),
      value: tier,
    };
  });

const WorkflowPanel = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const { t } = useI18n();
  const workflowQuery = useWorkItemWorkflow(item.id);
  const providerSelectionQuery = useProjectProviderSelection(item.projectId);
  const startMutation = useStartMockPipeline();
  const controlMutation = usePipelineControl();
  const overrideMutation = useApproveBudgetOverride();
  const [lastAction, setLastAction] = useState<"pause" | "resume" | "cancel" | "override" | null>(null);
  const [budgetLimitInput, setBudgetLimitInput] = useState(String(suggestedPipelineBudget));
  const [agentRunLimitInput, setAgentRunLimitInput] = useState(String(suggestedAgentRunBudget));
  const [modelTierOverride, setModelTierOverride] = useState<ModelTier>("FAST");
  const modelOptions = modelPolicyOptions(providerSelectionQuery.data, t);
  const selectedModelDescription = modelOptions.find(({ value }) => value === modelTierOverride)?.description;
  const snapshot = workflowQuery.data;
  const budgetPolicy = snapshot?.budgetPolicies.at(-1) ?? null;
  const persistedPolicyValues = budgetPolicy === null ? null : workflowPolicyFormValues(budgetPolicy);
  const persistedBudgetLimitInput = persistedPolicyValues?.budgetLimitInput ?? null;
  const persistedAgentRunLimitInput = persistedPolicyValues?.agentRunLimitInput ?? null;
  const persistedModelTierOverride = persistedPolicyValues?.modelTierOverride ?? null;
  useEffect(() => {
    if (
      persistedBudgetLimitInput === null ||
      persistedAgentRunLimitInput === null ||
      persistedModelTierOverride === null
    ) {
      return;
    }
    setBudgetLimitInput(persistedBudgetLimitInput);
    setAgentRunLimitInput(persistedAgentRunLimitInput);
    setModelTierOverride(persistedModelTierOverride);
  }, [persistedAgentRunLimitInput, persistedBudgetLimitInput, persistedModelTierOverride]);
  const parsedBudgetLimit = Number(budgetLimitInput);
  const parsedAgentRunLimit = Number(agentRunLimitInput);
  const budgetLimitIsValid = Number.isSafeInteger(parsedBudgetLimit) && parsedBudgetLimit > 0;
  const agentRunLimitIsValid =
    Number.isSafeInteger(parsedAgentRunLimit) &&
    parsedAgentRunLimit > 0 &&
    parsedAgentRunLimit <= parsedBudgetLimit;
  const startWorkflow = (): void => {
    if (!budgetLimitIsValid || !agentRunLimitIsValid) return;
    startMutation.mutate({
      policy: {
        maxEstimatedTokens: parsedBudgetLimit,
        modelTierOverride,
        agentRunMaxEstimatedTokensOverride: parsedAgentRunLimit,
      },
      workItem: item,
    });
  };
  const openRequest =
    snapshot?.humanRequests.find(
      ({ id, status }) => status === "OPEN" && id !== snapshot.acceptancePackage?.humanRequestId,
    ) ?? null;

  if (workflowQuery.isPending) {
    return <WorkflowSkeleton label={t("workflow.loading")} />;
  }

  if (!snapshot?.run) {
    return (
      <div className="workflow-start">
        <p className="inspector-copy">
          {item.state === "READY" ? t("workflow.startDescription") : t("workflow.readyRequired")}
        </p>
        {startMutation.error ? (
          <LocalConnectionRecovery
            error={startMutation.error}
            onRetry={() => {
              startWorkflow();
            }}
            retrying={startMutation.isPending}
          />
        ) : null}
        <form
          className="workflow-policy-form"
          onSubmit={(event) => {
            event.preventDefault();
            startWorkflow();
          }}
        >
          <Field
            {...(budgetLimitIsValid ? {} : { error: t("workflow.budget.invalid") })}
            description={t("workflow.budget.description")}
            htmlFor="workflow-start-budget"
            label={t("workflow.budget.input")}
            required
          >
            <TextField
              id="workflow-start-budget"
              inputMode="numeric"
              invalid={!budgetLimitIsValid}
              min={1}
              onChange={(event) => {
                setBudgetLimitInput(event.currentTarget.value);
              }}
              required
              step={1}
              type="number"
              value={budgetLimitInput}
            />
          </Field>
          <Field
            {...(agentRunLimitIsValid ? {} : { error: t("workflow.agentRunBudget.invalid") })}
            description={t("workflow.agentRunBudget.description")}
            htmlFor="workflow-start-agent-run-budget"
            label={t("workflow.agentRunBudget.input")}
            required
          >
            <TextField
              id="workflow-start-agent-run-budget"
              inputMode="numeric"
              invalid={!agentRunLimitIsValid}
              min={1}
              onChange={(event) => {
                setAgentRunLimitInput(event.currentTarget.value);
              }}
              required
              step={1}
              type="number"
              value={agentRunLimitInput}
            />
          </Field>
          <Field
            description={selectedModelDescription ?? t("workflow.model.loading")}
            htmlFor="workflow-start-model-tier"
            label={t("workflow.model.input")}
          >
            <SelectControl
              ariaLabel={t("workflow.model.input")}
              id="workflow-start-model-tier"
              onValueChange={(value) => {
                setModelTierOverride(modelTierSchema.parse(value));
              }}
              options={modelOptions}
              value={modelTierOverride}
            />
          </Field>
          <Button
            disabled={item.state !== "READY" || !budgetLimitIsValid || !agentRunLimitIsValid}
            loading={startMutation.isPending}
            type="submit"
            variant="primary"
          >
            {t("workflow.start")}
          </Button>
        </form>
      </div>
    );
  }

  const run = snapshot.run;
  const currentAttempt =
    snapshot.stageAttempts.find((attempt) => attempt.id === run.currentStageAttemptId) ?? null;
  const correctionGateRequest =
    openRequest !== null &&
    currentAttempt?.stage === "QA" &&
    currentAttempt.status === "WAITING_HUMAN" &&
    currentAttempt.failureCode === "QA_CORRECTION_EXHAUSTED" &&
    currentAttempt.correctionRunId !== null
      ? {
          correctionRunId: currentAttempt.correctionRunId,
          request: openRequest,
          run,
        }
      : null;
  const used = snapshot.usageRecords.reduce((total, record) => total + record.amount, 0);
  const budgetPercent = budgetPolicy
    ? Math.min(100, Math.round((used / budgetPolicy.maxEstimatedTokens) * 100))
    : 0;
  const pipelineOverrideIsValid =
    budgetPolicy !== null &&
    budgetLimitIsValid &&
    parsedBudgetLimit >= budgetPolicy.maxEstimatedTokens &&
    parsedBudgetLimit > used;
  const agentRunOverrideRaisesPolicy =
    budgetPolicy !== null &&
    agentRunLimitIsValid &&
    (budgetPolicy.agentRunMaxEstimatedTokensOverride === undefined ||
      budgetPolicy.agentRunMaxEstimatedTokensOverride === null ||
      parsedAgentRunLimit > budgetPolicy.agentRunMaxEstimatedTokensOverride);
  const overrideLimitIsValid =
    pipelineOverrideIsValid &&
    (parsedBudgetLimit > budgetPolicy.maxEstimatedTokens || agentRunOverrideRaisesPolicy);
  const controlPending = controlMutation.isPending || overrideMutation.isPending;
  const runControl = (action: "pause" | "resume" | "cancel"): void => {
    controlMutation.reset();
    overrideMutation.reset();
    setLastAction(action);
    controlMutation.mutate({ action, run, workItem: item });
  };
  const approveOverride = (): void => {
    if (!overrideLimitIsValid) return;
    controlMutation.reset();
    overrideMutation.reset();
    setLastAction("override");
    overrideMutation.mutate({
      maxEstimatedTokens: parsedBudgetLimit,
      modelTierOverride,
      agentRunMaxEstimatedTokensOverride: parsedAgentRunLimit,
      run,
      workItem: item,
    });
  };

  return (
    <div className="workflow-panel">
      <div className="workflow-panel__status">
        <span>{t("workflow.mockName")}</span>
        <Status
          label={
            snapshot.run.status === "HARD_PAUSED"
              ? hardPauseLabel(currentAttempt?.failureCode ?? null, "workflow.status.HARD_PAUSED", t)
              : t(pipelineStatusLabelKeys[snapshot.run.status])
          }
          tone={pipelineStatusTones[snapshot.run.status]}
        />
      </div>
      {budgetPolicy ? (
        <div className="workflow-budget">
          <span className="workflow-budget__kind">{t("workflow.budget.kind")}</span>
          <div className="workflow-budget__heading">
            <span>{t("workflow.budget.title")}</span>
            <strong>
              {t("workflow.budget.usage", {
                used,
                limit: budgetPolicy.maxEstimatedTokens,
              })}
            </strong>
          </div>
          <progress
            aria-label={t("workflow.budget.title")}
            max={budgetPolicy.maxEstimatedTokens}
            value={Math.min(used, budgetPolicy.maxEstimatedTokens)}
          />
          <div className="workflow-budget__meta">
            <span>{t("workflow.budget.revision", { revision: budgetPolicy.revision })}</span>
            <span>{budgetPercent}%</span>
            <span>
              {t("workflow.modelTier.current", {
                tier:
                  budgetPolicy.modelTierOverride === undefined || budgetPolicy.modelTierOverride === null
                    ? t("workflow.modelTier.roleDefault")
                    : t(`workflow.modelTier.${budgetPolicy.modelTierOverride}`),
              })}
            </span>
            <span>
              {t("workflow.agentRunBudget.current", {
                limit:
                  budgetPolicy.agentRunMaxEstimatedTokensOverride ?? t("workflow.agentRunBudget.roleDefault"),
              })}
            </span>
          </div>
        </div>
      ) : null}
      <ol className="workflow-stage-list">
        {snapshot.stageAttempts.map((attempt) => (
          <li className={`is-${attempt.status.toLowerCase()}`} key={attempt.id}>
            <span aria-hidden="true" />
            <div>
              <strong>{t(stageLabelKeys[attempt.stage])}</strong>
              <small>{stageAttemptStatusLabel(attempt, t)}</small>
            </div>
          </li>
        ))}
      </ol>
      {currentAttempt ? <AttemptSessionsPanel attempt={currentAttempt} /> : null}
      <ReviewPanel item={item} />
      <BrowserQAPanel correctionGate={correctionGateRequest} item={item} />
      {snapshot.acceptancePackage ? (
        <AcceptancePanel
          acceptancePackage={snapshot.acceptancePackage}
          artifacts={snapshot.artifacts}
          item={item}
          run={run}
        />
      ) : snapshot.artifacts.length > 0 ? (
        <div className="workflow-artifact-summary">
          <strong>{t("acceptance.evidence")}</strong>
          <span>{t("acceptance.evidenceCount", { count: snapshot.artifacts.length })}</span>
        </div>
      ) : null}
      {openRequest && correctionGateRequest === null ? (
        <HumanRequestAnswerForm request={openRequest} />
      ) : null}
      {snapshot.recoveryReports.at(-1) ? (
        <div className="workflow-recovery" role="status">
          <strong>{t("workflow.recovery.title")}</strong>
          <span>{t("workflow.recovery.description")}</span>
        </div>
      ) : null}
      {controlMutation.error || overrideMutation.error ? (
        <LocalConnectionRecovery
          error={controlMutation.error ?? overrideMutation.error}
          onRetry={() => {
            if (lastAction === "override") approveOverride();
            else if (lastAction) runControl(lastAction);
          }}
          retrying={controlPending}
        />
      ) : null}
      {["RUNNING", "WAITING_HUMAN", "SOFT_PAUSED", "HARD_PAUSED", "INTERRUPTED"].includes(run.status) &&
      snapshot.acceptancePackage?.status !== "PENDING" ? (
        <div className="workflow-panel__actions">
          {run.status === "RUNNING" ? (
            <Button
              disabled={controlPending}
              loading={controlMutation.isPending && lastAction === "pause"}
              onClick={() => {
                runControl("pause");
              }}
            >
              {t("workflow.action.pause")}
            </Button>
          ) : null}
          {run.status === "SOFT_PAUSED" || run.status === "INTERRUPTED" ? (
            <Button
              disabled={controlPending}
              loading={controlMutation.isPending && lastAction === "resume"}
              onClick={() => {
                runControl("resume");
              }}
              variant="primary"
            >
              {t("workflow.action.resume")}
            </Button>
          ) : null}
          {run.status === "HARD_PAUSED" &&
          budgetPolicy !== null &&
          !isSessionPauseFailureCode(currentAttempt?.failureCode ?? null) ? (
            <form
              className="workflow-policy-form workflow-policy-form--override"
              onSubmit={(event) => {
                event.preventDefault();
                approveOverride();
              }}
            >
              <Field
                {...(pipelineOverrideIsValid ? {} : { error: t("workflow.budget.overrideInvalid") })}
                description={t("workflow.budget.overrideDescription", {
                  current: budgetPolicy.maxEstimatedTokens,
                  used,
                })}
                htmlFor="workflow-override-budget"
                label={t("workflow.budget.input")}
                required
              >
                <TextField
                  id="workflow-override-budget"
                  inputMode="numeric"
                  invalid={!pipelineOverrideIsValid}
                  min={Math.max(budgetPolicy.maxEstimatedTokens, used + 1)}
                  onChange={(event) => {
                    setBudgetLimitInput(event.currentTarget.value);
                  }}
                  required
                  step={1}
                  type="number"
                  value={budgetLimitInput}
                />
              </Field>
              <Field
                description={selectedModelDescription ?? t("workflow.model.loading")}
                htmlFor="workflow-override-model-tier"
                label={t("workflow.model.input")}
              >
                <SelectControl
                  ariaLabel={t("workflow.model.input")}
                  id="workflow-override-model-tier"
                  onValueChange={(value) => {
                    setModelTierOverride(modelTierSchema.parse(value));
                  }}
                  options={modelOptions}
                  value={modelTierOverride}
                />
              </Field>
              <Field
                {...(agentRunLimitIsValid &&
                (parsedBudgetLimit > budgetPolicy.maxEstimatedTokens || agentRunOverrideRaisesPolicy)
                  ? {}
                  : { error: t("workflow.agentRunBudget.overrideInvalid") })}
                description={t("workflow.agentRunBudget.overrideDescription")}
                htmlFor="workflow-override-agent-run-budget"
                label={t("workflow.agentRunBudget.input")}
                required
              >
                <TextField
                  id="workflow-override-agent-run-budget"
                  inputMode="numeric"
                  invalid={
                    !agentRunLimitIsValid ||
                    (parsedBudgetLimit <= budgetPolicy.maxEstimatedTokens && !agentRunOverrideRaisesPolicy)
                  }
                  min={1}
                  onChange={(event) => {
                    setAgentRunLimitInput(event.currentTarget.value);
                  }}
                  required
                  step={1}
                  type="number"
                  value={agentRunLimitInput}
                />
              </Field>
              <Button
                disabled={controlPending || !overrideLimitIsValid}
                loading={overrideMutation.isPending}
                type="submit"
                variant="primary"
              >
                {t("workflow.action.override")}
              </Button>
            </form>
          ) : null}
          <Button
            disabled={controlPending}
            loading={controlMutation.isPending && lastAction === "cancel"}
            onClick={() => {
              runControl("cancel");
            }}
            variant="secondary"
          >
            {t("workflow.action.cancel")}
          </Button>
        </div>
      ) : null}
      {snapshot.run.status === "SUCCEEDED" ? (
        <p className="workflow-panel__completed">{t("workflow.completed")}</p>
      ) : null}
    </div>
  );
};

const ActivitySkeleton = ({ label }: { label?: string }): React.JSX.Element => (
  <div
    aria-label={label}
    className="inspector-activity-skeleton"
    role={label === undefined ? undefined : "status"}
  >
    {["first", "second", "third"].map((row, index) => (
      <div className="inspector-activity-skeleton__row" key={row}>
        <Skeleton className="inspector-activity-skeleton__icon" />
        <span>
          <Skeleton width={index === 1 ? "52%" : "68%"} />
          <Skeleton width={index === 2 ? "64%" : "82%"} />
        </span>
        <Skeleton width="28px" />
      </div>
    ))}
  </div>
);

/**
 * An item's activity grows without bound, so it is read newest first, one page at a time, rather
 * than rendering the whole log. The count stays honest about that: it reads "30+" while more pages
 * remain instead of claiming the loaded rows are all there is.
 */
const TaskActivitySection = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const eventsQuery = useWorkItemEvents(item.projectId, item.id);
  const events = eventsQuery.data?.pages.flatMap((page) => page.events) ?? [];
  const loadMore = (): void => {
    void eventsQuery.fetchNextPage();
  };

  return (
    <InspectorSection
      action={
        eventsQuery.data ? (
          <span className="inspector-step-count">
            {eventsQuery.hasNextPage ? t("task.activityCountMore", { count: events.length }) : events.length}
          </span>
        ) : undefined
      }
      title={t("task.activity")}
    >
      {events.length > 0 ? (
        <ol aria-busy={eventsQuery.isFetchingNextPage} className="inspector-activity">
          {events.map((event) => (
            <li key={event.id}>
              <TimelineEvent {...eventPresentation(event, t)} time={eventTime(event.occurredAt, locale)} />
            </li>
          ))}
        </ol>
      ) : null}
      {eventsQuery.hasNextPage ? (
        <Button
          className="inspector-activity__more"
          disabled={eventsQuery.isFetchingNextPage}
          loading={eventsQuery.isFetchingNextPage}
          onClick={loadMore}
          size="sm"
        >
          {t("task.loadMoreActivity")}
        </Button>
      ) : null}
      {eventsQuery.isPending ? <ActivitySkeleton label={t("task.loadingActivity")} /> : null}
      {eventsQuery.data && events.length === 0 ? (
        <p className="inspector-copy">{t("task.noActivity")}</p>
      ) : null}
    </InspectorSection>
  );
};

/**
 * While the board loads there is nothing to select yet, so the inspector must not claim the reader
 * made no selection. It mirrors the real panel - header, overview grid, workflow and activity - so
 * the layout holds still once the first task lands.
 */
const TaskInspectorSkeleton = (): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <aside
      aria-busy="true"
      aria-label={t("loading.inspector.title")}
      className="task-inspector"
      role="status"
    >
      <div className="task-inspector__header">
        <div className="task-inspector__identity">
          <Skeleton width="68px" />
          <div className="inspector-skeleton__actions">
            <Skeleton className="inspector-skeleton__control" width="28px" />
            <Skeleton className="inspector-skeleton__control" width="112px" />
          </div>
        </div>
        <Skeleton className="inspector-skeleton__title" width="72%" />
      </div>

      <section className="lr-inspector-section">
        <header>
          <Skeleton width="64px" />
        </header>
        <div className="lr-inspector-section__body">
          <div className="inspector-skeleton__summary">
            {["state", "stage", "type", "priority", "risk"].map((property, index) => (
              <div key={property}>
                <Skeleton width="48%" />
                <Skeleton width={index % 2 === 0 ? "74%" : "56%"} />
              </div>
            ))}
          </div>
          <div className="inspector-skeleton__copy">
            <Skeleton width="100%" />
            <Skeleton width="84%" />
          </div>
        </div>
      </section>

      <section className="lr-inspector-section">
        <header>
          <Skeleton width="76px" />
          <Skeleton width="20px" />
        </header>
        <div className="lr-inspector-section__body">
          <WorkflowSkeleton />
        </div>
      </section>

      <section className="lr-inspector-section">
        <header>
          <Skeleton width="120px" />
          <Skeleton width="16px" />
        </header>
        <div className="lr-inspector-section__body">
          <ActivitySkeleton />
        </div>
      </section>
    </aside>
  );
};

const TaskInspector = ({ item }: { item: WorkItem | null }): React.JSX.Element => {
  const { t } = useI18n();
  const moveMutation = useMoveWorkItem();
  const workflowQuery = useWorkItemWorkflow(item?.id);
  const [lastTarget, setLastTarget] = useState<WorkItemState | null>(null);

  if (!item) {
    return (
      <aside className="task-inspector is-empty" aria-label={t("empty.noSelection.title")}>
        <FeedbackState
          className="inspector-empty-feedback"
          description={t("empty.noSelection.description")}
          title={t("empty.noSelection.title")}
        />
      </aside>
    );
  }

  const workflowActive = ["RUNNING", "WAITING_HUMAN", "SOFT_PAUSED", "HARD_PAUSED", "INTERRUPTED"].includes(
    workflowQuery.data?.run?.status ?? "",
  );
  const targets = workflowActive ? [] : transitionTargets[item.state];
  const move = (targetState: WorkItemState): void => {
    setLastTarget(targetState);
    moveMutation.mutate({ targetState, workItem: item });
  };
  const { primary: primaryTarget, secondary: secondaryTarget } = moveShortcutsFor(item.state, workflowActive);

  return (
    <aside className="task-inspector" aria-label={item.title}>
      <header className="task-inspector__header">
        <div className="task-inspector__identity">
          <span className="task-inspector__id">{displayWorkItemId(item.id)}</span>
          <div className="task-inspector__actions">
            <TaskEditDialog key={`${item.id}-${item.version.toString()}`} item={item} />
            <ActionMenu
              align="end"
              groups={[
                targets.map((targetState) => ({
                  danger: targetState === "CANCELLED",
                  label: t("task.moveTo", { state: stateLabel(targetState, t) }),
                  onSelect: () => {
                    move(targetState);
                  },
                })),
              ]}
              trigger={
                <Button disabled={targets.length === 0} shape="pill" trailingIcon="chevronDown">
                  {t("task.move")}
                </Button>
              }
            />
          </div>
        </div>
        <h2>{item.title}</h2>
      </header>

      <InspectorSection title={t("task.overview")}>
        <RunSummary
          properties={[
            {
              label: t("task.state"),
              value: <Status label={stateLabel(item.state, t)} tone={stateTones[item.state]} />,
            },
            {
              label: t("task.stage"),
              value: item.currentStage ? t(stageLabelKeys[item.currentStage]) : "—",
            },
            { label: t("task.type"), value: t(typeLabelKeys[item.type]) },
            { label: t("task.priority"), value: t(priorityLabelKeys[item.priority]) },
            { label: t("task.risk"), value: t(riskLabelKeys[item.risk]) },
          ]}
        />
        <p className="inspector-copy">{item.description || t("task.noBrief")}</p>
      </InspectorSection>

      <InspectorSection
        action={
          workflowQuery.data?.run ? (
            <span className="inspector-step-count">
              {workflowQuery.data.stageAttempts.length.toString().padStart(2, "0")}
            </span>
          ) : undefined
        }
        title={t("workflow.title")}
      >
        <ProjectProviderAllowanceStrip projectId={item.projectId} surface="task-cockpit" />
        <WorkflowPanel item={item} />
      </InspectorSection>

      <WorkspacePanel item={item} />

      <ProjectVerificationPanel key={item.id} item={item} />

      {/* Keyed by work item, unlike its siblings, because this one holds state: which file the
          owner expanded. Without the key React would reconcile the same component across a switch
          to a different task and carry that path over, reopening a same-named file in a card the
          owner never asked it about. */}
      <ChangesSection key={item.id} workItemId={item.id} />

      <InspectorSection title={t("task.acceptanceCriteria")}>
        {item.acceptanceCriteria.length > 0 ? (
          <div className="inspector-checklist">
            {item.acceptanceCriteria.map((criterion) => (
              <Checkbox disabled key={criterion} label={criterion} />
            ))}
          </div>
        ) : (
          <p className="inspector-copy">{t("task.noAcceptanceCriteria")}</p>
        )}
      </InspectorSection>

      <TaskActivitySection item={item} />

      {moveMutation.error ? (
        <div className="task-inspector__error">
          <LocalConnectionRecovery
            error={moveMutation.error}
            onRetry={() => {
              if (lastTarget) move(lastTarget);
            }}
            retrying={moveMutation.isPending}
          />
        </div>
      ) : null}

      {primaryTarget !== null || secondaryTarget !== null ? (
        <footer className="task-inspector__footer">
          {secondaryTarget ? (
            <Button
              aria-label={t("task.moveTo", { state: stateLabel(secondaryTarget, t) })}
              loading={moveMutation.isPending}
              onClick={() => {
                move(secondaryTarget);
              }}
              variant="secondary"
            >
              {t("task.moveToShort", { state: stateLabel(secondaryTarget, t) })}
            </Button>
          ) : null}
          {primaryTarget ? (
            <Button
              aria-label={t("task.moveTo", { state: stateLabel(primaryTarget, t) })}
              loading={moveMutation.isPending}
              onClick={() => {
                move(primaryTarget);
              }}
              variant="primary"
            >
              {t("task.moveToShort", { state: stateLabel(primaryTarget, t) })}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
};

export const WorkbenchPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const navigate = useNavigate({ from: "/" });
  const search = useSearch({ from: "/" });
  const {
    connectionPending,
    error,
    projects,
    projectsPending,
    retryConnection,
    selectedProject,
    selectProject,
  } = useWorkspace();
  const workItemsQuery = useProjectWorkItems(selectedProject?.id);
  const humanRequestsQuery = useProjectHumanRequests(selectedProject?.id);
  const initializeMutation = useInitializeFixtureWorkspace();
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  useEffect(() => {
    if (
      search.project &&
      search.project !== selectedProject?.id &&
      projects.some(({ id }) => id === search.project)
    ) {
      selectProject(search.project);
    }
  }, [projects, search.project, selectProject, selectedProject?.id]);
  const filters = search.filters?.split(",") ?? [];
  const summaryFilter = search.summary ?? null;
  const setFilters = (value: readonly string[]): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({
        ...current,
        filters: value.length > 0 ? value.join(",") : undefined,
      }),
    });
  };
  const setSummaryFilter = (value: SummaryFilter | null): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({
        ...current,
        summary: value ?? undefined,
      }),
    });
  };
  const view: BoardView = {
    direction: search.dir ?? defaultBoardView.direction,
    ordering: search.order ?? defaultBoardView.ordering,
    showEmptyColumns: search.hideEmpty !== true,
  };
  const setView = (value: BoardView): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({
        ...current,
        dir: value.direction === defaultBoardView.direction ? undefined : value.direction,
        order: value.ordering === defaultBoardView.ordering ? undefined : value.ordering,
        hideEmpty: value.showEmptyColumns ? undefined : true,
      }),
    });
  };
  const scope: BoardScope = search.scope ?? "active";
  const setScope = (value: BoardScope): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({
        ...current,
        scope: value === "active" ? undefined : value,
        // Status filters name columns that a different scope may not show.
        filters: undefined,
      }),
    });
  };
  const clearFilters = (): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({
        ...current,
        filters: undefined,
        summary: undefined,
      }),
    });
  };
  const boardPending = projectsPending || (selectedProject !== null && workItemsQuery.isPending);
  const workItems = workItemsQuery.data?.workItems ?? [];
  const columns = columnsFor(scope);
  const scopedItems = workItems.filter((item) => scopeShows(scope, item.state));
  const blockingRequests = humanRequestsQuery.data?.humanRequests.filter(({ blocking }) => blocking) ?? [];
  const blockingWorkItemIds = new Set(blockingRequests.map(({ workItemId }) => workItemId));
  const summaryFilteredItems = scopedItems.filter((item) => {
    if (summaryFilter === "needsYou") return blockingWorkItemIds.has(item.id);
    return true;
  });
  const visibleItems = orderWorkItems(
    summaryFilteredItems.filter((item) => matchesFilters(item, filters)),
    view,
  );
  const selectWorkItem = (workItemId: string): void => {
    setSelectedWorkItemId(workItemId);
    if (!search.project && !search.task) return;
    void navigate({
      replace: true,
      resetScroll: false,
      search: (current) => ({ ...current, project: undefined, task: undefined }),
    });
  };
  const selectedItem =
    (search.task ? workItems.find((item) => item.id === search.task) : undefined) ??
    visibleItems.find((item) => item.id === selectedWorkItemId) ??
    visibleItems.at(0) ??
    null;
  const filterOptions = filterOptionsFor(scopedItems, columns, t);

  return (
    <div className="workbench">
      <section
        aria-label={t("work.boardLabel")}
        className="workbench-board"
        aria-labelledby="current-work-title"
      >
        <h1 className="lr-visually-hidden" id="current-work-title">
          {t("work.current")}
        </h1>
        <BoardToolbar
          filters={filters}
          onClearFilters={clearFilters}
          onFiltersChange={setFilters}
          onScopeChange={setScope}
          onSummaryFilterChange={setSummaryFilter}
          onViewChange={setView}
          options={filterOptions}
          scope={scope}
          summaryFilter={summaryFilter}
          view={view}
        />
        {selectedProject ? (
          <ProjectProviderAllowanceStrip projectId={selectedProject.id} surface="command-center" />
        ) : null}
        {blockingRequests[0] ? (
          <button
            className="attention-banner"
            onClick={() => {
              clearFilters();
              const workItemId = blockingRequests[0]?.workItemId;
              if (workItemId) selectWorkItem(workItemId);
            }}
            type="button"
          >
            <span className="attention-banner__icon">
              <Icon name="question" size={14} />
            </span>
            <span>
              <strong>{t("attention.title")}</strong>
              <small>{blockingRequests[0].title}</small>
            </span>
            <span className="attention-banner__count">
              {t(blockingRequests.length === 1 ? "attention.count" : "attention.countMany", {
                count: blockingRequests.length,
              })}
            </span>
            <Icon name="chevronRight" size={14} />
          </button>
        ) : null}

        {!selectedProject && !projectsPending && !error ? (
          <div className="workbench-state">
            <FeedbackState
              action={
                <Button
                  loading={initializeMutation.isPending}
                  onClick={() => {
                    initializeMutation.mutate();
                  }}
                  variant="primary"
                >
                  {t("empty.noProjects.action")}
                </Button>
              }
              description={t("empty.noProjects.description")}
              title={t("empty.noProjects.title")}
            />
            {initializeMutation.error instanceof Error ? (
              <p className="workbench-state__error" role="alert">
                {initializeMutation.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {boardPending ? (
          <div
            aria-busy="true"
            aria-label={t("loading.board.title")}
            className="board-skeleton"
            role="status"
          >
            {columns.map((column) => (
              <div className="board-skeleton__column" key={column.labelKey}>
                <header>
                  <Skeleton width="72px" />
                  <Skeleton width="16px" />
                </header>
                {[0, 1].map((card) => (
                  <div className="board-skeleton__card" key={card}>
                    <Skeleton width="54px" />
                    <Skeleton width={card === 0 ? "88%" : "64%"} />
                    <Skeleton width="46%" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        {error || workItemsQuery.error ? (
          <div className="workbench-state">
            <LocalConnectionRecovery
              error={workItemsQuery.error ?? error ?? new Error(t("error.unknown"))}
              onRetry={() => {
                if (workItemsQuery.error) {
                  void workItemsQuery.refetch();
                } else {
                  retryConnection();
                }
              }}
              retrying={connectionPending || workItemsQuery.isFetching}
            />
          </div>
        ) : null}

        {selectedProject && workItemsQuery.data ? (
          <>
            <div className="kanban-board-scroll">
              <div className="kanban-board">
                {columns.map((column) => {
                  const columnItems = visibleItems.filter((item) => item.state === column.state);
                  if (columnItems.length === 0 && !view.showEmptyColumns) return null;
                  return (
                    <KanbanColumn
                      count={columnItems.length}
                      key={column.labelKey}
                      label={t(column.labelKey)}
                      tone={column.tone}
                    >
                      {columnItems.map((item) => (
                        <WorkItemButton
                          item={item}
                          key={item.id}
                          onSelect={selectWorkItem}
                          selected={selectedItem?.id === item.id}
                        />
                      ))}
                    </KanbanColumn>
                  );
                })}
              </div>
            </div>
            {scopedItems.length === 0 ? (
              <div className="board-filter-empty" role="status">
                <span>
                  <Icon name="inbox" size={18} />
                </span>
                <strong>{t(`empty.${scope}.title`)}</strong>
                <p>{t(`empty.${scope}.description`)}</p>
              </div>
            ) : null}
            {(filters.length > 0 || summaryFilter !== null) && visibleItems.length === 0 ? (
              <div className="board-filter-empty" role="status">
                <span>
                  <Icon name="filter" size={18} />
                </span>
                <strong>{t("empty.filters.title")}</strong>
                <p>{t("empty.filters.description")}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <PanelResizer edge="end" panel="inspector" />
      {boardPending ? (
        <TaskInspectorSkeleton />
      ) : (
        <TaskInspector item={selectedItem} key={selectedItem?.id ?? "empty"} />
      )}
    </div>
  );
};
