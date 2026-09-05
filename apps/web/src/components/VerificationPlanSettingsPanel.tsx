import type {
  ListedProject,
  VerificationPlanSettingsResponse,
  VerificationRecipe,
} from "@loomrail/contracts";
import { Button, Icon, cn } from "@loomrail/ui";

import { useI18n } from "../i18n";
import {
  useAdoptVerificationPlan,
  useDisableVerificationPlan,
  useRetryVerificationPlanPublication,
  useVerificationPlanSettings,
} from "../workspace";

type VerificationPlanSettingsViewProps = {
  adopting: boolean;
  disabling: boolean;
  onAdopt: () => void;
  onDisable: () => void;
  onRetry: () => void;
  retrying: boolean;
  settings: VerificationPlanSettingsResponse;
};

const formatTimeout = (seconds: number): { count: number; unit: "minutes" | "seconds" } =>
  seconds % 60 === 0 ? { count: seconds / 60, unit: "minutes" } : { count: seconds, unit: "seconds" };

const RecipePolicy = ({ recipe }: { recipe: VerificationRecipe }): React.JSX.Element => {
  const { t } = useI18n();
  const timeout = formatTimeout(recipe.timeoutSeconds);

  return (
    <dl className="verification-recipe__policy">
      <div>
        <dt>{t("settings.verification.cwd")}</dt>
        <dd>{recipe.cwd === "." ? t("settings.verification.projectRoot") : recipe.cwd}</dd>
      </div>
      <div>
        <dt>{t("settings.verification.timeout")}</dt>
        <dd>
          {t(timeout.unit === "minutes" ? "settings.verification.minutes" : "settings.verification.seconds", {
            count: timeout.count,
          })}
        </dd>
      </div>
      <div>
        <dt>{t("settings.verification.output")}</dt>
        <dd>{t("settings.verification.kib", { count: recipe.outputLimitBytes / 1_024 })}</dd>
      </div>
      <div>
        <dt>{t("settings.verification.network")}</dt>
        <dd>
          {t(
            recipe.networkPolicy === "INHERIT_HOST"
              ? "settings.verification.networkHost"
              : "settings.verification.networkUnavailable",
          )}
        </dd>
      </div>
      <div>
        <dt>{t("settings.verification.environment")}</dt>
        <dd>{t("settings.verification.environmentBaseline")}</dd>
      </div>
    </dl>
  );
};

const RecipePreview = ({ recipe }: { recipe: VerificationRecipe }): React.JSX.Element => {
  const { t } = useI18n();
  const exactCommand = [recipe.executable, ...recipe.argv].join(" ");

  return (
    <article className="verification-recipe">
      <div className="verification-recipe__heading">
        <div>
          <strong>{recipe.label}</strong>
          <span>
            {t(recipe.required ? "settings.verification.required" : "settings.verification.optional")}
          </span>
        </div>
        <span>{recipe.kind}</span>
      </div>
      <div className="verification-recipe__command">
        <span>{t("settings.verification.exactCommand")}</span>
        <ol aria-label={exactCommand}>
          <li>
            <small>{t("settings.verification.executable")}</small>
            <code>{recipe.executable}</code>
          </li>
          {recipe.argv.map((argument, index) => (
            <li key={`${index.toString()}-${argument}`}>
              <small>{t("settings.verification.argument", { index: index + 1 })}</small>
              <code>{argument}</code>
            </li>
          ))}
        </ol>
      </div>
      <RecipePolicy recipe={recipe} />
      <details className="verification-recipe__source">
        <summary>{t("settings.verification.source", { script: recipe.provenance.scriptName })}</summary>
        <code>{recipe.provenance.scriptBodyPreview}</code>
        <p>{t("settings.verification.sourceNotice")}</p>
      </details>
    </article>
  );
};

