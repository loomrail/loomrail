import { Link, Outlet } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { prioritySchema, type WorkItem } from "@loomrail/contracts";
import {
  ActionMenu,
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

import { BrandMark } from "../components/BrandMark";
import { useI18n } from "../i18n";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../theme";
import { useCreateWorkItem, useWorkspace } from "../workspace";

const NewTaskDialog = (): React.JSX.Element => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { projects, selectedProject } = useWorkspace();
  const createMutation = useCreateWorkItem();
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
  const [priority, setPriority] = useState<WorkItem["priority"]>("MEDIUM");
  const [title, setTitle] = useState("");
  const projectId =
    projects.find((project) => project.id === requestedProjectId)?.id ?? selectedProject?.id ?? "";

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const titleValue = form.get("title");
    const descriptionValue = form.get("description");
    const title = typeof titleValue === "string" ? titleValue.trim() : "";
    const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
    if (!title || !projectId) return;

    createMutation.mutate(
      {
        description,
        priority,
        projectId,
        risk: "MEDIUM",
        title,
        type: "TASK",
      },
      {
        onSuccess: () => {
          formElement.reset();
          setTitle("");
          setOpen(false);
        },
      },
    );
  };

  return (
    <DialogSurface
      closeLabel={t("action.closeDialog")}
      description={t("task.create.description")}
      footer={
        <>
          <Button
            disabled={createMutation.isPending}
            onClick={() => {
              setOpen(false);
            }}
          >
            {t("action.cancel")}
          </Button>
          <Button
            disabled={!title.trim() || !projectId}
            loading={createMutation.isPending}
            onClick={() => {
              formRef.current?.requestSubmit();
            }}
            type="button"
            variant="primary"
          >
            {t("task.create.submit")}
          </Button>
        </>
      }
      onOpenChange={setOpen}
      open={open}
      title={t("task.new")}
      trigger={
        <Button disabled={!selectedProject} icon="add" variant="primary">
          {t("task.new")}
        </Button>
      }
    >
      <form className="new-task-form" id="new-task-form" onSubmit={submit} ref={formRef}>
        {createMutation.error instanceof Error ? (
          <p className="new-task-form__error" role="alert">
            {createMutation.error.message}
          </p>
        ) : null}
        <Field htmlFor="new-task-title" label={t("task.create.title")} required>
          <TextField
            autoFocus
            id="new-task-title"
            name="title"
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
            placeholder={t("task.create.titlePlaceholder")}
            required
            value={title}
          />
        </Field>
        <Field
          description={t("task.create.briefDescription")}
          htmlFor="new-task-brief"
          label={t("task.create.brief")}
        >
          <Textarea
            aria-describedby="new-task-brief-description"
            id="new-task-brief"
            name="description"
            placeholder={t("task.create.briefPlaceholder")}
            rows={5}
          />
        </Field>
        <div className="new-task-form__row">
          <Field htmlFor="new-task-project" label={t("task.create.project")}>
            <SelectControl
              ariaLabel={t("task.create.project")}
              id="new-task-project"
              onValueChange={setRequestedProjectId}
              options={projects.map((project) => ({ label: project.name, value: project.id }))}
              value={projectId}
            />
          </Field>
          <Field htmlFor="new-task-priority" label={t("task.create.priority")}>
            <SelectControl
              ariaLabel={t("task.create.priority")}
              id="new-task-priority"
              onValueChange={(value) => {
                setPriority(prioritySchema.parse(value));
              }}
              options={[
                { label: t("priority.LOW"), value: "LOW" },
                { label: t("priority.MEDIUM"), value: "MEDIUM" },
                { label: t("priority.HIGH"), value: "HIGH" },
                { label: t("priority.URGENT"), value: "URGENT" },
              ]}
              value={priority}
            />
          </Field>
        </div>
      </form>
    </DialogSurface>
  );
};

const ThemeMenu = (): React.JSX.Element => {
  const { t } = useI18n();
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
            label: t("theme.light"),
            onSelect: () => {
              setPreference("light");
            },
            shortcut: theme === "light" ? "✓" : "",
          },
          {
            icon: "moon",
            label: t("theme.dark"),
            onSelect: () => {
              setPreference("dark");
            },
            shortcut: theme === "dark" ? "✓" : "",
          },
          {
            icon: "monitor",
            label: t("theme.system"),
            onSelect: () => {
              setPreference("system");
            },
            shortcut: theme === "system" ? "✓" : "",
          },
        ],
      ]}
      trigger={
        <IconButton
          label={t("theme.change")}
          name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"}
        />
      }
    />
  );
};

