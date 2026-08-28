import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { prioritySchema, type ListedProject, type WorkItem } from "@loomrail/contracts";
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
import { PanelResizer } from "../components/PanelResizer";
import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n } from "../i18n";
import type { WorkbenchSearch } from "../router";
import { hasCustomPanelWidths, resetPanelWidths } from "../layout";
import { applyDensityPreference, readDensityPreference, type DensityPreference } from "../density";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../theme";
import {
  useCreateWorkItem,
  useProjectHumanRequests,
  useRegisterRepositoryProject,
  useRepairFixtureProject,
  useWorkspace,
} from "../workspace";

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
        {createMutation.error ? (
          <LocalConnectionRecovery
            error={createMutation.error}
            onRetry={() => {
              formRef.current?.requestSubmit();
            }}
            retrying={createMutation.isPending}
          />
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

type SettingsDialogProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

type SettingChoiceOption<TValue extends string> = {
  icon?: IconName;
  label: string;
  value: TValue;
};

/**
 * A small set of mutually exclusive options shown as pressable tiles.
 *
 * Preferred over a dropdown here because every choice fits on screen: the reader compares them at a
 * glance and commits in one click, instead of opening a list to see two or three items.
 */
const SettingChoice = <TValue extends string>({
  description,
  label,
  onChange,
  options,
  value,
}: {
  description?: string;
  label: string;
  onChange: (value: TValue) => void;
  options: readonly SettingChoiceOption<TValue>[];
  value: TValue;
}): React.JSX.Element => {
  // A generated id, because a translated label can contain spaces and would not be a valid IDREF.
  const labelId = useId();
  return (
    <div className="setting">
      <span className="setting__label" id={labelId}>
        {label}
      </span>
      <div aria-labelledby={labelId} className="setting__choices" role="group">
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            key={option.value}
            onClick={() => {
              onChange(option.value);
            }}
            type="button"
          >
            {option.icon ? <Icon name={option.icon} size={15} /> : null}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      {description ? <small className="setting__hint">{description}</small> : null}
    </div>
  );
};

/**
 * What an owner does about a Project whose recorded path is no longer a repository.
 *
 * Only shown for a Project that has one, and only where the owner is already looking at the path
 * that is wrong. A demo Project gets a button, because Loomrail knows exactly where its repository
 * belongs and can put it there (`useRepairFixtureProject`). A Project the owner registered by path
 * gets the explanation and no button: nothing here knows where they moved their repository to, and
 * offering to "repair" it would either do nothing or do the wrong thing -- they register the new
 * path in the field below.
 *
 * This is the reachability half of the repair. `REPOINT_FIXTURE_PROJECT` and its route existed and
 * were tested through HTTP, but the only thing in the product that called the route was "Initialize
 * demo workspace", which renders only when there is no selected project at all -- so an owner with
 * two stale demo Projects, which is the shape of the one database that matters, could not reach it
 * by any sequence of clicks.
 */
const RepairFixtureProject = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const repairMutation = useRepairFixtureProject();
  const fixtureId = project.fixtureId;
  const error = repairMutation.error instanceof Error ? repairMutation.error.message : null;

  return (
    <div className="settings__project-repair">
      <p className="settings__note" role="note">
        {t("settings.projects.unusable")}
      </p>
      {fixtureId === null ? null : (
        <Button
          loading={repairMutation.isPending}
          onClick={() => {
            repairMutation.mutate(fixtureId);
          }}
        >
          {t("settings.projects.repair")}
        </Button>
      )}
      {error === null ? null : (
        <p className="settings__project-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/**
 * Where the owner registers a local Git repository of their own as a Project (spec §4).
 *
 * It sits beside the project list rather than in the empty state, because the empty state is gone
 * the moment the demo is initialised, and registering your own repository is exactly the thing you
 * do *after* looking at the demo. The one field is the path: the daemon takes the repository
 * directory's own name, so there is nothing else to ask for.
 *
 * The refusal shown under the field is the daemon's, word for word. It names the path and, when the
 * path is a directory inside another repository, says which repository that is -- a message the
 * domain already writes, and one this form would only make vaguer by paraphrasing.
 */
const RegisterRepositoryField = (): React.JSX.Element => {
  const { t } = useI18n();
  const inputId = useId();
  const [path, setPath] = useState("");
  const registerMutation = useRegisterRepositoryProject();
  const error = registerMutation.error instanceof Error ? registerMutation.error.message : null;
  const trimmed = path.trim();

  return (
    <form
      className="settings__register"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === "") return;
        registerMutation.mutate(trimmed, {
          onSuccess: () => {
            setPath("");
          },
        });
      }}
    >
      <Field
        description={t("settings.projects.register.description")}
        htmlFor={inputId}
        label={t("settings.projects.register.label")}
        {...(error === null ? {} : { error })}
      >
        <TextField
          autoComplete="off"
          id={inputId}
          invalid={error !== null}
          onChange={(event) => {
            setPath(event.target.value);
          }}
          placeholder={t("settings.projects.register.placeholder")}
          size="md"
          spellCheck={false}
          value={path}
        />
      </Field>
      <Button disabled={trimmed === ""} loading={registerMutation.isPending} type="submit">
        {t("settings.projects.register.action")}
      </Button>
    </form>
  );
};

/**
 * Gathers the preferences that belong to this browser.
 *
 * Theme, language and density are stored locally and affect nothing the daemon owns, which is why
 * they live together here. Registering a repository is the one thing in this dialog that is not a
 * local preference: it is a command against domain state, and it lives here because this is where
 * the project list already is -- not because it belongs with the toggles above it.
 */
const SettingsDialog = ({ onOpenChange, open }: SettingsDialogProps): React.JSX.Element => {
  const { locale, setLocale, t } = useI18n();
  const { projects, selectedProject, selectProject } = useWorkspace();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [density, setDensity] = useState<DensityPreference>(readDensityPreference);
  const [customWidths, setCustomWidths] = useState(hasCustomPanelWidths);

  useEffect(() => {
    if (open) setCustomWidths(hasCustomPanelWidths());
  }, [open]);

  return (
    <DialogSurface
      closeLabel={t("action.closeDialog")}
      description={t("settings.description")}
      onOpenChange={onOpenChange}
      open={open}
      title={t("settings.title")}
    >
      <div className="settings">
        <section className="settings__section">
          <h3>{t("settings.appearance")}</h3>
          <SettingChoice
            label={t("theme.change")}
            onChange={(value) => {
              setTheme(value);
              applyThemePreference(value);
            }}
            options={[
              { icon: "monitor", label: t("theme.system"), value: "system" },
              { icon: "sun", label: t("theme.light"), value: "light" },
              { icon: "moon", label: t("theme.dark"), value: "dark" },
            ]}
            value={theme}
          />
          <SettingChoice
            description={t("settings.density.description")}
            label={t("settings.density")}
            onChange={(value) => {
              setDensity(value);
              applyDensityPreference(value);
            }}
            options={[
              { icon: "list", label: t("settings.density.comfortable"), value: "comfortable" },
              { icon: "layers", label: t("settings.density.compact"), value: "compact" },
            ]}
            value={density}
          />
          <SettingChoice
            label={t("language.change")}
            onChange={setLocale}
            options={[
              { label: t("language.english"), value: "en" },
              { label: t("language.russian"), value: "ru" },
            ]}
            value={locale}
          />
        </section>

        <section className="settings__section">
          <h3>{t("settings.layout")}</h3>
          <p className="settings__note">{t("settings.layout.description")}</p>
          <Button
            disabled={!customWidths}
            onClick={() => {
              resetPanelWidths();
              setCustomWidths(false);
            }}
          >
            {t("settings.layout.reset")}
          </Button>
        </section>

        <section className="settings__section">
          <h3>{t("settings.projects")}</h3>
          {projects.length > 0 ? (
            <ul className="settings__projects">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    aria-pressed={project.id === selectedProject?.id}
                    onClick={() => {
                      selectProject(project.id);
                    }}
                    type="button"
                  >
                    <span>{project.name.slice(0, 1).toUpperCase()}</span>
                    <span className="settings__project-copy">
                      <strong>{project.name}</strong>
                      {/* The path, not only the name. A Project whose repository has moved or was
                          never one is otherwise indistinguishable here from a healthy one -- which
                          is how two demo Projects stuck at a directory inside Loomrail's own
                          checkout stayed invisible while every IMPLEMENT on them was refused. */}
                      <small className="settings__project-path" title={project.repositoryPath}>
                        {t("settings.projects.repositoryLabel")}: {project.repositoryPath}
                      </small>
                    </span>
                    {project.id === selectedProject?.id ? <Icon name="check" size={14} /> : null}
                  </button>
                  {project.repositoryStatus === "UNUSABLE" ? (
                    <RepairFixtureProject project={project} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings__note">{t("project.none")}</p>
          )}
          <RegisterRepositoryField />
        </section>
      </div>
    </DialogSurface>
  );
};

const SidebarLink = ({
  active,
  count,
  icon,
  label,
  search,
}: {
  active: boolean;
  count?: number;
  icon: IconName;
  label: string;
  search: WorkbenchSearch;
}): React.JSX.Element => (
  <Link className={cn("app-nav-link", active && "is-active")} search={search} to="/">
    <Icon name={icon} size={15} />
    <span>{label}</span>
    {count !== undefined && count > 0 ? <em className="app-nav-link__count">{count}</em> : null}
  </Link>
);

/**
 * Reports whether a single-line label is clipped by the width it was given.
 *
 * The sidebar is resizable and collapses to an icon rail, so the project name only earns a tooltip
 * once it stops fitting; a label the rail hides entirely counts as clipped as well.
 */
const useClippedLabel = (label: string): { clipped: boolean; ref: (node: HTMLElement | null) => void } => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (node === null) return undefined;

    const measure = (): void => {
      setClipped(node.scrollWidth > node.clientWidth || node.clientWidth === 0);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [label, node]);

  return { clipped, ref: setNode };
};

const WorkspaceNavigation = ({
  onNavigate,
  onOpenSettings,
}: {
  onNavigate?: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { connection, projects, selectedProject, selectProject } = useWorkspace();
  const humanRequestsQuery = useProjectHumanRequests(selectedProject?.id);
  const search = useLocation({ select: (location) => location.search });
  const connected = connection?.status === "connected";
  const projectInitial = selectedProject?.name.slice(0, 1).toUpperCase() ?? "–";
  const projectName = selectedProject?.name ?? "";
  const { clipped: projectNameClipped, ref: projectNameRef } = useClippedLabel(projectName);
  const blockingCount = humanRequestsQuery.data?.humanRequests.filter(({ blocking }) => blocking).length ?? 0;
  const onNeedsYou = search.summary === "needsYou";

  return (
    <>
      <div className="app-sidebar__workspace">
        <BrandMark className="app-brand-mark" size={22} />
        <strong>Loomrail</strong>
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
                  onNavigate?.();
                },
                shortcut: project.id === selectedProject?.id ? "✓" : "",
              })),
            ]}
            trigger={
              <button aria-label={t("project.switch")} className="app-project-label" type="button">
                <span>{projectInitial}</span>
                <strong ref={projectNameRef}>{projectName}</strong>
                <Icon name="chevronDown" size={12} />
              </button>
            }
            {...(projectNameClipped ? { triggerTooltip: projectName } : {})}
          />
        ) : (
          <div className="app-project-label is-empty">
            <span>–</span>
            <strong>{t("project.none")}</strong>
          </div>
        )}
        <nav aria-label={t("nav.workspace")} className="app-nav app-nav--nested" onClick={onNavigate}>
          <SidebarLink active={!onNeedsYou} icon="board" label={t("nav.currentWork")} search={{}} />
          <SidebarLink
            active={onNeedsYou}
            count={blockingCount}
            icon="question"
            label={t("nav.humanRequests")}
            search={{ summary: "needsYou" }}
          />
        </nav>
      </div>

      <div className="app-sidebar__footer">
        <span className={connected ? "app-connection is-online" : "app-connection is-offline"}>
          <span aria-hidden="true" />
          {connected ? t("connection.local") : t("connection.offline")}
        </span>
        <Tooltip label={t("settings.open")}>
          <IconButton
            label={t("settings.open")}
            name="settings"
            onClick={() => {
              onOpenSettings();
            }}
          />
        </Tooltip>
      </div>
    </>
  );
};

