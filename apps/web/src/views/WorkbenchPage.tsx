import { useState } from "react";
import {
  ActionMenu,
  AppliedFilterBar,
  BudgetMeter,
  Button,
  CascadingFilter,
  Checkbox,
  cn,
  HumanRequestRow,
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
  TimelineEvent,
  type IconName,
  type StatusTone,
  type TaskCardProps,
  type TimelineEventProps,
} from "@loomrail/ui";

import { taskFilterOptions } from "../taskFilters";

const viewGroupingOptions = [
  { label: "No grouping", value: "none" },
  { label: "Status", value: "status" },
  { label: "Assignee", value: "assignee" },
  { label: "Agent", value: "agent" },
  { label: "Project", value: "project" },
  { label: "Priority", value: "priority" },
  { label: "Label", value: "label" },
] as const;

const viewOrderingOptions = [
  { label: "Manual", value: "manual" },
  { label: "Title", value: "title" },
  { label: "Status", value: "status" },
  { label: "Priority", value: "priority" },
  { label: "Assignee", value: "assignee" },
  { label: "Agent", value: "agent" },
  { label: "Estimate", value: "estimate" },
  { label: "Updated", value: "updated" },
  { label: "Created", value: "created" },
  { label: "Due date", value: "due-date" },
  { label: "Link count", value: "link-count" },
  { label: "Time in status", value: "time-in-status" },
] as const;

const ViewSettings = (): React.JSX.Element => {
  const [view, setView] = useState<"board" | "list">("list");
  return (
    <div className="view-settings">
      <SegmentedControl
        ariaLabel="Task layout"
        onValueChange={setView}
        options={[
          { icon: "list", label: "List", value: "list" },
          { icon: "board", label: "Board", value: "board" },
        ]}
        value={view}
      />
      <div className="view-settings__controls">
        <div className="view-settings__row">
          <span>Grouping</span>
          <SelectControl
            ariaLabel="Group tasks by"
            defaultValue="status"
            options={viewGroupingOptions}
            size="sm"
            variant="compact"
          />
        </div>
        <div className="view-settings__row">
          <span>Sub-grouping</span>
          <SelectControl
            ariaLabel="Sub-group tasks by"
            defaultValue="none"
            options={viewGroupingOptions}
            size="sm"
            variant="compact"
          />
        </div>
        <div className="view-settings__row">
          <span>Ordering</span>
          <div className="view-settings__ordering">
            <IconButton
              className="view-settings__direction"
              label="Direction"
              name="sortAscending"
              size="sm"
            />
            <SelectControl
              ariaLabel="Order tasks by"
              defaultValue="priority"
              options={viewOrderingOptions}
              size="sm"
              variant="compact"
            />
          </div>
        </div>
        <Switch label="Order completed by recency" />
      </div>
      <div className="view-settings__section view-settings__section--single">
        <Switch defaultChecked label="Show sub-issues" />
      </div>
      <div className="view-settings__section">
        <span className="view-settings__section-title">
          {view === "list" ? "List options" : "Board options"}
        </span>
        {view === "list" ? <Switch label="Nested sub-issues" /> : null}
        <Switch label="Show empty groups" />
      </div>
      <div className="view-settings__properties">
        <span>Display properties</span>
        <div>
          <PropertyChip active label="ID" />
          <PropertyChip active label="Status" />
          <PropertyChip active label="Assignee" />
          <PropertyChip active label="Priority" />
          <PropertyChip active label="Project" />
          <PropertyChip active label="Due date" />
          <PropertyChip label="Milestone" />
          <PropertyChip active label="Labels" />
          <PropertyChip label="Links" />
          <PropertyChip label="Time in status" />
          <PropertyChip active label="Created" />
          <PropertyChip label="Updated" />
        </div>
      </div>
    </div>
  );
};

type BoardToolbarProps = {
  filters: readonly string[];
  onFiltersChange: (value: readonly string[]) => void;
};

