import { useEffect, useMemo, useState } from "react";
import type {
  ListedProject,
  McpCapabilityProbeState,
  McpProfileCandidate,
  McpProfileProposal,
  McpProfileView,
} from "@loomrail/contracts";
import { Button, Checkbox, Field, Icon, Textarea, TextField } from "@loomrail/ui";

import { LocalApiError } from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import {
  useConfirmMcpProfile,
  useGrantMcpProfile,
  useProbeMcpProfile,
  useProjectMcpProfiles,
  useProposeContext7Preset,
  useProposeMcpProfile,
  useRevokeMcpProfile,
} from "../workspace";

type McpDraft = {
  profileId: string | null;
  name: string;
  executable: string;
  args: string;
  declaredTools: string;
};

const emptyDraft: McpDraft = {
  profileId: null,
  name: "",
  executable: "",
  args: "",
  declaredTools: "",
};

const lines = (value: string): string[] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const candidateFromDraft = (draft: McpDraft): McpProfileCandidate => ({
  profileId: draft.profileId,
  name: draft.name.trim(),
  executable: draft.executable.trim(),
  args: lines(draft.args),
  declaredTools: lines(draft.declaredTools),
});

const probeStateKeys: Record<McpCapabilityProbeState, TranslationKey> = {
  READY: "settings.mcp.probe.ready",
  SPAWN_FAILED: "settings.mcp.probe.spawnFailed",
  TIMED_OUT: "settings.mcp.probe.timedOut",
  INVALID_RESPONSE: "settings.mcp.probe.invalid",
  OUTPUT_LIMIT_REACHED: "settings.mcp.probe.outputLimit",
  UNSUPPORTED_PROTOCOL: "settings.mcp.probe.unsupported",
  PROCESS_EXITED: "settings.mcp.probe.exited",
};

const ExactCommand = ({ candidate }: { candidate: McpProfileCandidate }): React.JSX.Element => (
  <ol className="mcp-command" aria-label="argv">
    {[candidate.executable, ...candidate.args].map((argument, index) => (
      <li key={`${index.toString()}-${argument}`}>
        <span>{index === 0 ? "executable" : `argv[${index.toString()}]`}</span>
        <code>{argument}</code>
      </li>
    ))}
  </ol>
);

const McpConsentPreview = ({
  proposal,
  onCancel,
  onConfirmed,
}: {
  proposal: McpProfileProposal;
  onCancel: () => void;
  onConfirmed: () => void;
}): React.JSX.Element => {
  const { locale, t } = useI18n();
  const confirm = useConfirmMcpProfile();
  const [accepted, setAccepted] = useState(false);

  return (
    <div className="mcp-consent">
      <div className="mcp-consent__heading">
        <Icon name="warning" size={16} />
        <div>
          <strong>{t("settings.mcp.consent.title")}</strong>
          <p>{t("settings.mcp.consent.description")}</p>
        </div>
      </div>
      <ExactCommand candidate={proposal.candidate} />
      <p className="mcp-consent__expiry">
        {t("settings.mcp.consent.expires", {
          time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(proposal.expiresAt)),
        })}
      </p>
      <Checkbox
        checked={accepted}
        description={t("settings.mcp.consent.checkboxDescription")}
        label={t("settings.mcp.consent.checkbox")}
        onCheckedChange={(checked) => {
          setAccepted(checked === true);
        }}
      />
      <div className="mcp-actions">
        <Button
          disabled={!accepted}
          loading={confirm.isPending}
          onClick={() => {
            confirm.mutate(proposal, { onSuccess: onConfirmed });
          }}
          variant="primary"
        >
          {t("settings.mcp.consent.confirm")}
        </Button>
        <Button disabled={confirm.isPending} onClick={onCancel}>
          {t("action.cancel")}
        </Button>
      </div>
      {confirm.error instanceof Error ? (
        <p className="mcp-settings__error" role="alert">
          {confirm.error.message}
        </p>
      ) : null}
    </div>
  );
};

