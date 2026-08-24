import { useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  prioritySchema,
  riskSchema,
  type DomainEvent,
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
  PropertyChip,
  RadioGroup,
  RunSummary,
  SegmentedControl,
  SelectControl,
  Status,
  Switch,
  TaskCard,
  Textarea,
  TextField,
  TimelineEvent,
  type BadgeTone,
  type FilterMessages,
  type FilterNode,
  type StatusTone,
  type TimelineEventProps,
} from "@loomrail/ui";

import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import {
  useInitializeFixtureWorkspace,
  useApproveBudgetOverride,
  useAnswerHumanRequest,
  useMoveWorkItem,
  usePipelineControl,
  useProjectHumanRequests,
  useProjectWorkItems,
  useStartMockPipeline,
  useUpdateWorkItem,
  useWorkspace,
  useWorkItemEvents,
  useWorkItemWorkflow,
} from "../workspace";

const viewGroupingOptions = (t: Translator) =>
  [
    { label: t("view.noGrouping"), value: "none" },
    { label: t("property.status"), value: "status" },
    { label: t("view.assignee"), value: "assignee" },
    { label: t("view.agent"), value: "agent" },
    { label: t("property.project"), value: "project" },
    { label: t("property.priority"), value: "priority" },
    { label: t("view.label"), value: "label" },
  ] as const;

const viewOrderingOptions = (t: Translator) =>
  [
    { label: t("view.manual"), value: "manual" },
    { label: t("view.title"), value: "title" },
    { label: t("property.status"), value: "status" },
    { label: t("property.priority"), value: "priority" },
    { label: t("view.assignee"), value: "assignee" },
    { label: t("view.agent"), value: "agent" },
    { label: t("view.estimate"), value: "estimate" },
    { label: t("view.updated"), value: "updated" },
    { label: t("view.created"), value: "created" },
    { label: t("view.dueDate"), value: "due-date" },
    { label: t("view.linkCount"), value: "link-count" },
    { label: t("view.timeInStatus"), value: "time-in-status" },
  ] as const;

const ViewSettings = (): React.JSX.Element => {
  const { t } = useI18n();
  const [view, setView] = useState<"board" | "list">("list");
  return (
    <div className="view-settings">
      <SegmentedControl
        ariaLabel={t("view.layout")}
        onValueChange={setView}
        options={[
          { icon: "list", label: t("view.list"), value: "list" },
          { icon: "board", label: t("view.board"), value: "board" },
        ]}
        value={view}
      />
      <div className="view-settings__controls">
        <div className="view-settings__row">
          <span>{t("view.grouping")}</span>
          <SelectControl
            ariaLabel={t("view.groupBy")}
            defaultValue="status"
            options={viewGroupingOptions(t)}
            size="sm"
            variant="compact"
          />
        </div>
        <div className="view-settings__row">
          <span>{t("view.subGrouping")}</span>
          <SelectControl
            ariaLabel={t("view.subGroupBy")}
            defaultValue="none"
            options={viewGroupingOptions(t)}
            size="sm"
            variant="compact"
          />
        </div>
        <div className="view-settings__row">
          <span>{t("view.ordering")}</span>
          <div className="view-settings__ordering">
            <IconButton
              className="view-settings__direction"
              label={t("view.direction")}
              name="sortAscending"
              size="sm"
            />
            <SelectControl
              ariaLabel={t("view.orderBy")}
              defaultValue="priority"
              options={viewOrderingOptions(t)}
              size="sm"
              variant="compact"
            />
          </div>
        </div>
        <Switch label={t("view.completedRecency")} />
      </div>
      <div className="view-settings__section view-settings__section--single">
        <Switch defaultChecked label={t("view.showSubIssues")} />
      </div>
      <div className="view-settings__section">
        <span className="view-settings__section-title">
          {view === "list" ? t("view.listOptions") : t("view.boardOptions")}
        </span>
        {view === "list" ? <Switch label={t("view.nestedSubIssues")} /> : null}
        <Switch label={t("view.showEmptyGroups")} />
      </div>
      <div className="view-settings__properties">
        <span>{t("view.displayProperties")}</span>
        <div>
          <PropertyChip active label={t("property.id")} />
          <PropertyChip active label={t("property.status")} />
          <PropertyChip active label={t("property.priority")} />
          <PropertyChip active label={t("property.project")} />
          <PropertyChip label={t("property.dueDate")} />
          <PropertyChip label={t("property.labels")} />
          <PropertyChip active label={t("property.created")} />
          <PropertyChip label={t("property.updated")} />
        </div>
      </div>
    </div>
  );
};

type BoardToolbarProps = {
  filters: readonly string[];
  onFiltersChange: (value: readonly string[]) => void;
  options: readonly FilterNode[];
};