const BoardToolbar = ({ filters, onFiltersChange }: BoardToolbarProps): React.JSX.Element => {
  const hasActiveFilters = filters.length > 0;

  return (
    <div className={cn("board-toolbar-stack", hasActiveFilters && "has-active-filters")}>
      <div className="board-toolbar">
        <div className="board-view-tabs">
          <Button aria-pressed="true" shape="pill" variant="surface">
            Active
          </Button>
          <Button disabled shape="pill" variant="surface">
            Backlog
          </Button>
          <Button disabled shape="pill" variant="surface">
            All issues
          </Button>
          <IconButton disabled className="board-view-tabs__add" label="Add new view" name="viewAdd" />
        </div>
        <div className="board-toolbar__actions">
          <CascadingFilter
            ariaLabel="Filter tasks"
            onValueChange={onFiltersChange}
            options={taskFilterOptions}
            trigger={<IconButton label="Filter tasks" name="filter" variant="surface" />}
            value={filters}
          />
          <PopoverSurface
            className="view-settings-popover"
            label="Display settings"
            trigger={<IconButton label="Display settings" name="settings" variant="surface" />}
          >
            <ViewSettings />
          </PopoverSurface>
        </div>
      </div>
      {hasActiveFilters ? (
        <AppliedFilterBar
          addFilter={
            <CascadingFilter
              ariaLabel="Filter tasks"
              onValueChange={onFiltersChange}
              options={taskFilterOptions}
              trigger={<IconButton className="board-add-filter" label="Add filter" name="add" size="sm" />}
              value={filters}
            />
          }
          ariaLabel="Applied task filters"
          className="board-applied-filters"
          onValueChange={onFiltersChange}
          options={taskFilterOptions}
          value={filters}
        />
      ) : null}
    </div>
  );
};

type BoardTaskDefinition = {
  card: Omit<TaskCardProps, "selected">;
  filters: readonly string[];
  inspector: {
    actions: {
      primary: { icon: IconName; label: string };
      secondary: { icon: IconName; label: string };
    };
    activity: readonly TimelineEventProps[];
    budget: { limit: number; used: number };
    checklist: readonly { checked?: boolean; label: string }[];
    currentStep: string;
    description: string;
    model: string;
    provider: string;
    role: string;
    state: { label: string; tone: StatusTone };
  };
};