const McpProfile = ({
  onRevise,
  profile,
  projectId,
  projectVersion,
}: {
  onRevise: (profile: McpProfileView) => void;
  profile: McpProfileView;
  projectId: string;
  projectVersion: number;
}): React.JSX.Element => {
  const { t } = useI18n();
  const probe = useProbeMcpProfile();
  const grant = useGrantMcpProfile();
  const revoke = useRevokeMcpProfile();
  const [selectedTools, setSelectedTools] = useState<string[]>(profile.grant?.tools ?? []);
  const [attested, setAttested] = useState(false);
  const capability = profile.capability;
  const availableTools = useMemo(() => {
    if (capability?.state !== "READY") return [];
    const discovered = new Set(capability.tools);
    return profile.revision.declaredTools.filter((tool) => discovered.has(tool));
  }, [capability, profile.revision.declaredTools]);
  const operationError =
    probe.error instanceof Error
      ? probe.error
      : grant.error instanceof Error
        ? grant.error
        : revoke.error instanceof Error
          ? revoke.error
          : null;

  useEffect(() => {
    setSelectedTools(profile.grant?.tools ?? []);
    setAttested(false);
  }, [profile.grant]);

  return (
    <article className="mcp-profile">
      <div className="mcp-profile__heading">
        <div>
          <strong>{profile.revision.name}</strong>
          <span>{t("settings.mcp.revision", { revision: profile.revision.revision })}</span>
        </div>
        <span>
          {profile.grant?.enabled === true
            ? t("settings.mcp.grant.enabled")
            : profile.grant === null
              ? t("settings.mcp.grant.none")
              : t("settings.mcp.grant.revoked")}
        </span>
      </div>
      <ExactCommand candidate={{ ...profile.revision, profileId: profile.revision.profileId }} />
      <div className="mcp-profile__capability">
        <strong>{t("settings.mcp.capability")}</strong>
        <span>
          {capability === null ? t("settings.mcp.probe.notRun") : t(probeStateKeys[capability.state])}
        </span>
      </div>
      {capability?.state === "READY" ? (
        <div className="mcp-tools">
          <div>
            <strong>{t("settings.mcp.declaredTools")}</strong>
            <span>{profile.revision.declaredTools.join(", ")}</span>
          </div>
          <div>
            <strong>{t("settings.mcp.discoveredTools")}</strong>
            <span>{capability.tools.join(", ") || t("settings.mcp.tools.none")}</span>
          </div>
        </div>
      ) : null}
      <div className="mcp-actions">
        <Button
          loading={probe.isPending}
          onClick={() => {
            probe.mutate({ projectId, revision: profile.revision });
          }}
          size="sm"
        >
          {capability === null ? t("settings.mcp.probe.run") : t("settings.mcp.probe.again")}
        </Button>
        <Button
          onClick={() => {
            onRevise(profile);
          }}
          size="sm"
        >
          {t("settings.mcp.revise")}
        </Button>
      </div>

      {capability?.state === "READY" && profile.grant?.enabled !== false ? (
        <div className="mcp-grant">
          <strong>{t("settings.mcp.grant.choose")}</strong>
          {availableTools.map((tool) => (
            <Checkbox
              checked={selectedTools.includes(tool)}
              key={tool}
              label={tool}
              onCheckedChange={(checked) => {
                setSelectedTools((current) =>
                  checked === true
                    ? [...new Set([...current, tool])].sort()
                    : current.filter((candidate) => candidate !== tool),
                );
              }}
            />
          ))}
          <Checkbox
            checked={attested}
            description={t("settings.mcp.grant.attestationDescription")}
            label={t("settings.mcp.grant.attestation")}
            onCheckedChange={(checked) => {
              setAttested(checked === true);
            }}
          />
          <div className="mcp-actions">
            <Button
              disabled={!attested || selectedTools.length === 0}
              loading={grant.isPending}
              onClick={() => {
                grant.mutate({
                  projectId,
                  expectedProjectVersion: projectVersion,
                  revision: profile.revision,
                  expectedGrantVersion: profile.grant?.version ?? null,
                  tools: selectedTools,
                });
              }}
              size="sm"
              variant="primary"
            >
              {profile.grant === null ? t("settings.mcp.grant.enable") : t("settings.mcp.grant.update")}
            </Button>
            {profile.grant?.enabled === true ? (
              <Button
                loading={revoke.isPending}
                onClick={() => {
                  revoke.mutate({
                    projectId,
                    expectedProjectVersion: projectVersion,
                    revision: profile.revision,
                    expectedGrantVersion: profile.grant?.version ?? 0,
                  });
                }}
                size="sm"
              >
                {t("settings.mcp.grant.revoke")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : profile.grant?.enabled === false ? (
        <p className="settings__note">{t("settings.mcp.grant.revokedDescription")}</p>
      ) : null}
      {operationError === null ? null : (
        <p className="mcp-settings__error" role="alert">
          {operationError.message}
        </p>
      )}
    </article>
  );
};

export const McpSettingsPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const profilesQuery = useProjectMcpProfiles(project.id);
  const propose = useProposeMcpProfile();
  const proposeContext7 = useProposeContext7Preset();
  const [draft, setDraft] = useState<McpDraft>(emptyDraft);
  const [proposal, setProposal] = useState<McpProfileProposal | null>(null);
  const profiles = profilesQuery.data?.profiles ?? [];
  const projectVersion = profilesQuery.data?.projectVersion ?? project.version;
  const context7Configured = profiles.some(({ revision }) => revision.name === "Context7");
  // The daemon's "the bundled recipe is already the approved one" answer. It is the successful end
  // of pressing the button, not a failure, so it is reported separately from the error slot below.
  const context7Unchanged =
    proposeContext7.error instanceof LocalApiError && proposeContext7.error.code === "PROFILE_UNCHANGED";
  const candidate = candidateFromDraft(draft);
  const canPropose =
    candidate.name !== "" &&
    candidate.executable !== "" &&
    candidate.declaredTools.length > 0 &&
    !propose.isPending;

  useEffect(() => {
    setDraft(emptyDraft);
    setProposal(null);
  }, [project.id]);

  const setField = <Key extends keyof McpDraft>(key: Key, value: McpDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setProposal(null);
  };

  return (
    <div className="mcp-settings">
      <div className="mcp-settings__heading">
        <div>
          <h4>{t("settings.mcp.title")}</h4>
          <p>{t("settings.mcp.description")}</p>
        </div>
      </div>

      <div className="mcp-preset">
        <div>
          <strong>{t("settings.mcp.context7.title")}</strong>
          <p>{t("settings.mcp.context7.description")}</p>
          <p>{t("settings.mcp.context7.privacy")}</p>
          {context7Configured ? <p>{t("settings.mcp.context7.configured")}</p> : null}
        </div>
        {/*
          The button stays after the preset is configured. A Loomrail update can move the bundled
          Context7 entrypoint, and the daemon route already answers that case -- it proposes a new
          revision of the same profile, and refuses with PROFILE_UNCHANGED only when the digest is
          identical. Hiding the control was the one thing that made that revision unreachable, so an
          owner stayed on an old approved recipe with nothing to press. PROFILE_UNCHANGED is shown as
          the ordinary "nothing to do" answer rather than as an error.
        */}
        <Button
          loading={proposeContext7.isPending}
          onClick={() => {
            proposeContext7.mutate(
              { projectId: project.id, expectedProjectVersion: projectVersion },
              { onSuccess: setProposal },
            );
          }}
          size="sm"
        >
          {context7Configured ? t("settings.mcp.context7.update") : t("settings.mcp.context7.review")}
        </Button>
      </div>
      {context7Unchanged ? <p className="settings__note">{t("settings.mcp.context7.current")}</p> : null}

      {profilesQuery.isPending ? (
        <p className="settings__note">{t("settings.mcp.loading")}</p>
      ) : profiles.length === 0 ? (
        <p className="settings__note">{t("settings.mcp.empty")}</p>
      ) : (
        <div className="mcp-profiles">
          {profiles.map((profile) => (
            <McpProfile
              key={profile.revision.id}
              onRevise={(selected) => {
                setDraft({
                  profileId: selected.revision.profileId,
                  name: selected.revision.name,
                  executable: selected.revision.executable,
                  args: selected.revision.args.join("\n"),
                  declaredTools: selected.revision.declaredTools.join("\n"),
                });
                setProposal(null);
              }}
              profile={profile}
              projectId={project.id}
              projectVersion={projectVersion}
            />
          ))}
        </div>
      )}

      <form
        className="mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canPropose) return;
          propose.mutate(
            { projectId: project.id, expectedProjectVersion: projectVersion, candidate },
            { onSuccess: setProposal },
          );
        }}
      >
        <div className="mcp-form__heading">
          <strong>{draft.profileId === null ? t("settings.mcp.add") : t("settings.mcp.newRevision")}</strong>
          {draft.profileId === null ? null : (
            <Button
              onClick={() => {
                setDraft(emptyDraft);
                setProposal(null);
              }}
              size="sm"
              type="button"
            >
              {t("settings.mcp.cancelRevision")}
            </Button>
          )}
        </div>
        <Field htmlFor="mcp-profile-name" label={t("settings.mcp.name")}>
          <TextField
            id="mcp-profile-name"
            onChange={(event) => {
              setField("name", event.target.value);
            }}
            value={draft.name}
          />
        </Field>
        <Field
          description={t("settings.mcp.executableDescription")}
          htmlFor="mcp-profile-executable"
          label={t("settings.mcp.executable")}
        >
          <TextField
            autoComplete="off"
            id="mcp-profile-executable"
            onChange={(event) => {
              setField("executable", event.target.value);
            }}
            placeholder="/absolute/path/to/mcp-server"
            spellCheck={false}
            value={draft.executable}
          />
        </Field>
        <Field
          description={t("settings.mcp.argsDescription")}
          htmlFor="mcp-profile-args"
          label={t("settings.mcp.args")}
        >
          <Textarea
            id="mcp-profile-args"
            onChange={(event) => {
              setField("args", event.target.value);
            }}
            rows={3}
            spellCheck={false}
            value={draft.args}
          />
        </Field>
        <Field
          description={t("settings.mcp.toolsDescription")}
          htmlFor="mcp-profile-tools"
          label={t("settings.mcp.declaredTools")}
          required
        >
          <Textarea
            id="mcp-profile-tools"
            onChange={(event) => {
              setField("declaredTools", event.target.value);
            }}
            rows={3}
            spellCheck={false}
            value={draft.declaredTools}
          />
        </Field>
        <Button disabled={!canPropose} loading={propose.isPending} type="submit">
          {t("settings.mcp.review")}
        </Button>
      </form>

      {proposal === null ? null : (
        <McpConsentPreview
          onCancel={() => {
            setProposal(null);
          }}
          onConfirmed={() => {
            setProposal(null);
            setDraft(emptyDraft);
          }}
          proposal={proposal}
        />
      )}
      {propose.error instanceof Error ? (
        <p className="mcp-settings__error" role="alert">
          {propose.error.message}
        </p>
      ) : proposeContext7.error instanceof Error && !context7Unchanged ? (
        <p className="mcp-settings__error" role="alert">
          {proposeContext7.error.message}
        </p>
      ) : profilesQuery.error instanceof Error ? (
        <p className="mcp-settings__error" role="alert">
          {profilesQuery.error.message}
        </p>
      ) : null}
      <p className="mcp-settings__limit">
        <Icon name="info" size={14} />
        <span>{t("settings.mcp.limit")}</span>
      </p>
    </div>
  );
};
