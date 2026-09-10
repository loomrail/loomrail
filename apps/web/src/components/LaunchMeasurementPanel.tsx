import { useState } from "react";
import {
  launchMeasurementPlanConfigurationSchema,
  type LaunchMeasurementGateResult,
  type LaunchMeasurementHeader,
  type LaunchMeasurementPlanConfiguration,
  type LaunchMeasurementProjectResponse,
  type ListedProject,
  type VerificationPlan,
} from "@loomrail/contracts";
import { Button, Icon, cn } from "@loomrail/ui";

import { useI18n, type Translator } from "../i18n";
import {
  useAdoptLaunchMeasurementPlan,
  useCancelLaunchMeasurement,
  useDisableLaunchMeasurementPlan,
  useLaunchMeasurement,
  useStartLaunchMeasurement,
  useVerificationPlanSettings,
} from "../workspace";

const selectableHeaders: readonly LaunchMeasurementHeader[] = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
];

type LaunchMeasurementForm = {
  startupRecipeId: string;
  dependencyAuditRecipeId: string;
  targetOrigin: string;
  healthPath: string;
  probePath: string;
  privateRoutes: string;
  samples: string;
  lcpMs: string;
  inpMs: string;
  cls: string;
  scriptBytes: string;
  requiredHeaders: readonly LaunchMeasurementHeader[];
};

const formFor = (
  verificationPlan: VerificationPlan,
  snapshot: LaunchMeasurementProjectResponse,
): LaunchMeasurementForm => {
  const saved = snapshot.plan?.configuration;
  return {
    startupRecipeId:
      saved?.startupRecipeId ??
      verificationPlan.recipes.find(({ kind, required }) => kind === "SERVE" && !required)?.id ??
      "",
    dependencyAuditRecipeId:
      saved?.dependencyAuditRecipeId ??
      verificationPlan.recipes.find(({ kind }) => kind === "AUDIT")?.id ??
      "",
    targetOrigin: saved?.targetOrigin ?? "http://127.0.0.1:3000",
    healthPath: saved?.healthPath ?? "/health/ready",
    probePath: saved?.probePath ?? "/",
    privateRoutes: saved?.privateRoutes.join("\n") ?? "",
    samples: (saved?.samples ?? 3).toString(),
    lcpMs: (saved?.thresholds.lcpMs ?? 2_500).toString(),
    inpMs: (saved?.thresholds.inpMs ?? 200).toString(),
    cls: (saved?.thresholds.cls ?? 0.1).toString(),
    scriptBytes: (saved?.thresholds.scriptBytes ?? 512_000).toString(),
    requiredHeaders: saved?.requiredHeaders ?? selectableHeaders,
  };
};

const configurationFor = (
  form: LaunchMeasurementForm,
  verificationPlan: VerificationPlan,
): LaunchMeasurementPlanConfiguration | null => {
  const parsed = launchMeasurementPlanConfigurationSchema.safeParse({
    verificationPlanId: verificationPlan.id,
    verificationPlanRevision: verificationPlan.revision,
    verificationPlanContentHash: verificationPlan.contentHash,
    startupRecipeId: form.startupRecipeId,
    dependencyAuditRecipeId: form.dependencyAuditRecipeId || null,
    targetOrigin: form.targetOrigin.trim(),
    healthPath: form.healthPath.trim(),
    probePath: form.probePath.trim(),
    privateRoutes: form.privateRoutes
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean),
    samples: Number(form.samples),
    thresholds: {
      lcpMs: Number(form.lcpMs),
      inpMs: Number(form.inpMs),
      cls: Number(form.cls),
      scriptBytes: Number(form.scriptBytes),
    },
    requiredHeaders: form.requiredHeaders,
  });
  return parsed.success ? parsed.data : null;
};