export const VerificationPlanSettingsView = ({
  adopting,
  disabling,
  onAdopt,
  onDisable,
  onRetry,
  retrying,
  settings,
}: VerificationPlanSettingsViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const { plan, proposal, publication } = settings;
  const requiredCount = proposal.recipes.filter((recipe) => recipe.required).length;
  // Publication changes the target from ABSENT to PRESENT, which deliberately changes the scan
  // hash even when the command set did not. Recipe equality is the owner-visible "same Plan"
  // signal; target integrity remains a separate blocking state below.
  const proposalIsCurrent =
    plan?.status === "ACTIVE" && JSON.stringify(plan.recipes) === JSON.stringify(proposal.recipes);
  const targetBlocked = proposal.target.state === "BLOCKED";
  const cannotAdopt = targetBlocked || proposal.recipes.length === 0 || requiredCount === 0;
  const showAdopt = !proposalIsCurrent;
  const publicationApplied = publication?.status === "APPLIED";
  const publicationFailed = publication?.status === "FAILED";
  const publicationPending = publication?.status === "PENDING";

  return (
    <div className="verification-settings">
      <div className="verification-settings__heading">
        <div>
          <h4>{t("settings.verification.title")}</h4>
          <p>{t("settings.verification.description")}</p>
        </div>
        {plan === null ? null : (
          <span
            className={cn(
              "verification-settings__state",
              publicationApplied && plan.status === "ACTIVE" && "is-ready",
            )}
          >
            <Icon name={publicationApplied && plan.status === "ACTIVE" ? "check" : "warning"} size={13} />
            {publicationApplied && plan.status === "DISABLED"
              ? t("settings.verification.disabled", { revision: plan.revision })
              : publicationApplied
                ? t("settings.verification.active", { revision: plan.revision })
                : publicationPending
                  ? t("settings.verification.publishing", { revision: plan.revision })
                  : t("settings.verification.unpublished", { revision: plan.revision })}
          </span>
        )}
      </div>

      <div className="verification-settings__local-warning" role="note">
        <strong>{t("settings.verification.localExecutionTitle")}</strong>
        <p>{t("settings.verification.localExecutionNotice")}</p>
      </div>

      {proposal.recipes.length === 0 ? (
        <p className="settings__note">{t("settings.verification.empty")}</p>
      ) : (
        <div className="verification-recipes" aria-label={t("settings.verification.list")}>
          {proposal.recipes.map((recipe) => (
            <RecipePreview key={recipe.id} recipe={recipe} />
          ))}
        </div>
      )}

      {proposal.warnings.length === 0 ? null : (
        <div className="verification-settings__warnings" role="note">
          <strong>{t("settings.verification.warnings")}</strong>
          <ul>
            {proposal.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index.toString()}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      )}

      {targetBlocked ? (
        <p className="verification-settings__error" role="alert">
          {t("settings.verification.targetBlocked")}
        </p>
      ) : null}

      {showAdopt ? (
        <div className="verification-settings__adoption">
          <p>
            {t(
              plan?.status === "DISABLED"
                ? "settings.verification.enableNotice"
                : "settings.verification.adoptionNotice",
            )}
          </p>
          <Button disabled={cannotAdopt} loading={adopting} onClick={onAdopt} type="button" variant="primary">
            {plan === null
              ? t("settings.verification.adopt", { count: requiredCount })
              : plan.status === "DISABLED"
                ? t("settings.verification.enable", { count: requiredCount })
                : t("settings.verification.replace", { count: requiredCount })}
          </Button>
        </div>
      ) : publicationApplied ? (
        <div className="verification-settings__adoption">
          <p className="verification-settings__published">
            <Icon name="check" size={14} />
            <span>{t("settings.verification.published")}</span>
          </p>
        </div>
      ) : null}

      {plan?.status === "ACTIVE" && publicationApplied ? (
        <div className="verification-settings__actions">
          <Button loading={disabling} onClick={onDisable} type="button">
            {t("settings.verification.disable")}
          </Button>
        </div>
      ) : null}

      {publicationFailed ? (
        <div className="verification-settings__failure" role="alert">
          <div>
            <strong>{t("settings.verification.publicationFailed")}</strong>
            <span>{publication.lastErrorCode ?? t("error.unknown")}</span>
          </div>
          <Button loading={retrying} onClick={onRetry} type="button">
            {t("settings.verification.retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

export const VerificationPlanSettingsPanel = ({ project }: { project: ListedProject }): React.JSX.Element => {
  const { t } = useI18n();
  const settingsQuery = useVerificationPlanSettings(project.id);
  const adopt = useAdoptVerificationPlan();
  const disable = useDisableVerificationPlan();
  const retry = useRetryVerificationPlanPublication();
  const settings = settingsQuery.data;
  const operationError =
    adopt.error instanceof Error
      ? adopt.error
      : disable.error instanceof Error
        ? disable.error
        : retry.error instanceof Error
          ? retry.error
          : settingsQuery.error instanceof Error
            ? settingsQuery.error
            : null;

  if (settings === undefined) {
    return (
      <div className="verification-settings">
        <div className="verification-settings__heading">
          <div>
            <h4>{t("settings.verification.title")}</h4>
            <p>{t("settings.verification.description")}</p>
          </div>
        </div>
        <p className="settings__note">
          {operationError === null ? t("settings.verification.loading") : operationError.message}
        </p>
      </div>
    );
  }

  return (
    <>
      <VerificationPlanSettingsView
        adopting={adopt.isPending}
        disabling={disable.isPending}
        onAdopt={() => {
          adopt.mutate(settings);
        }}
        onDisable={() => {
          disable.mutate(settings);
        }}
        onRetry={() => {
          if (settings.publication !== null) {
            retry.mutate({ projectId: project.id, publication: settings.publication });
          }
        }}
        retrying={retry.isPending}
        settings={settings}
      />
      {operationError === null ? null : (
        <p className="verification-settings__error" role="alert">
          {operationError.message}
        </p>
      )}
    </>
  );
};