const LanguageMenu = (): React.JSX.Element => {
  const { locale, setLocale, t } = useI18n();

  return (
    <ActionMenu
      align="end"
      groups={[
        [
          {
            label: t("language.english"),
            onSelect: () => {
              setLocale("en");
            },
            shortcut: locale === "en" ? "✓" : "",
          },
          {
            label: t("language.russian"),
            onSelect: () => {
              setLocale("ru");
            },
            shortcut: locale === "ru" ? "✓" : "",
          },
        ],
      ]}
      trigger={
        <Button aria-label={t("language.change")} className="app-language-button" size="sm" shape="pill">
          {locale.toUpperCase()}
        </Button>
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
  const { t } = useI18n();
  const { connection, connectionPending, projects, projectsPending, selectedProject, selectProject } =
    useWorkspace();
  const connected = connection?.status === "connected";
  const projectInitial = selectedProject?.name.slice(0, 1).toUpperCase() ?? "–";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__workspace">
          <BrandMark className="app-brand-mark" size={22} />
          <strong>Loomrail</strong>
          <Icon name="chevronDown" size={12} />
          <Tooltip label={t("workspace.search")}>
            <IconButton disabled label={t("workspace.search")} name="search" size="sm" />
          </Tooltip>
        </div>

        <nav aria-label={t("nav.workspace")} className="app-nav">
          <SidebarLink icon="inbox" label={t("nav.inbox")} />
          <SidebarLink icon="board" label={t("nav.myWork")} />
          <SidebarLink icon="agents" label={t("nav.humanRequests")} />
        </nav>

        <div className="app-nav-group">
          <span>{t("nav.workspace")}</span>
          <nav aria-label={t("nav.workspace")} className="app-nav">
            <SidebarLink icon="projects" label={t("nav.projects")} />
            <SidebarLink icon="views" label={t("nav.views")} />
            <SidebarLink icon="agents" label={t("nav.agents")} />
            <SidebarLink icon="sessions" label={t("nav.sessions")} />
          </nav>
        </div>

        <div className="app-nav-group">
          <span>{t("nav.yourProjects")}</span>
          {projects.length > 0 ? (
            <ActionMenu
              groups={[
                projects.map((project) => ({
                  label: project.name,
                  onSelect: () => {
                    selectProject(project.id);
                  },
                  shortcut: project.id === selectedProject?.id ? "✓" : "",
                })),
              ]}
              trigger={
                <button aria-label={t("project.switch")} className="app-project-label" type="button">
                  <span>{projectInitial}</span>
                  <strong>{selectedProject?.name}</strong>
                  <Icon name="chevronDown" size={12} />
                </button>
              }
            />
          ) : (
            <div className="app-project-label is-empty">
              <span>–</span>
              <strong>{projectsPending ? t("project.loading") : t("project.none")}</strong>
            </div>
          )}
          <nav aria-label={t("project.switch")} className="app-nav app-nav--nested">
            <SidebarLink active icon="board" label={t("nav.currentWork")} to="/" />
            <SidebarLink icon="list" label={t("nav.backlog")} />
            <SidebarLink icon="sessions" label={t("nav.rules")} />
          </nav>
        </div>

        <div className="app-sidebar__footer">
          <span className={connected ? "app-connection is-online" : "app-connection is-offline"}>
            <span aria-hidden="true" />
            {connectionPending
              ? t("connection.connecting")
              : connected
                ? t("connection.local")
                : t("connection.offline")}
          </span>
          <LanguageMenu />
          <ThemeMenu />
          <Tooltip label={t("settings.open")}>
            <IconButton disabled label={t("settings.open")} name="settings" />
          </Tooltip>
        </div>
      </aside>

      <section className="app-surface">
        <header className="app-topbar">
          <div className="app-breadcrumbs">
            <span className="app-project-icon">{projectInitial}</span>
            <span>{selectedProject?.name ?? t("project.noneSingle")}</span>
            <Icon name="chevronRight" size={12} />
            <strong>{t("work.current")}</strong>
            <Tooltip label={t("favorite.add")}>
              <IconButton disabled label={t("favorite.add")} name="star" size="sm" />
            </Tooltip>
          </div>
          <div className="app-topbar__actions">
            <Tooltip label={t("command.open")}>
              <Button className="app-search-button" disabled icon="search" shape="pill">
                {t("search")}
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