const gateEvidence = (gate: LaunchMeasurementGateResult, t: Translator): string => {
  switch (gate.key) {
    case "PERF_WEB_VITALS":
      return t("settings.launch.evidence.vitals", {
        lcp: gate.evidence.medianLcpMs ?? "—",
        inp: gate.evidence.medianInpMs ?? "—",
        cls: gate.evidence.medianCls ?? "—",
      });
    case "PERF_BUNDLE_BUDGET":
      return t("settings.launch.evidence.bundle", {
        measured: gate.evidence.medianScriptBytes,
        budget: gate.evidence.budgetBytes,
      });
    case "SEC_RESPONSE_HEADERS":
      return gate.evidence
        .map(({ name, present }) => `${name}: ${t(present ? "settings.launch.yes" : "settings.launch.no")}`)
        .join(" · ");
    case "SEC_UNAUTHENTICATED_ROUTES":
      return gate.evidence.map(({ path, statusCode }) => `${path}: ${statusCode.toString()}`).join(" · ");
    case "SEC_CLIENT_BUNDLE_SECRETS":
      return t("settings.launch.evidence.secrets", {
        bytes: gate.evidence.scannedScriptBytes,
        count: gate.evidence.findings.reduce((total, finding) => total + finding.count, 0),
      });
    case "DEPS_AUDIT":
      return gate.evidence === null
        ? t("settings.launch.evidence.auditMissing")
        : t("settings.launch.evidence.audit", { status: gate.evidence.status });
  }
};

export type LaunchMeasurementViewProps = {
  adopting: boolean;
  cancelling: boolean;
  disabling: boolean;
  onAdopt: (configuration: LaunchMeasurementPlanConfiguration) => void;
  onCancel: () => void;
  onDisable: () => void;
  onRun: () => void;
  running: boolean;
  snapshot: LaunchMeasurementProjectResponse;
  verificationPlan: VerificationPlan;
};