export const AppFrame = (): React.JSX.Element => {
  const { t } = useI18n();
  const { connectionPending, projectsPending, selectedProject } = useWorkspace();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectInitial = selectedProject?.name.slice(0, 1).toUpperCase() ?? "–";

  if (connectionPending || projectsPending) {
    return (
      <div aria-busy="true" className="app-shell app-shell--loading">
        <aside aria-hidden="true" className="app-sidebar app-sidebar--loading" />
        <section className="app-surface app-surface--loading">
          <span aria-label={t("connection.connecting")} className="app-loading-mark" role="status">
            <BrandMark className="app-brand-mark" size={40} />
          </span>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <WorkspaceNavigation
          onOpenSettings={() => {
            setSettingsOpen(true);
          }}
        />
        <PanelResizer edge="start" panel="sidebar" />
      </aside>

      <section className="app-surface">
        <header className="app-topbar">
          <div className="app-breadcrumbs">
            <DialogSurface
              className="app-navigation-drawer"
              closeLabel={t("action.closeDialog")}
              onOpenChange={setNavigationOpen}
              open={navigationOpen}
              title={t("nav.workspace")}
              trigger={
                <IconButton className="app-navigation-trigger" label={t("nav.open")} name="menu" size="sm" />
              }
            >
              <WorkspaceNavigation
                onNavigate={() => {
                  setNavigationOpen(false);
                }}
                onOpenSettings={() => {
                  setNavigationOpen(false);
                  setSettingsOpen(true);
                }}
              />
            </DialogSurface>
            <span className="app-project-icon">{projectInitial}</span>
            <span className="app-breadcrumbs__project">
              {selectedProject?.name ?? t("project.noneSingle")}
            </span>
            <Icon name="chevronRight" size={12} />
            <strong>{t("work.current")}</strong>
          </div>
          <div className="app-topbar__actions">
            <NewTaskDialog />
          </div>
        </header>
        <main className="app-content" id="main-content">
          <Outlet />
        </main>
      </section>

      <SettingsDialog onOpenChange={setSettingsOpen} open={settingsOpen} />
    </div>
  );
};
