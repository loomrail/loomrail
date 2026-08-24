import type { FilterNode } from "@loomrail/ui";

export const taskFilterOptions = [
  {
    children: [
      { count: 2, id: "status-ready", label: "Ready" },
      { count: 1, id: "status-running", label: "Running" },
      { count: 2, id: "status-review", label: "Review" },
      { count: 1, id: "status-waiting", label: "Waiting for input" },
      { count: 6, id: "status-completed", label: "Completed" },
    ],
    icon: "clock",
    id: "status",
    label: "Status",
  },
  {
    children: [
      { count: 3, id: "assignee-current", label: "Current user" },
      { count: 2, id: "assignee-unassigned", label: "No assignee" },
      { count: 4, id: "assignee-pm", label: "Project manager" },
      { count: 2, id: "assignee-reviewer", label: "Reviewer" },
    ],
    icon: "person",
    id: "assignee",
    label: "Assignee",
  },
  {
    children: [
      {
        children: [
          { count: 4, description: "OpenAI coding agent", id: "session-provider-codex", label: "Codex" },
          {
            count: 3,
            description: "Anthropic coding agent",
            id: "session-provider-claude",
            label: "Claude Code",
          },
        ],
        icon: "agents",
        id: "session-provider",
        label: "Provider",
      },
      {
        children: [
          { count: 1, id: "session-state-running", label: "Running" },
          { count: 1, id: "session-state-waiting", label: "Waiting for input" },
          { count: 0, id: "session-state-paused", label: "Paused" },
          { count: 6, id: "session-state-completed", label: "Completed" },
        ],
        icon: "clock",
        id: "session-state",
        label: "State",
      },
      {
        children: [
          { count: 3, id: "session-model-gpt-5-6", label: "GPT-5.6" },
          { count: 2, id: "session-model-opus-4-1", label: "Claude Opus 4.1" },
          { count: 2, id: "session-model-auto", label: "Auto-select" },
        ],
        icon: "code",
        id: "session-model",
        label: "Model",
      },
      {
        children: [
          { count: 4, id: "session-budget-under-50", label: "Under 50%" },
          { count: 2, id: "session-budget-50-80", label: "50–80%" },
          { count: 1, id: "session-budget-over-80", label: "Over 80%" },
        ],
        icon: "budget",
        id: "session-budget",
        label: "Budget used",
      },
    ],
    icon: "sessions",
    id: "agent-session",
    label: "Agent session",
  },
  {
    children: [
      { count: 1, id: "priority-urgent", label: "Urgent" },
      { count: 2, id: "priority-high", label: "High" },
      { count: 3, id: "priority-normal", label: "Normal" },
      { count: 1, id: "priority-low", label: "Low" },
      { count: 0, id: "priority-none", label: "No priority" },
    ],
    icon: "filter",
    id: "priority",
    label: "Priority",
  },
  {
    children: [
      {
        children: [
          { count: 1, id: "due-overdue", label: "Overdue" },
          { count: 2, id: "due-today", label: "Today" },
          { count: 3, id: "due-next-3-days", label: "Next 3 days" },
          { count: 4, id: "due-next-week", label: "Next week" },
          { count: 3, id: "due-none", label: "No due date" },
        ],
        icon: "clock",
        id: "due-date",
        label: "Due date",
      },
      {
        children: [
          { count: 2, id: "started-today", label: "Today" },
          { count: 4, id: "started-past-week", label: "Past week" },
          { count: 6, id: "started-past-month", label: "Past month" },
          { count: 1, id: "started-none", label: "Not started" },
        ],
        icon: "play",
        id: "started-date",
        label: "Started date",
      },
      {
        children: [
          { count: 1, id: "completed-today", label: "Today" },
          { count: 4, id: "completed-past-week", label: "Past week" },
          { count: 6, id: "completed-past-month", label: "Past month" },
          { count: 2, id: "completed-none", label: "Not completed" },
        ],
        icon: "check",
        id: "completed-date",
        label: "Completed date",
      },
    ],
    icon: "clock",
    id: "dates",
    label: "Dates",
  },
  {
    children: [
      { count: 7, id: "project-web-app", label: "Web app" },
      { count: 3, id: "project-core", label: "Core runtime" },
      { count: 2, id: "project-desktop", label: "Desktop shell" },
    ],
    dividerBefore: true,
    icon: "projects",
    id: "project",
    label: "Project",
  },
] satisfies readonly FilterNode[];