export const LaunchMeasurementView = ({
  adopting,
  cancelling,
  disabling,
  onAdopt,
  onCancel,
  onDisable,
  onRun,
  running,
  snapshot,
  verificationPlan,
}: LaunchMeasurementViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const [form, setForm] = useState(() => formFor(verificationPlan, snapshot));
  const configuration = configurationFor(form, verificationPlan);
  const serviceRecipes = verificationPlan.recipes.filter(
    ({ kind, required }) => kind === "SERVE" && !required,
  );
  const auditRecipes = verificationPlan.recipes.filter(({ kind }) => kind === "AUDIT");
  const activeRun =
    snapshot.latestRun?.status === "RUNNING" ||
    snapshot.latestRun?.status === "CANCELLING" ||
    snapshot.latestRun?.status === "BLOCKED"
      ? snapshot.latestRun
      : null;
  const planIsCurrent =
    snapshot.plan?.status === "ACTIVE" &&
    configuration !== null &&
    JSON.stringify(snapshot.plan.configuration) === JSON.stringify(configuration);
  const update = <K extends keyof LaunchMeasurementForm>(key: K, value: LaunchMeasurementForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="launch-settings">
      <div className="launch-settings__heading">
        <div>
          <h4>{t("settings.launch.title")}</h4>
          <p>{t("settings.launch.description")}</p>
        </div>
        {snapshot.plan === null ? null : (
          <span className={cn("launch-settings__state", snapshot.plan.status === "ACTIVE" && "is-ready")}>
            <Icon name={snapshot.plan.status === "ACTIVE" ? "check" : "warning"} size={13} />
            {t(
              snapshot.plan.status === "ACTIVE"
                ? "settings.launch.planActive"
                : "settings.launch.planDisabled",
              { revision: snapshot.plan.revision },
            )}
          </span>
        )}
      </div>

      <div className="launch-settings__notice" role="note">
        <strong>{t("settings.launch.localTitle")}</strong>
        <p>{t("settings.launch.localNotice")}</p>
      </div>

      {serviceRecipes.length === 0 ? (
        <p className="launch-settings__error" role="alert">
          {t("settings.launch.noService")}
        </p>
      ) : (
        <div className="launch-settings__form">
          <label>
            <span>{t("settings.launch.serviceRecipe")}</span>
            <select
              onChange={(event) => {
                update("startupRecipeId", event.target.value);
              }}
              value={form.startupRecipeId}
            >
              {serviceRecipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.label}: {[recipe.executable, ...recipe.argv].join(" ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("settings.launch.auditRecipe")}</span>
            <select
              onChange={(event) => {
                update("dependencyAuditRecipeId", event.target.value);
              }}
              value={form.dependencyAuditRecipeId}
            >
              <option value="">{t("settings.launch.auditNone")}</option>
              {auditRecipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.label}: {[recipe.executable, ...recipe.argv].join(" ")}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ["targetOrigin", "settings.launch.origin"],
              ["healthPath", "settings.launch.healthPath"],
              ["probePath", "settings.launch.probePath"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <span>{t(label)}</span>
              <input
                onChange={(event) => {
                  update(key, event.target.value);
                }}
                type="text"
                value={form[key]}
              />
            </label>
          ))}
          <label className="launch-settings__wide">
            <span>{t("settings.launch.privateRoutes")}</span>
            <textarea
              onChange={(event) => {
                update("privateRoutes", event.target.value);
              }}
              rows={2}
              value={form.privateRoutes}
            />
          </label>
          {(
            [
              ["samples", "settings.launch.samples", "1"],
              ["lcpMs", "settings.launch.lcp", "100"],
              ["inpMs", "settings.launch.inp", "10"],
              ["cls", "settings.launch.cls", "0.01"],
              ["scriptBytes", "settings.launch.bundle", "1024"],
            ] as const
          ).map(([key, label, step]) => (
            <label key={key}>
              <span>{t(label)}</span>
              <input
                min="0"
                onChange={(event) => {
                  update(key, event.target.value);
                }}
                step={step}
                type="number"
                value={form[key]}
              />
            </label>
          ))}
          <fieldset className="launch-settings__wide">
            <legend>{t("settings.launch.headers")}</legend>
            {selectableHeaders.map((header) => (
              <label key={header}>
                <input
                  checked={form.requiredHeaders.includes(header)}
                  onChange={(event) => {
                    update(
                      "requiredHeaders",
                      event.target.checked
                        ? [...form.requiredHeaders, header]
                        : form.requiredHeaders.filter((value) => value !== header),
                    );
                  }}
                  type="checkbox"
                />
                <span>{header}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      <p className="launch-settings__identity">
        {t("settings.launch.verificationIdentity", {
          id: verificationPlan.id,
          revision: verificationPlan.revision,
        })}
      </p>
      {configuration === null && serviceRecipes.length > 0 ? (
        <p className="launch-settings__error" role="alert">
          {t("settings.launch.invalid")}
        </p>
      ) : null}
      <div className="launch-settings__actions">
        <Button
          disabled={configuration === null || planIsCurrent || activeRun !== null}
          loading={adopting}
          onClick={() => {
            if (configuration !== null) onAdopt(configuration);
          }}
          type="button"
          variant="primary"
        >
          {snapshot.plan === null ? t("settings.launch.adopt") : t("settings.launch.replace")}
        </Button>
        {snapshot.plan?.status === "ACTIVE" ? (
          <>
            <Button disabled={activeRun !== null} loading={running} onClick={onRun} type="button">
              {t("settings.launch.run")}
            </Button>
            <Button disabled={activeRun !== null} loading={disabling} onClick={onDisable} type="button">
              {t("settings.launch.disable")}
            </Button>
          </>
        ) : null}
        {activeRun === null ? null : (
          <Button loading={cancelling} onClick={onCancel} type="button">
            {t(
              activeRun.status === "CANCELLING"
                ? "settings.launch.cancelling"
                : activeRun.status === "BLOCKED"
                  ? "settings.launch.stopBlocked"
                  : "settings.launch.cancel",
            )}
          </Button>
        )}
      </div>

      {snapshot.latestRun === null ? (
        <p className="settings__note">{t("settings.launch.noRun")}</p>
      ) : (
        <section className="launch-run" aria-label={t("settings.launch.results")}>
          <div className="launch-run__heading">
            <strong>{t(`settings.launch.status.${snapshot.latestRun.status}`)}</strong>
            <span>{t("settings.launch.tree", { tree: snapshot.latestRun.testedTree.slice(0, 8) })}</span>
            {snapshot.freshness === null ? null : (
              <span>{t(`settings.launch.freshness.${snapshot.freshness.status}`)}</span>
            )}
          </div>
          {snapshot.latestRun.errorCode === null ? null : (
            <p className="launch-settings__error" role="alert">
              {t("settings.launch.errorCode", { code: snapshot.latestRun.errorCode })}
            </p>
          )}
          {snapshot.latestRun.results.length === 0 ? null : (
            <ul className="launch-gates">
              {snapshot.latestRun.results.map((gate) => (
                <li key={gate.key}>
                  <span className={cn("launch-gates__status", `is-${gate.status.toLowerCase()}`)}>
                    <Icon name={gate.status === "PASSED" ? "check" : "warning"} size={14} />
                    {t(`settings.launch.gateStatus.${gate.status}`)}
                  </span>
                  <div>
                    <strong>{t(`settings.launch.gate.${gate.key}`)}</strong>
                    <p>{gate.summary}</p>
                    <small>{gateEvidence(gate, t)}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};

export const LaunchMeasurementPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const verificationQuery = useVerificationPlanSettings(project.id);
  const snapshotQuery = useLaunchMeasurement(project.id);
  const adopt = useAdoptLaunchMeasurementPlan();
  const disable = useDisableLaunchMeasurementPlan();
  const run = useStartLaunchMeasurement();
  const cancel = useCancelLaunchMeasurement();
  const verificationPlan = verificationQuery.data?.plan;
  const snapshot = snapshotQuery.data;
  const error =
    adopt.error instanceof Error
      ? adopt.error
      : disable.error instanceof Error
        ? disable.error
        : run.error instanceof Error
          ? run.error
          : cancel.error instanceof Error
            ? cancel.error
            : snapshotQuery.error instanceof Error
              ? snapshotQuery.error
              : verificationQuery.error instanceof Error
                ? verificationQuery.error
                : null;

  if (verificationPlan?.status !== "ACTIVE" || snapshot === undefined) {
    return (
      <div className="launch-settings">
        <div className="launch-settings__heading">
          <div>
            <h4>{t("settings.launch.title")}</h4>
            <p>{t("settings.launch.description")}</p>
          </div>
        </div>
        <p className={error === null ? "settings__note" : "launch-settings__error"}>
          {error?.message ??
            (verificationQuery.isPending || snapshotQuery.isPending
              ? t("settings.launch.loading")
              : t("settings.launch.verificationRequired"))}
        </p>
      </div>
    );
  }

  return (
    <>
      <LaunchMeasurementView
        adopting={adopt.isPending}
        cancelling={cancel.isPending}
        disabling={disable.isPending}
        key={`${verificationPlan.id}:${snapshot.plan?.id ?? "new"}`}
        onAdopt={(configuration) => {
          adopt.mutate({ configuration, snapshot });
        }}
        onCancel={() => {
          if (snapshot.latestRun !== null) cancel.mutate({ projectId: project.id, run: snapshot.latestRun });
        }}
        onDisable={() => {
          disable.mutate({ snapshot });
        }}
        onRun={() => {
          run.mutate({ projectId: project.id, snapshot });
        }}
        running={run.isPending}
        snapshot={snapshot}
        verificationPlan={verificationPlan}
      />
      {error === null ? null : (
        <p className="launch-settings__error" role="alert">
          {error.message}
        </p>
      )}
    </>
  );
};
