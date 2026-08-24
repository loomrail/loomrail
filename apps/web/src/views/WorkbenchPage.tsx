import { useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  prioritySchema,
  riskSchema,
  type DomainEvent,
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
  useMoveWorkItem,
  useProjectWorkItems,
  useUpdateWorkItem,
  useWorkspace,
  useWorkItemEvents,
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

const TaskInspector = ({ item }: { item: WorkItem | null }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const moveMutation = useMoveWorkItem();
  const eventsQuery = useWorkItemEvents(item?.projectId, item?.id);
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

  const targets = transitionTargets[item.state];
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
  const initializeMutation = useInitializeFixtureWorkspace();
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [filters, setFilters] = useState<readonly string[]>([]);
  const workItems = workItemsQuery.data?.workItems ?? [];
  const activeItems = workItems.filter((item) => item.state !== "DONE" && item.state !== "CANCELLED");
  const visibleItems = activeItems.filter((item) => matchesFilters(item, filters));
  const selectedItem =
    activeItems.find((item) => item.id === selectedWorkItemId) ?? activeItems.at(0) ?? null;
  const filterOptions = filterOptionsFor(activeItems, t);

  return (
    <div className="workbench">
      <section
        aria-label={t("work.boardLabel")}
        className="workbench-board"
        aria-labelledby="current-work-title"
      >
        <BoardToolbar filters={filters} onFiltersChange={setFilters} options={filterOptions} />
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