const BoardToolbar = ({ filters, onFiltersChange, options }: BoardToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  const hasActiveFilters = filters.length > 0;
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
    <div className={cn("board-toolbar-stack", hasActiveFilters && "has-active-filters")}>
      <div className="board-toolbar">
        <div className="board-view-tabs">
          <Button aria-pressed="true" shape="pill" variant="surface">
            {t("view.active")}
          </Button>
          <Button disabled shape="pill" variant="surface">
            {t("view.backlog")}
          </Button>
          <Button disabled shape="pill" variant="surface">
            {t("view.allIssues")}
          </Button>
          <IconButton disabled className="board-view-tabs__add" label={t("view.add")} name="viewAdd" />
        </div>
        <div className="board-toolbar__actions">
          <CascadingFilter
            ariaLabel={t("view.filter")}
            messages={filterMessages}
            onValueChange={onFiltersChange}
            options={options}
            trigger={<IconButton label={t("view.filter")} name="filter" variant="surface" />}
            value={filters}
          />
          <PopoverSurface
            className="view-settings-popover"
            label={t("view.display")}
            trigger={<IconButton label={t("view.display")} name="settings" variant="surface" />}
          >
            <ViewSettings />
          </PopoverSurface>
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
              value={filters}
            />
          }
          ariaLabel={t("view.filter")}
          className="board-applied-filters"
          messages={filterMessages}
          onValueChange={onFiltersChange}
          options={options}
          value={filters}
        />
      ) : null}
    </div>
  );
};

const activeColumns = [
  { labelKey: "state.BACKLOG", states: ["BACKLOG"], tone: "queued" },
  { labelKey: "state.READY", states: ["READY"], tone: "ready" },
  { labelKey: "state.IN_PROGRESS", states: ["IN_PROGRESS"], tone: "running" },
  { labelKey: "state.BLOCKED", states: ["BLOCKED"], tone: "waiting" },
] as const satisfies readonly {
  labelKey: TranslationKey;
  states: readonly WorkItemState[];
  tone: StatusTone;
}[];

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

