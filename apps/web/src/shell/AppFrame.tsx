import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import {
  ActionMenu,
  BudgetSlider,
  Button,
  cn,
  DialogSurface,
  Field,
  Icon,
  IconButton,
  SelectControl,
  Textarea,
  TextField,
  Tooltip,
  type IconName,
} from "@loomrail/ui";

import { localConnectionQuery } from "../session";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../theme";

const NewTaskDialog = (): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(8_000);

  return (
    <DialogSurface
      description="Create the work item first. Loomrail will propose the delivery pipeline after the brief is clear."
      footer={
        <>
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled
            onClick={() => {
              setOpen(false);
            }}
            variant="primary"
          >
            Create task
          </Button>
        </>
      }
      onOpenChange={setOpen}
      open={open}
      title="New task"
      trigger={
        <Button icon="add" variant="primary">
          New task
        </Button>
      }
    >
      <form className="new-task-form">
        <Field htmlFor="new-task-title" label="Title" required>
          <TextField autoFocus id="new-task-title" placeholder="What should the team deliver?" />
        </Field>
        <Field
          description="Enough context for the planning agents to ask useful questions."
          htmlFor="new-task-brief"
          label="Brief"
        >
          <Textarea
            aria-describedby="new-task-brief-description"
            id="new-task-brief"
            placeholder="Outcome, constraints, relevant files…"
            rows={5}
          />
        </Field>
        <div className="new-task-form__row">
          <Field htmlFor="new-task-project" label="Project">
            <SelectControl
              ariaLabel="Project"
              defaultValue="web-app"
              id="new-task-project"
              options={[
                { label: "Web app", value: "web-app" },
                { label: "Loomrail core", value: "loomrail-core" },
              ]}
            />
          </Field>
          <Field htmlFor="new-task-priority" label="Priority">
            <SelectControl
              ariaLabel="Priority"
              defaultValue="normal"
              id="new-task-priority"
              options={[
                { label: "No priority", value: "none" },
                { label: "Normal", value: "normal" },
                { label: "Urgent", value: "urgent" },
              ]}
            />
          </Field>
        </div>
        <BudgetSlider
          label="Initial token guardrail"
          max={32_000}
          min={2_000}
          onValueChange={setBudget}
          step={1_000}
          value={budget}
        />
      </form>
    </DialogSurface>
  );
};

const ThemeMenu = (): React.JSX.Element => {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const setPreference = (preference: ThemePreference): void => {
    setTheme(preference);
    applyThemePreference(preference);
  };

  return (
    <ActionMenu
      align="end"
      groups={[
        [
          {
            icon: "sun",
            label: "Light",
            onSelect: () => {
              setPreference("light");
            },
            shortcut: theme === "light" ? "✓" : "",
          },
          {
            icon: "moon",
            label: "Dark",
            onSelect: () => {
              setPreference("dark");
            },
            shortcut: theme === "dark" ? "✓" : "",
          },
          {
            icon: "monitor",
            label: "System",
            onSelect: () => {
              setPreference("system");
            },
            shortcut: theme === "system" ? "✓" : "",
          },
        ],
      ]}
      trigger={
        <IconButton
          label="Change color theme"
          name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"}
        />
      }
    />
  );
};

const SidebarLink = ({
  active = false,
  icon,
  label,
  to,
}: {
  active?: boolean;
  icon: IconName;
  label: string;
  to?: "/";
}): React.JSX.Element => {
  const content = (
    <>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </>
  );

  if (!to) {
    return (
      <span aria-disabled="true" className="app-nav-link">
        {content}
      </span>
    );
  }

  return (
    <Link activeOptions={{ exact: true }} className={cn("app-nav-link", active && "is-active")} to={to}>
      {content}
    </Link>
  );
};

export const AppFrame = (): React.JSX.Element => {
  const connection = useQuery(localConnectionQuery);
  const connected = connection.data?.status === "connected";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__workspace">
          <span className="app-workspace-avatar">L</span>
          <strong>Loomrail</strong>
          <Icon name="chevronDown" size={12} />
          <Tooltip label="Search workspace">
            <IconButton disabled label="Search workspace" name="search" size="sm" />
          </Tooltip>
        </div>

        <nav aria-label="Workspace navigation" className="app-nav">
          <SidebarLink icon="inbox" label="Inbox" />
          <SidebarLink icon="board" label="My work" />
          <SidebarLink icon="agents" label="Human requests" />
        </nav>

        <div className="app-nav-group">
          <span>Workspace</span>
          <nav aria-label="Loomrail sections" className="app-nav">
            <SidebarLink icon="projects" label="Projects" />
            <SidebarLink icon="views" label="Views" />
            <SidebarLink icon="agents" label="Agents" />
            <SidebarLink icon="sessions" label="Sessions" />
          </nav>
        </div>

        <div className="app-nav-group">
          <span>Your projects</span>
          <div className="app-project-label">
            <span>W</span>
            <strong>Web app</strong>
            <Icon name="chevronDown" size={12} />
          </div>
          <nav aria-label="Web app navigation" className="app-nav app-nav--nested">
            <SidebarLink active icon="board" label="Current work" to="/" />
            <SidebarLink icon="list" label="Backlog" />
            <SidebarLink icon="sessions" label="Rules" />
          </nav>
        </div>

        <div className="app-sidebar__footer">
          <span className={connected ? "app-connection is-online" : "app-connection is-offline"}>
            <span aria-hidden="true" />
            {connection.isPending ? "Connecting…" : connected ? "Fixture preview" : "Preview mode"}
          </span>
          <ThemeMenu />
          <Tooltip label="Settings">
            <IconButton disabled label="Open settings" name="settings" />
          </Tooltip>
        </div>
      </aside>

      <section className="app-surface">
        <header className="app-topbar">
          <div className="app-breadcrumbs">
            <span className="app-project-icon">W</span>
            <span>Web app</span>
            <Icon name="chevronRight" size={12} />
            <strong>Current work</strong>
            <Tooltip label="Add to favorites">
              <IconButton disabled label="Add current view to favorites" name="star" size="sm" />
            </Tooltip>
          </div>
          <div className="app-topbar__actions">
            <Tooltip label="Open command menu">
              <Button className="app-search-button" disabled icon="search" shape="pill">
                Search
                <span className="app-search-shortcut">⌘ K</span>
              </Button>
            </Tooltip>
            <NewTaskDialog />
          </div>
        </header>
        <main className="app-content" id="main-content">
          <Outlet />
        </main>
      </section>
    </div>
  );
};
