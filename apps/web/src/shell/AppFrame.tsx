import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  constitutionPresetIdSchema,
  prioritySchema,
  providerPreferenceSchema,
  type ConstitutionPresetId,
  type ListedProject,
  type ReadinessCheck,
  type SecurityFinding,
  type ProviderId,
  type WorkItem,
} from "@loomrail/contracts";
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
import { McpSettingsPanel } from "../components/McpSettingsPanel";
import { ProjectScaffoldPanel } from "../components/ProjectScaffoldPanel";
import { useI18n, type TranslationKey } from "../i18n";
import { hasCustomPanelWidths, resetPanelWidths } from "../layout";
import { applyDensityPreference, readDensityPreference, type DensityPreference } from "../density";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../theme";
import {
  useCreateWorkItem,
  useAdoptProjectConstitution,
  useAttestProjectReadiness,
  useConstitutionPresets,
  useProjectConstitution,
  useProjectReadiness,
  useProjectProviderSelection,
  useAttentionInbox,
  useAgentFleet,
  useRegisterRepositoryProject,
  useRepairFixtureProject,
  useRetryProjectConstitutionPublication,
  useRunProjectReadiness,
  useRefreshProjectProviderAvailability,
  useScanProjectConstitution,
  useSetProjectProviderPreference,
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

const providerNames: Record<ProviderId, string> = {
  MOCK: "Mock",
  CODEX: "Codex",
  CLAUDE_CODE: "Claude Code",
};

const ProjectProviderPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const selectionQuery = useProjectProviderSelection(project.id);
  const setPreference = useSetProjectProviderPreference();
  const refreshAvailability = useRefreshProjectProviderAvailability();
  const selection = selectionQuery.data;
  const effective = selection?.providers.find(({ provider }) => provider === selection.effectiveProvider);
  const operationError =
    setPreference.error instanceof Error
      ? setPreference.error
      : refreshAvailability.error instanceof Error
        ? refreshAvailability.error
        : selectionQuery.error instanceof Error
          ? selectionQuery.error
          : null;
  const statusKey =
    effective?.ready === true
      ? "settings.provider.status.ready"
      : effective?.installed === false
        ? "settings.provider.status.notInstalled"
        : effective?.authentication === "REQUIRED"
          ? "settings.provider.status.authRequired"
          : "settings.provider.status.unknown";

  return (
    <div className="provider-settings">
      <div className="provider-settings__heading">
        <div>
          <h4>{t("settings.provider.title")}</h4>
          <p>{t("settings.provider.description")}</p>
        </div>
        {selection === undefined ? null : (
          <span className={effective?.ready === true ? "is-ready" : "is-attention"}>{t(statusKey)}</span>
        )}
      </div>

      <Field htmlFor="project-provider-preference" label={t("settings.provider.label")}>
        <SelectControl
          ariaLabel={t("settings.provider.label")}
          disabled={selection === undefined || selection.environmentOverrideLocked || setPreference.isPending}
          id="project-provider-preference"
          onValueChange={(value) => {
            setPreference.mutate({ project, preference: providerPreferenceSchema.parse(value) });
          }}
          options={[
            {
              label: t("settings.provider.option.auto"),
              description: t("settings.provider.option.auto.description"),
              value: "AUTO",
            },
            { label: "Codex", value: "CODEX" },
            { label: "Claude Code", value: "CLAUDE_CODE" },
            {
              label: "Mock",
              description: t("settings.provider.option.mock.description"),
              value: "MOCK",
            },
          ]}
          value={selection?.selection.preference ?? project.providerPreference}
        />
      </Field>

      {selection === undefined ? (
        <p className="settings__note">{t("settings.provider.loading")}</p>
      ) : (
        <div className="provider-settings__summary">
          <p>
            {t("settings.provider.effective", {
              provider: providerNames[selection.effectiveProvider],
            })}
          </p>
          {selection.fallbackReason === "NO_AUTHENTICATED_LIVE_PROVIDER" ? (
            <p>{t("settings.provider.fallback")}</p>
          ) : null}
          {selection.environmentOverrideLocked ? (
            <p role="note">
              {selection.environmentOverrideInvalid
                ? t("settings.provider.overrideInvalid")
                : t("settings.provider.override", {
                    provider: providerNames[selection.environmentOverride ?? "MOCK"],
                  })}
            </p>
          ) : null}
        </div>
      )}

      <Button
        loading={refreshAvailability.isPending}
        onClick={() => {
          refreshAvailability.mutate(project.id);
        }}
        size="sm"
      >
        {t("settings.provider.refresh")}
      </Button>
      {operationError === null ? null : (
        <p className="provider-settings__error" role="alert">
          {operationError.message}
        </p>
      )}
    </div>
  );
};

