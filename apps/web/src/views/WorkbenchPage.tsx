import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  prioritySchema,
  riskSchema,
  type AcceptanceAction,
  type AcceptancePackage,
  type DomainEvent,
  type EvidenceArtifact,
  type HumanRequest,
  type PipelineRun,
  type StageAttempt,
  type WorkItem,
  type WorkItemChangedField,
  type WorkItemState,
} from "@loomrail/contracts";
import {
  ActionMenu,
  AppliedFilterBar,
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
  RadioGroup,
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
  type FilterMessages,
  type FilterNode,
  type StatusTone,
  type TimelineEventProps,
} from "@loomrail/ui";

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
import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import type { SummaryFilter } from "../router";
import { moveShortcutsFor, transitionTargets } from "../taskMoves";
import {
  useInitializeFixtureWorkspace,
  useApproveBudgetOverride,
  useAnswerHumanRequest,
  useMoveWorkItem,
  usePipelineControl,
  useProjectHumanRequests,
  useProjectWorkItems,
  useResolveAcceptance,
  useStartMockPipeline,
  useUpdateWorkItem,
  useWorkspace,
  useWorkItemEvents,
  useWorkItemWorkflow,
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

const stageAttemptStatusLabel = (attempt: StageAttempt, t: Translator): string => {
  if (attempt.status === "QUEUED") return t("workflow.stage.QUEUED");
  if (attempt.status === "RUNNING") return t("workflow.stage.RUNNING");
  if (attempt.status === "WAITING_HUMAN") return t("workflow.stage.WAITING_HUMAN");
  if (attempt.status === "SOFT_PAUSED") return t("workflow.stage.SOFT_PAUSED");
  if (attempt.status === "HARD_PAUSED") return t("workflow.stage.HARD_PAUSED");
  if (attempt.status === "INTERRUPTED") return t("workflow.stage.INTERRUPTED");
  if (attempt.status === "CANCELLED") return t("workflow.stage.CANCELLED");
  if (attempt.status === "SUCCEEDED") return t("workflow.stage.SUCCEEDED");
  return t("workflow.stage.other");
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

const HumanRequestPanel = ({ request }: { request: HumanRequest }): React.JSX.Element => {
  const { t } = useI18n();
  const answerMutation = useAnswerHumanRequest();
  const [selection, setSelection] = useState("");
  const [otherText, setOtherText] = useState("");
  const otherSelected = selection === "__other__";
  const canSubmit = otherSelected ? otherText.trim().length > 0 : selection.length > 0;

  const submit = (): void => {
    if (!canSubmit) return;
    answerMutation.mutate({
      request,
      answer: otherSelected
        ? { type: "OTHER", text: otherText.trim() }
        : { type: "OPTION", optionIds: [selection] },
    });
  };

  return (
    <div className="human-request-card">
      <div className="human-request-card__eyebrow">
        <Icon name="question" size={13} />
        <span>{t("humanRequest.blocking")}</span>
      </div>
      <h3>{request.title}</h3>
      <p>{request.context}</p>
      {request.recommendation ? (
        <div className="human-request-card__recommendation">
          <strong>{t("humanRequest.recommendation")}</strong>
          <span>{request.recommendation}</span>
        </div>
      ) : null}
      <RadioGroup
        aria-label={request.title}
        onValueChange={setSelection}
        options={[
          ...request.options.map((option) => ({
            value: option.id,
            label: option.recommended ? `${option.label} · ${t("humanRequest.recommended")}` : option.label,
            description: option.consequence,
          })),
          ...(request.allowOther ? [{ value: "__other__", label: t("humanRequest.other") }] : []),
        ]}
        value={selection}
      />
      {otherSelected ? (
        <TextField
          aria-label={t("humanRequest.other")}
          autoFocus
          maxLength={2_000}
          onChange={(event) => {
            setOtherText(event.currentTarget.value);
          }}
          placeholder={t("humanRequest.otherPlaceholder")}
          value={otherText}
        />
      ) : null}
      {!canSubmit && selection ? (
        <span className="human-request-card__hint">{t("humanRequest.chooseAnswer")}</span>
      ) : null}
      {answerMutation.error ? (
        <LocalConnectionRecovery
          error={answerMutation.error}
          onRetry={submit}
          retrying={answerMutation.isPending}
        />
      ) : null}
      <Button disabled={!canSubmit} loading={answerMutation.isPending} onClick={submit} variant="primary">
        {t("humanRequest.answerResume")}
      </Button>
    </div>
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
        <div>
          <span>{t("acceptance.eyebrow")}</span>
          <h3>{t("acceptance.title")}</h3>
        </div>
        <Status
          label={t(acceptanceStatusLabelKeys[acceptancePackage.status])}
          tone={acceptanceStatusTones[acceptancePackage.status]}
        />
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
            {acceptancePackage.criteria.map((criterion) => (
              <li key={criterion.criterion}>
                <div>
                  <Icon name="check" size={13} />
                  <strong>{criterion.criterion}</strong>
                </div>
                <span>{criterion.verification}</span>
              </li>
            ))}
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

const WorkflowPanel = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const { t } = useI18n();
  const workflowQuery = useWorkItemWorkflow(item.id);
  const startMutation = useStartMockPipeline();
  const controlMutation = usePipelineControl();
  const overrideMutation = useApproveBudgetOverride();
  const [lastAction, setLastAction] = useState<"pause" | "resume" | "cancel" | "override" | null>(null);
  const snapshot = workflowQuery.data;
  const openRequest =
    snapshot?.humanRequests.find(
      ({ id, status }) => status === "OPEN" && id !== snapshot.acceptancePackage?.humanRequestId,
    ) ?? null;

  if (workflowQuery.isPending) {
    return (
      <div aria-label={t("workflow.loading")} className="inspector-workflow-skeleton" role="status">
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
              startMutation.mutate(item);
            }}
            retrying={startMutation.isPending}
          />
        ) : null}
        <Button
          disabled={item.state !== "READY"}
          loading={startMutation.isPending}
          onClick={() => {
            startMutation.mutate(item);
          }}
          variant="primary"
        >
          {t("workflow.start")}
        </Button>
      </div>
    );
  }

  const run = snapshot.run;
  const budgetPolicy = snapshot.budgetPolicies.at(-1) ?? null;
  const used = snapshot.usageRecords.reduce((total, record) => total + record.amount, 0);
  const budgetPercent = budgetPolicy
    ? Math.min(100, Math.round((used / budgetPolicy.maxEstimatedTokens) * 100))
    : 0;
  const overrideLimit = budgetPolicy ? Math.max(budgetPolicy.maxEstimatedTokens * 2, used + 100) : used + 100;
  const controlPending = controlMutation.isPending || overrideMutation.isPending;
  const runControl = (action: "pause" | "resume" | "cancel"): void => {
    controlMutation.reset();
    overrideMutation.reset();
    setLastAction(action);
    controlMutation.mutate({ action, run, workItem: item });
  };
  const approveOverride = (): void => {
    controlMutation.reset();
    overrideMutation.reset();
    setLastAction("override");
    overrideMutation.mutate({ maxEstimatedTokens: overrideLimit, run, workItem: item });
  };

  return (
    <div className="workflow-panel">
      <div className="workflow-panel__status">
        <span>{t("workflow.mockName")}</span>
        <Status
          label={t(pipelineStatusLabelKeys[snapshot.run.status])}
          tone={pipelineStatusTones[snapshot.run.status]}
        />
      </div>
      {budgetPolicy ? (
        <div className="workflow-budget">
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
      {openRequest ? <HumanRequestPanel request={openRequest} /> : null}
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
          {run.status === "HARD_PAUSED" ? (
            <Button
              disabled={controlPending}
              loading={overrideMutation.isPending}
              onClick={approveOverride}
              variant="primary"
            >
              {t("workflow.action.override", { limit: overrideLimit })}
            </Button>
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
      {eventsQuery.isPending ? (
        <div aria-label={t("task.loadingActivity")} className="inspector-activity-skeleton" role="status">
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
      ) : null}
      {eventsQuery.data && events.length === 0 ? (
        <p className="inspector-copy">{t("task.noActivity")}</p>
      ) : null}
    </InspectorSection>
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
        <div>
          <span>{displayWorkItemId(item.id)}</span>
          <h2>{item.title}</h2>
        </div>
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
      </header>

      <InspectorSection title={t("task.overview")}>
        <RunSummary
          properties={[
            {
              label: t("task.state"),
              value: <Status label={stateLabel(item.state, t)} tone={stateTones[item.state]} />,
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
        <WorkflowPanel item={item} />
      </InspectorSection>

      <InspectorSection
        action={
          <span className="inspector-step-count">
            {item.currentStage ? t(stageLabelKeys[item.currentStage]) : "—"}
          </span>
        }
        title={t("task.acceptanceCriteria")}
      >
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
  const { connectionPending, error, projectsPending, retryConnection, selectedProject } = useWorkspace();
  const workItemsQuery = useProjectWorkItems(selectedProject?.id);
  const humanRequestsQuery = useProjectHumanRequests(selectedProject?.id);
  const initializeMutation = useInitializeFixtureWorkspace();
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
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
  const selectedItem =
    visibleItems.find((item) => item.id === selectedWorkItemId) ?? visibleItems.at(0) ?? null;
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
        {blockingRequests[0] ? (
          <button
            className="attention-banner"
            onClick={() => {
              clearFilters();
              setSelectedWorkItemId(blockingRequests[0]?.workItemId ?? null);
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

        {projectsPending || (selectedProject && workItemsQuery.isPending) ? (
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
                          onSelect={setSelectedWorkItemId}
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
      <TaskInspector item={selectedItem} key={selectedItem?.id ?? "empty"} />
    </div>
  );
};