const boardTaskDefinitions = {
  "LR-08": {
    card: {
      agent: "CL",
      description: "Independent review is checking transaction boundaries.",
      id: "LR-08",
      meta: "Code review",
      provider: "Claude",
      title: "SQLite command replay",
    },
    filters: [
      "status-review",
      "session-provider-claude",
      "session-state-running",
      "session-model-opus-4-1",
      "session-budget-under-50",
      "priority-normal",
      "project-core",
    ],
    inspector: {
      actions: {
        primary: { icon: "external", label: "Open review" },
        secondary: { icon: "branch", label: "Return" },
      },
      activity: [
        {
          detail: "Started the independent transaction-boundary review.",
          icon: "search",
          label: "Claude",
          time: "now",
          tone: "accent",
        },
        { label: "Replay fixtures loaded from SQLite.", time: "6m" },
        { icon: "check", label: "Implementation handoff accepted.", time: "11m", tone: "success" },
      ],
      budget: { limit: 8_000, used: 2_400 },
      checklist: [
        { checked: true, label: "Replay remains idempotent" },
        { checked: true, label: "Rollback leaves no partial event" },
        { label: "Reviewer verdict recorded" },
      ],
      currentStep: "04 / 05",
      description: "Verify replay, rollback, and event ordering before the implementation can be accepted.",
      model: "Opus 4.1",
      provider: "Claude",
      role: "Reviewer",
      state: { label: "Review", tone: "review" },
    },
  },
  "LR-09": {
    card: {
      agent: "CL",
      badge: { label: "Decision", tone: "warning" },
      description: "Paused until the recovery policy is selected.",
      id: "LR-09",
      meta: "Waiting for you",
      title: "OAuth session recovery",
    },
    filters: [
      "status-waiting",
      "session-provider-claude",
      "session-state-waiting",
      "session-model-opus-4-1",
      "session-budget-50-80",
      "priority-high",
      "project-web-app",
    ],
    inspector: {
      actions: {
        primary: { icon: "question", label: "Answer request" },
        secondary: { icon: "pause", label: "Keep paused" },
      },
      activity: [
        {
          detail: "Requested the owner recovery policy.",
          icon: "question",
          label: "Claude",
          time: "now",
          tone: "warning",
        },
        { label: "Unsafe automatic recovery was rejected.", time: "5m" },
        { icon: "pause", label: "Task moved to Waiting.", time: "9m", tone: "warning" },
      ],
      budget: { limit: 8_000, used: 4_100 },
      checklist: [
        { checked: true, label: "Session failure classified" },
        { checked: true, label: "Recovery choices prepared" },
        { label: "Owner decision recorded" },
      ],
      currentStep: "02 / 05",
      description: "Choose whether interrupted OAuth sessions should retry, pause, or require a fresh login.",
      model: "Opus 4.1",
      provider: "Claude",
      role: "Planner",
      state: { label: "Waiting", tone: "waiting" },
    },
  },
  "LR-12": {
    card: {
      active: true,
      agent: "CX",
      description: "Verify browser capability boundaries with a synthetic fixture.",
      id: "LR-12",
      meta: "Implementing",
      progress: 58,
      provider: "Codex",
      title: "Chrome QA adapter spike",
    },
    filters: [
      "status-running",
      "session-provider-codex",
      "session-state-running",
      "session-model-gpt-5-6",
      "session-budget-under-50",
      "priority-high",
      "project-web-app",
    ],
    inspector: {
      actions: {
        primary: { icon: "external", label: "Open session" },
        secondary: { icon: "pause", label: "Pause" },
      },
      activity: [
        {
          detail: "Opened the adapter boundary.",
          icon: "code",
          label: "Codex",
          time: "now",
          tone: "accent",
        },
        { label: "Policy file loaded from project rules.", time: "4m" },
        { icon: "play", label: "Task moved to Running.", time: "8m", tone: "success" },
      ],
      budget: { limit: 8_000, used: 3_200 },
      checklist: [
        { checked: true, label: "Fixture isolated" },
        { checked: true, label: "Permission model read" },
        { label: "Adapter contract draft" },
        { label: "Security review" },
      ],
      currentStep: "03 / 05",
      description: "Inspect the browser adapter boundary without enabling a real provider.",
      model: "GPT-5.6",
      provider: "Codex",
      role: "Implementer",
      state: { label: "Running", tone: "running" },
    },
  },
  "LR-14": {
    card: {
      agent: "PM",
      badge: { label: "P1", tone: "danger" },
      description: "Stop, warn, and downgrade policies are specified.",
      id: "LR-14",
      meta: "Acceptance ready",
      title: "Budget guardrails for parallel agents",
    },
    filters: ["status-ready", "priority-urgent", "project-web-app"],
    inspector: {
      actions: {
        primary: { icon: "external", label: "Open task" },
        secondary: { icon: "pause", label: "Defer" },
      },
      activity: [
        {
          detail: "Prepared the budget policy for owner acceptance.",
          icon: "check",
          label: "PM",
          time: "now",
          tone: "success",
        },
        { label: "Downgrade behavior documented.", time: "7m" },
        { icon: "warning", label: "Hard-stop threshold added.", time: "14m", tone: "warning" },
      ],
      budget: { limit: 8_000, used: 1_200 },
      checklist: [
        { checked: true, label: "Warning thresholds defined" },
        { checked: true, label: "Hard stop cannot be bypassed" },
        { label: "Owner acceptance recorded" },
      ],
      currentStep: "05 / 05",
      description: "Confirm the warning, downgrade, and hard-stop policy before implementation begins.",
      model: "Opus 4.1",
      provider: "Claude",
      role: "Planner",
      state: { label: "Ready", tone: "ready" },
    },
  },
  "LR-18": {
    card: {
      agent: "UX",
      badge: { label: "P2" },
      description: "Move between lanes without losing task context.",
      id: "LR-18",
      meta: "Planned",
      title: "Board keyboard navigation",
    },
    filters: ["status-ready", "priority-normal", "project-web-app"],
    inspector: {
      actions: {
        primary: { icon: "external", label: "Open task" },
        secondary: { icon: "pause", label: "Defer" },
      },
      activity: [
        {
          detail: "Mapped the expected arrow-key navigation flow.",
          icon: "command",
          label: "UX",
          time: "now",
          tone: "accent",
        },
        { label: "Focus-return contract documented.", time: "6m" },
        { icon: "check", label: "Accessibility brief accepted.", time: "12m", tone: "success" },
      ],
      budget: { limit: 6_000, used: 800 },
      checklist: [
        { checked: true, label: "Arrow-key behavior specified" },
        { checked: true, label: "Focus return specified" },
        { label: "Keyboard implementation verified" },
      ],
      currentStep: "02 / 05",
      description: "Implement predictable keyboard movement between cards, lanes, and the task inspector.",
      model: "GPT-5.6",
      provider: "Codex",
      role: "Implementer",
      state: { label: "Ready", tone: "ready" },
    },
  },
} as const satisfies Record<string, BoardTaskDefinition>;