type PresetSelection = "AUTO" | ConstitutionPresetId;

const ProjectConstitutionPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const presetQuery = useConstitutionPresets();
  const snapshotQuery = useProjectConstitution(project.id);
  const scanMutation = useScanProjectConstitution();
  const adoptMutation = useAdoptProjectConstitution();
  const retryMutation = useRetryProjectConstitutionPublication();
  const [preset, setPreset] = useState<PresetSelection>("AUTO");
  const snapshot = snapshotQuery.data;
  const proposal = snapshot?.latestProposal ?? null;
  const publication = snapshot?.publication ?? null;
  const active = snapshot?.activeConstitution ?? null;
  const blocked = proposal?.scan.targetConstitution.state === "BLOCKED";
  const operationError =
    scanMutation.error instanceof Error
      ? scanMutation.error
      : adoptMutation.error instanceof Error
        ? adoptMutation.error
        : retryMutation.error instanceof Error
          ? retryMutation.error
          : snapshotQuery.error instanceof Error
            ? snapshotQuery.error
            : null;

  return (
    <div className="constitution-settings">
      <div className="constitution-settings__heading">
        <div>
          <h4>{t("settings.constitution.title")}</h4>
          <p>{t("settings.constitution.description")}</p>
        </div>
        {active === null ? null : (
          <span className="constitution-settings__state">
            <Icon name="check" size={13} />
            {t("settings.constitution.activeVersion", { ordinal: active.ordinal })}
          </span>
        )}
      </div>

      <div className="constitution-settings__scan">
        <Field htmlFor="constitution-preset" label={t("settings.constitution.preset")}>
          <SelectControl
            ariaLabel={t("settings.constitution.preset")}
            disabled={presetQuery.isPending || project.repositoryStatus !== "READY"}
            id="constitution-preset"
            onValueChange={(value) => {
              setPreset(value === "AUTO" ? "AUTO" : constitutionPresetIdSchema.parse(value));
            }}
            options={[
              { label: t("settings.constitution.presetAuto"), value: "AUTO" },
              ...(presetQuery.data?.presets.map((candidate) => ({
                description: candidate.description,
                label: candidate.name,
                value: candidate.id,
              })) ?? []),
            ]}
            value={preset}
          />
        </Field>
        <Button
          disabled={project.repositoryStatus !== "READY"}
          loading={scanMutation.isPending}
          onClick={() => {
            scanMutation.mutate({
              project,
              ...(preset === "AUTO" ? {} : { presetId: preset }),
            });
          }}
        >
          {proposal === null ? t("settings.constitution.scan") : t("settings.constitution.rescan")}
        </Button>
      </div>

      {proposal === null ? (
        <p className="settings__note">{t("settings.constitution.empty")}</p>
      ) : (
        <div className="constitution-proposal">
          <div className="constitution-proposal__summary">
            <strong>{t("settings.constitution.proposal")}</strong>
            <span>
              {t("settings.constitution.sourceSummary", {
                files: proposal.scan.files.length,
                preset: proposal.presetId,
              })}
            </span>
          </div>
          <p className="settings__note">{t("settings.constitution.reviewHint")}</p>
          {proposal.scan.warnings.length === 0 ? null : (
            <div className="constitution-proposal__warnings" role="note">
              <strong>{t("settings.constitution.warnings")}</strong>
              <ul>
                {proposal.scan.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index.toString()}`}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="constitution-proposal__sections">
            {proposal.sections.map((section) => (
              <details key={section.key}>
                <summary>{section.title}</summary>
                <pre>{section.body}</pre>
                <small>
                  {t("settings.constitution.sources")}:{" "}
                  {section.sources.map((source) => source.reference).join(", ")}
                </small>
              </details>
            ))}
          </div>
          {blocked ? (
            <p className="constitution-settings__error" role="alert">
              {t("settings.constitution.targetBlocked")}
            </p>
          ) : null}
          {proposal.status === "PROPOSED" ? (
            <Button
              disabled={blocked}
              loading={adoptMutation.isPending}
              onClick={() => {
                adoptMutation.mutate({ project, proposal });
              }}
              variant="primary"
            >
              {active === null ? t("settings.constitution.adopt") : t("settings.constitution.replace")}
            </Button>
          ) : null}
        </div>
      )}

      {publication?.status === "FAILED" ? (
        <div className="constitution-settings__failure" role="alert">
          <div>
            <strong>{t("settings.constitution.failed")}</strong>
            <span>{publication.lastErrorCode ?? t("error.unknown")}</span>
          </div>
          <Button
            loading={retryMutation.isPending}
            onClick={() => {
              retryMutation.mutate({ projectId: project.id, publication });
            }}
          >
            {t("settings.constitution.retry")}
          </Button>
        </div>
      ) : null}
      {operationError === null ? null : (
        <p className="constitution-settings__error" role="alert">
          {operationError.message}
        </p>
      )}
    </div>
  );
};

const readinessCategoryKeys = {
  SECURITY: "settings.readiness.category.security",
  LEGAL: "settings.readiness.category.legal",
  PAYMENTS: "settings.readiness.category.payments",
  ANALYTICS: "settings.readiness.category.analytics",
} as const satisfies Record<ReadinessCheck["category"], TranslationKey>;

const readinessCheckKeys = {
  SECURITY_ACTIVE_CONSTITUTION: "settings.readiness.check.activeConstitution",
  SECURITY_SECRET_PATHS: "settings.readiness.check.secretPaths",
  SECURITY_ENV_IGNORED: "settings.readiness.check.envIgnored",
  SECURITY_CI_HARDENING: "settings.readiness.check.ciHardening",
  LEGAL_LICENSE: "settings.readiness.check.license",
  LEGAL_OWNER_REVIEW: "settings.readiness.check.legalOwner",
  PAYMENTS_OWNER_REVIEW: "settings.readiness.check.paymentsOwner",
  ANALYTICS_OWNER_REVIEW: "settings.readiness.check.analyticsOwner",
} as const satisfies Record<ReadinessCheck["key"], TranslationKey>;

const readinessStatusKeys = {
  PASSED: "settings.readiness.status.passed",
  ACTION_REQUIRED: "settings.readiness.status.action",
  CONFIRMED: "settings.readiness.status.confirmed",
  NOT_APPLICABLE: "settings.readiness.status.na",
} as const satisfies Record<ReadinessCheck["status"], TranslationKey>;

const readinessFindingKeys = {
  ACTIVE_CONSTITUTION_MISSING: "settings.readiness.finding.activeConstitution",
  TRACKED_SECRET_PATH: "settings.readiness.finding.secretPath",
  ENV_NOT_IGNORED: "settings.readiness.finding.envIgnored",
  CI_PULL_REQUEST_TARGET: "settings.readiness.finding.pullRequestTarget",
  CI_WRITE_ALL_PERMISSIONS: "settings.readiness.finding.writeAll",
  CI_ACTION_NOT_PINNED: "settings.readiness.finding.actionPinned",
  CI_INPUT_UNVERIFIABLE: "settings.readiness.finding.ciUnverifiable",
  LICENSE_MISSING: "settings.readiness.finding.license",
} as const satisfies Record<SecurityFinding["code"], TranslationKey>;

const ProjectReadinessPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const snapshotQuery = useProjectReadiness(project.id);
  const runMutation = useRunProjectReadiness();
  const attestMutation = useAttestProjectReadiness();
  const [rationales, setRationales] = useState<Readonly<Record<string, string>>>({});
  const snapshot = snapshotQuery.data;
  const run = snapshot?.run ?? null;
  const operationError =
    runMutation.error instanceof Error
      ? runMutation.error
      : attestMutation.error instanceof Error
        ? attestMutation.error
        : snapshotQuery.error instanceof Error
          ? snapshotQuery.error
          : null;

  return (
    <div className="readiness-settings">
      <div className="readiness-settings__heading">
        <div>
          <h4>{t("settings.readiness.title")}</h4>
          <p>{t("settings.readiness.description")}</p>
        </div>
        {run === null ? null : (
          <span className={cn("readiness-settings__state", run.status === "READY" && "is-ready")}>
            <Icon name={run.status === "READY" ? "check" : "warning"} size={13} />
            {t(run.status === "READY" ? "settings.readiness.ready" : "settings.readiness.actionRequired")}
          </span>
        )}
      </div>

      <div className="readiness-settings__run">
        <Button
          disabled={project.repositoryStatus !== "READY"}
          loading={runMutation.isPending}
          onClick={() => {
            runMutation.mutate(project);
          }}
          variant="primary"
        >
          {run === null ? t("settings.readiness.run") : t("settings.readiness.rerun")}
        </Button>
        {run === null ? null : (
          <div className="readiness-settings__meta">
            <span>
              {t("settings.readiness.checkedAt", {
                date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                  new Date(run.createdAt),
                ),
              })}
            </span>
            <span>
              {run.repositoryHead === null
                ? t("settings.readiness.noHead")
                : t("settings.readiness.head", { head: run.repositoryHead.slice(0, 8) })}
            </span>
            <span>{t(run.workingTreeDirty ? "settings.readiness.dirty" : "settings.readiness.clean")}</span>
          </div>
        )}
      </div>

      {run === null || snapshot === undefined ? (
        <p className="settings__note">{t("settings.readiness.empty")}</p>
      ) : (
        <div className="readiness-checklist">
          {(["SECURITY", "LEGAL", "PAYMENTS", "ANALYTICS"] as const).map((category) => {
            const categoryChecks = snapshot.checks.filter((check) => check.category === category);
            return (
              <section className="readiness-group" key={category}>
                <h5>{t(readinessCategoryKeys[category])}</h5>
                <div className="readiness-group__checks">
                  {categoryChecks.map((check) => {
                    const findings = snapshot.findings.filter((finding) => finding.checkId === check.id);
                    const rationale = rationales[check.id] ?? "";
                    const latestAttestation = snapshot.attestations
                      .filter((attestation) => attestation.checkId === check.id)
                      .at(-1);
                    return (
                      <article className="readiness-check" key={check.id}>
                        <div
                          className={cn(
                            "readiness-check__summary",
                            check.status !== "ACTION_REQUIRED" && "is-passed",
                          )}
                        >
                          <Icon name={check.status === "ACTION_REQUIRED" ? "warning" : "check"} size={15} />
                          <div>
                            <strong>{t(readinessCheckKeys[check.key])}</strong>
                            <span>{t(readinessStatusKeys[check.status])}</span>
                          </div>
                        </div>
                        {findings.length === 0 ? null : (
                          <details className="readiness-check__evidence">
                            <summary>
                              {t("settings.readiness.evidence")} · {findings.length.toString()}
                            </summary>
                            <ul>
                              {findings.map((finding) => (
                                <li key={finding.id}>
                                  <span>{t(readinessFindingKeys[finding.code])}</span>
                                  {finding.path === null ? null : <code>{finding.path}</code>}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {check.mode === "OWNER" && check.status === "ACTION_REQUIRED" ? (
                          <div className="readiness-check__attest">
                            <Field
                              htmlFor={`readiness-rationale-${check.id}`}
                              label={t("settings.readiness.rationale")}
                            >
                              <Textarea
                                id={`readiness-rationale-${check.id}`}
                                onChange={(event) => {
                                  setRationales((current) => ({
                                    ...current,
                                    [check.id]: event.target.value,
                                  }));
                                }}
                                placeholder={t("settings.readiness.rationalePlaceholder")}
                                rows={2}
                                value={rationale}
                              />
                            </Field>
                            <div className="readiness-check__actions">
                              <Button
                                disabled={rationale.trim() === "" || attestMutation.isPending}
                                onClick={() => {
                                  attestMutation.mutate({
                                    check,
                                    outcome: "CONFIRMED",
                                    projectId: project.id,
                                    rationale: rationale.trim(),
                                    run,
                                  });
                                }}
                                size="sm"
                              >
                                {t("settings.readiness.confirm")}
                              </Button>
                              <Button
                                disabled={rationale.trim() === "" || attestMutation.isPending}
                                onClick={() => {
                                  attestMutation.mutate({
                                    check,
                                    outcome: "NOT_APPLICABLE",
                                    projectId: project.id,
                                    rationale: rationale.trim(),
                                    run,
                                  });
                                }}
                                size="sm"
                              >
                                {t("settings.readiness.notApplicable")}
                              </Button>
                            </div>
                          </div>
                        ) : latestAttestation === undefined ? null : (
                          <p className="readiness-check__rationale">{latestAttestation.rationale}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="readiness-settings__limit">
        <Icon name="info" size={14} />
        <span>{t("settings.readiness.limit")}</span>
      </p>
      {operationError === null ? null : (
        <p className="readiness-settings__error" role="alert">
          {operationError.message}
        </p>
      )}
    </div>
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
          <ProjectScaffoldPanel />
          <RegisterRepositoryField />
          {selectedProject === null ? null : <ProjectProviderPanel project={selectedProject} />}
          {selectedProject === null ? null : <McpSettingsPanel project={selectedProject} />}
          {selectedProject === null ? null : <ProjectConstitutionPanel project={selectedProject} />}
          {selectedProject === null ? null : <ProjectReadinessPanel project={selectedProject} />}
        </section>
      </div>
    </DialogSurface>
  );
};

const SidebarLink = ({
  active,
  count,
  countOverflow = false,
  icon,
  label,
  to,
}: {
  active: boolean;
  count?: number;
  countOverflow?: boolean;
  icon: IconName;
  label: string;
  to: "/" | "/attention" | "/fleet";
}): React.JSX.Element => {
  const content = (
    <>
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {count !== undefined && count > 0 ? (
        <em className="app-nav-link__count">{countOverflow ? `${count.toString()}+` : count}</em>
      ) : null}
    </>
  );
  const className = cn("app-nav-link", active && "is-active");
  if (to === "/") {
    return (
      <Link className={className} search={{}} to="/">
        {content}
      </Link>
    );
  }
  if (to === "/attention") {
    return (
      <Link className={className} to="/attention">
        {content}
      </Link>
    );
  }
  return (
    <Link className={className} to="/fleet">
      {content}
    </Link>
  );
};

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
  const attentionQuery = useAttentionInbox();
  const fleetQuery = useAgentFleet();
  const pathname = useLocation({ select: (location) => location.pathname });
  const connected = connection?.status === "connected";
  const projectInitial = selectedProject?.name.slice(0, 1).toUpperCase() ?? "–";
  const projectName = selectedProject?.name ?? "";
  const { clipped: projectNameClipped, ref: projectNameRef } = useClippedLabel(projectName);
  const attentionCount = attentionQuery.data?.items.length ?? 0;
  const onAttention = pathname === "/attention";
  const onFleet = pathname === "/fleet";

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
          <SidebarLink active={pathname === "/"} icon="board" label={t("nav.currentWork")} to="/" />
          <SidebarLink
            active={onFleet}
            icon="agents"
            label={t("nav.fleet")}
            to="/fleet"
            {...(fleetQuery.data === undefined ? {} : { count: fleetQuery.data.capacity.active })}
          />
          <SidebarLink
            active={onAttention}
            count={attentionCount}
            countOverflow={attentionQuery.data?.hasMore ?? false}
            icon="question"
            label={t("nav.attention")}
            to="/attention"
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
  const pathname = useLocation({ select: (location) => location.pathname });
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
            <strong>
              {t(
                pathname === "/attention"
                  ? "attention.inboxTitle"
                  : pathname === "/fleet"
                    ? "fleet.title"
                    : "work.current",
              )}
            </strong>
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