const transitionTargets: Record<WorkItemState, readonly WorkItemState[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
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

const filterOptionsFor = (items: readonly WorkItem[], t: Translator): readonly FilterNode[] => {
  const count = (predicate: (item: WorkItem) => boolean): number => items.filter(predicate).length;
  return [
    {
      id: "status",
      label: t("filter.status"),
      icon: "clock",
      children: activeColumns.map((column) => ({
        id: `status-${column.states[0].toLowerCase()}`,
        label: t(column.labelKey),
        count: count((item) => column.states.some((state) => state === item.state)),
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
  ];
};

const matchesFilters = (item: WorkItem, filters: readonly string[]): boolean =>
  filters.every((filter) => {
    if (filter.startsWith("status-")) return filter === `status-${item.state.toLowerCase()}`;
    if (filter.startsWith("priority-")) return filter === `priority-${item.priority.toLowerCase()}`;
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

  return (
    <button
      aria-label={item.title}
      aria-pressed={selected}
      className="task-card-button"
      onClick={() => {
        onSelect(item.id);
      }}
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
      trigger={<Button shape="pill">{t("task.edit")}</Button>}
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

const WorkflowPanel = ({ item }: { item: WorkItem }): React.JSX.Element => {
  const { t } = useI18n();
  const workflowQuery = useWorkItemWorkflow(item.id);
  const startMutation = useStartMockPipeline();
  const controlMutation = usePipelineControl();
  const overrideMutation = useApproveBudgetOverride();
  const [lastAction, setLastAction] = useState<"pause" | "resume" | "cancel" | "override" | null>(null);
  const snapshot = workflowQuery.data;
  const openRequest = snapshot?.humanRequests.find(({ status }) => status === "OPEN") ?? null;

  if (workflowQuery.isPending) return <p className="inspector-copy">{t("workflow.loading")}</p>;

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
      {["RUNNING", "WAITING_HUMAN", "SOFT_PAUSED", "HARD_PAUSED", "INTERRUPTED"].includes(run.status) ? (
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

const TaskInspector = ({ item }: { item: WorkItem | null }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const moveMutation = useMoveWorkItem();
  const eventsQuery = useWorkItemEvents(item?.projectId, item?.id);
  const workflowQuery = useWorkItemWorkflow(item?.id);
  const [lastTarget, setLastTarget] = useState<WorkItemState | null>(null);

  if (!item) {
    return (
      <aside className="task-inspector is-empty" aria-label={t("empty.noSelection.title")}>
        <FeedbackState
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
  const primaryTarget = targets.find((state) => state !== "CANCELLED") ?? null;
  const secondaryTarget = targets.find((state) => state !== primaryTarget && state !== "CANCELLED") ?? null;

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

      <InspectorSection
        action={
          eventsQuery.data ? (
            <span className="inspector-step-count">{eventsQuery.data.events.length}</span>
          ) : undefined
        }
        title={t("task.activity")}
      >
        {eventsQuery.data?.events.map((event) => (
          <TimelineEvent
            {...eventPresentation(event, t)}
            key={event.id}
            time={eventTime(event.occurredAt, locale)}
          />
        ))}
        {eventsQuery.isPending ? <p className="inspector-copy">{t("task.loadingActivity")}</p> : null}
        {eventsQuery.data?.events.length === 0 ? (
          <p className="inspector-copy">{t("task.noActivity")}</p>
        ) : null}
      </InspectorSection>

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

      <footer className="task-inspector__footer">
        <Button
          disabled={!secondaryTarget}
          loading={moveMutation.isPending && secondaryTarget !== null}
          onClick={() => {
            if (secondaryTarget) move(secondaryTarget);
          }}
          variant="secondary"
        >
          {secondaryTarget
            ? t("task.moveTo", { state: stateLabel(secondaryTarget, t) })
            : t("task.noSecondaryAction")}
        </Button>
        <Button
          disabled={!primaryTarget}
          loading={moveMutation.isPending && primaryTarget !== null}
          onClick={() => {
            if (primaryTarget) move(primaryTarget);
          }}
          variant="primary"
        >
          {primaryTarget
            ? t("task.moveTo", { state: stateLabel(primaryTarget, t) })
            : t("task.noAvailableMove")}
        </Button>
      </footer>
    </aside>
  );
};

export const WorkbenchPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const { connectionPending, error, projectsPending, retryConnection, selectedProject } = useWorkspace();
  const workItemsQuery = useProjectWorkItems(selectedProject?.id);
  const humanRequestsQuery = useProjectHumanRequests(selectedProject?.id);
  const initializeMutation = useInitializeFixtureWorkspace();
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [filters, setFilters] = useState<readonly string[]>([]);
  const workItems = workItemsQuery.data?.workItems ?? [];
  const activeItems = workItems.filter((item) => item.state !== "DONE" && item.state !== "CANCELLED");
  const visibleItems = activeItems.filter((item) => matchesFilters(item, filters));
  const selectedItem =
    activeItems.find((item) => item.id === selectedWorkItemId) ?? activeItems.at(0) ?? null;
  const filterOptions = filterOptionsFor(activeItems, t);
  const blockingRequests = humanRequestsQuery.data?.humanRequests.filter(({ blocking }) => blocking) ?? [];

  return (
    <div className="workbench">
      <section
        aria-label={t("work.boardLabel")}
        className="workbench-board"
        aria-labelledby="current-work-title"
      >
        <BoardToolbar filters={filters} onFiltersChange={setFilters} options={filterOptions} />
        {blockingRequests[0] ? (
          <button
            className="attention-banner"
            onClick={() => {
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
        <header className="workbench-heading">
          <div>
            <span className="workbench-heading__mark">
              <Icon name="board" size={14} />
            </span>
            <div>
              <h1 id="current-work-title">{t("work.current")}</h1>
              <p>
                {selectedProject
                  ? t("work.projectPersisted", { project: selectedProject.name })
                  : t("work.chooseProject")}
              </p>
            </div>
          </div>
          <div>
            <Button disabled shape="pill">
              {t("action.share")}
            </Button>
            <ActionMenu
              align="end"
              groups={[
                [
                  { icon: "link", label: t("view.copyLink") },
                  { icon: "star", label: t("favorite.add") },
                ],
              ]}
              trigger={<IconButton label={t("view.actions")} name="more" variant="surface" />}
            />
          </div>
        </header>

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
          <div className="workbench-state">
            <FeedbackState description={t("loading.board.description")} title={t("loading.board.title")} />
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
            <div className="kanban-board">
              {activeColumns.map((column) => {
                const columnItems = visibleItems.filter((item) =>
                  column.states.some((state) => state === item.state),
                );
                return (
                  <KanbanColumn
                    addLabel={t("task.addToColumn", { state: t(column.labelKey) })}
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
            {activeItems.length === 0 ? (
              <div className="board-filter-empty" role="status">
                <span>
                  <Icon name="inbox" size={18} />
                </span>
                <strong>{t("empty.noTasks.title")}</strong>
                <p>{t("empty.noTasks.description")}</p>
              </div>
            ) : null}
            {filters.length > 0 && visibleItems.length === 0 ? (
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

      <TaskInspector item={selectedItem} key={selectedItem?.id ?? "empty"} />
    </div>
  );
};