type BoardTaskId = keyof typeof boardTaskDefinitions;

const boardColumns = [
  { label: "Ready", taskIds: ["LR-14", "LR-18"], tone: "ready" },
  { label: "Running", taskIds: ["LR-12"], tone: "running" },
  { label: "Review", taskIds: ["LR-08", "LR-09"], tone: "review" },
] as const satisfies readonly {
  label: string;
  taskIds: readonly BoardTaskId[];
  tone: StatusTone;
}[];

const getFilterGroup = (filterId: string): string => {
  if (filterId.startsWith("session-provider-")) return "session-provider";
  if (filterId.startsWith("session-state-")) return "session-state";
  if (filterId.startsWith("session-model-")) return "session-model";
  if (filterId.startsWith("session-budget-")) return "session-budget";
  if (filterId.startsWith("assignee-")) return "assignee";
  if (filterId.startsWith("priority-")) return "priority";
  if (filterId.startsWith("project-")) return "project";
  if (filterId.startsWith("status-")) return "status";
  if (filterId.startsWith("due-")) return "due-date";
  if (filterId.startsWith("started-")) return "started-date";
  if (filterId.startsWith("completed-")) return "completed-date";
  return filterId;
};

const taskMatchesFilters = (taskId: BoardTaskId, filters: readonly string[]): boolean => {
  const filterGroups = new Map<string, string[]>();
  filters.forEach((filterId) => {
    const group = getFilterGroup(filterId);
    filterGroups.set(group, [...(filterGroups.get(group) ?? []), filterId]);
  });

  const taskValues: readonly string[] = boardTaskDefinitions[taskId].filters;
  return [...filterGroups.values()].every((groupValues) =>
    groupValues.some((filterId) => taskValues.includes(filterId)),
  );
};

type BoardTaskButtonProps = {
  onSelect: (taskId: BoardTaskId) => void;
  selected: boolean;
  taskId: BoardTaskId;
};

const BoardTaskButton = ({ onSelect, selected, taskId }: BoardTaskButtonProps): React.JSX.Element => {
  const task = boardTaskDefinitions[taskId];
  return (
    <button
      aria-label={task.card.title}
      aria-pressed={selected}
      className="task-card-button"
      onClick={() => {
        onSelect(taskId);
      }}
      type="button"
    >
      <TaskCard {...task.card} selected={selected} />
    </button>
  );
};

export const WorkbenchPage = (): React.JSX.Element => {
  const [selectedTask, setSelectedTask] = useState<BoardTaskId>("LR-12");
  const [filters, setFilters] = useState<readonly string[]>([]);
  const visibleTasks = (Object.keys(boardTaskDefinitions) as BoardTaskId[]).filter((taskId) =>
    taskMatchesFilters(taskId, filters),
  );
  const isVisible = (taskId: BoardTaskId): boolean => visibleTasks.includes(taskId);
  const selectedTaskDefinition: BoardTaskDefinition = boardTaskDefinitions[selectedTask];

  return (
    <div className="workbench">
      <section className="workbench-board" aria-labelledby="current-work-title">
        <BoardToolbar filters={filters} onFiltersChange={setFilters} />
        <header className="workbench-heading">
          <div>
            <span className="workbench-heading__mark">
              <Icon name="board" size={14} />
            </span>
            <div>
              <h1 id="current-work-title">Current work</h1>
              <p>Delivery queue for active tasks, reviews, and decisions.</p>
            </div>
          </div>
          <div>
            <Button disabled shape="pill">
              Share
            </Button>
            <ActionMenu
              align="end"
              groups={[
                [
                  { icon: "link", label: "Copy view link", shortcut: "⌘ L" },
                  { icon: "star", label: "Add to favorites" },
                ],
                [{ danger: true, icon: "close", label: "Delete view" }],
              ]}
              trigger={<IconButton label="Open view actions" name="more" variant="surface" />}
            />
          </div>
        </header>

        <div className="workbench-request">
          <HumanRequestRow
            description="LR-09 · paused until you answer"
            id="Claude Code"
            provider="Decision"
            title="Choose the session recovery policy"
          />
        </div>

        <div className="kanban-board" aria-label="Current work board">
          {boardColumns.map((column) => {
            const visibleColumnTasks = column.taskIds.filter(isVisible);
            return (
              <KanbanColumn
                count={visibleColumnTasks.length}
                key={column.label}
                label={column.label}
                tone={column.tone}
              >
                {visibleColumnTasks.map((taskId) => (
                  <BoardTaskButton
                    key={taskId}
                    onSelect={setSelectedTask}
                    selected={selectedTask === taskId}
                    taskId={taskId}
                  />
                ))}
              </KanbanColumn>
            );
          })}
        </div>
        {filters.length > 0 && visibleTasks.length === 0 ? (
          <div className="board-filter-empty" role="status">
            <span>
              <Icon name="filter" size={18} />
            </span>
            <strong>No tasks match these filters</strong>
            <p>Edit a condition above or clear the filter bar.</p>
          </div>
        ) : null}
      </section>

      <aside className="task-inspector" aria-label="Selected task details">
        <header className="task-inspector__header">
          <div>
            <span>{selectedTask}</span>
            <h2>{selectedTaskDefinition.card.title}</h2>
          </div>
          <ActionMenu
            align="end"
            groups={[
              [
                { icon: "play", label: "Open session", shortcut: "O" },
                { icon: "link", label: "Copy task link" },
                { icon: "projects", label: "Move to project", shortcut: "→" },
              ],
              [{ danger: true, icon: "close", label: "Delete task" }],
            ]}
            trigger={
              <Button shape="pill" trailingIcon="chevronDown">
                Open actions
              </Button>
            }
          />
        </header>

        <InspectorSection title="Run summary">
          <RunSummary
            properties={[
              {
                label: "State",
                value: (
                  <Status
                    label={selectedTaskDefinition.inspector.state.label}
                    tone={selectedTaskDefinition.inspector.state.tone}
                  />
                ),
              },
              { label: "Provider", value: selectedTaskDefinition.inspector.provider },
              { label: "Role", value: selectedTaskDefinition.inspector.role },
              { label: "Model", value: selectedTaskDefinition.inspector.model },
            ]}
          />
          <BudgetMeter
            limit={selectedTaskDefinition.inspector.budget.limit}
            used={selectedTaskDefinition.inspector.budget.used}
          />
        </InspectorSection>

        <InspectorSection
          action={
            <span className="inspector-step-count">{selectedTaskDefinition.inspector.currentStep}</span>
          }
          title="Current step"
        >
          <p className="inspector-copy">{selectedTaskDefinition.inspector.description}</p>
          <div className="inspector-checklist">
            {selectedTaskDefinition.inspector.checklist.map((item) => (
              <Checkbox
                {...(item.checked === undefined ? {} : { defaultChecked: item.checked })}
                disabled
                key={item.label}
                label={item.label}
              />
            ))}
          </div>
        </InspectorSection>

        <InspectorSection
          action={
            <Button disabled shape="pill" size="sm">
              View log
            </Button>
          }
          title="Recent activity"
        >
          {selectedTaskDefinition.inspector.activity.map((event) => (
            <TimelineEvent {...event} key={`${event.label}-${event.time}`} />
          ))}
        </InspectorSection>

        <footer className="task-inspector__footer">
          <Button disabled icon={selectedTaskDefinition.inspector.actions.secondary.icon} variant="secondary">
            {selectedTaskDefinition.inspector.actions.secondary.label}
          </Button>
          <Button disabled icon={selectedTaskDefinition.inspector.actions.primary.icon} variant="primary">
            {selectedTaskDefinition.inspector.actions.primary.label}
          </Button>
        </footer>
      </aside>
    </div>
  );
};
