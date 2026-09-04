/* Hallmark · component: provider allowance strip · genre: modern-minimal · theme: existing Loomrail
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: uses existing semantic status and focus tokens
 */
import type {
  ProjectProviderAllowanceResponse,
  ProviderAllowanceAdvisory,
  ProviderAllowanceBucket,
  ProviderAllowanceFreshness,
  ProviderAllowanceSnapshot,
  ProviderAllowanceUnavailableReason,
  ProviderId,
} from "@loomrail/contracts";
import { Button, Icon, Skeleton, type IconName } from "@loomrail/ui";

import { useI18n, type Locale, type TranslationKey, type Translator } from "../i18n";
import { useProjectProviderAllowance, useRefreshProjectProviderAllowance } from "../workspace";

type AllowanceSurface = "command-center" | "task-cockpit";

type ProviderAllowanceStripProps = {
  error: Error | null;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  response: ProjectProviderAllowanceResponse | undefined;
  surface: AllowanceSurface;
};

const providerLabels: Record<ProviderId, string> = {
  CODEX: "Codex",
  CLAUDE_CODE: "Claude Code",
  MOCK: "Mock",
};

const freshnessIcons: Record<ProviderAllowanceFreshness, IconName> = {
  LIVE: "success",
  STALE: "clock",
  UNAVAILABLE: "warning",
};

const freshnessLabelKeys: Record<ProviderAllowanceFreshness, TranslationKey> = {
  LIVE: "providerAllowance.freshness.live",
  STALE: "providerAllowance.freshness.stale",
  UNAVAILABLE: "providerAllowance.freshness.unavailable",
};

const unavailableLabelKeys: Record<ProviderAllowanceUnavailableReason, TranslationKey> = {
  PROVIDER_UNSUPPORTED: "providerAllowance.unavailable.unsupported",
  TARGET_UNVERIFIED: "providerAllowance.unavailable.unverified",
  NOT_AUTHENTICATED: "providerAllowance.unavailable.notAuthenticated",
  DATA_NOT_PRESENT: "providerAllowance.unavailable.noData",
  PROVIDER_SCHEMA_DRIFT: "providerAllowance.unavailable.schemaDrift",
  PROVIDER_TIMEOUT: "providerAllowance.unavailable.timeout",
  PROVIDER_UNAVAILABLE: "providerAllowance.unavailable.provider",
};

const advisoryLabelKeys: Record<ProviderAllowanceAdvisory["status"], TranslationKey> = {
  CAPACITY_AVAILABLE: "providerAllowance.advisory.available",
  LOW_CAPACITY: "providerAllowance.advisory.low",
  LIMIT_REACHED: "providerAllowance.advisory.reached",
  UNKNOWN: "providerAllowance.advisory.unknown",
};

const formatAllowanceWindow = (minutes: number, t: Translator): string => {
  if (minutes % (7 * 24 * 60) === 0) {
    return t("providerAllowance.window.weeks", { count: minutes / (7 * 24 * 60) });
  }
  if (minutes % (24 * 60) === 0) {
    return t("providerAllowance.window.days", { count: minutes / (24 * 60) });
  }
  if (minutes % 60 === 0) {
    return t("providerAllowance.window.hours", { count: minutes / 60 });
  }
  return t("providerAllowance.window.minutes", { count: minutes });
};

const formatPercent = (value: number, locale: Locale): string =>
  new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", {
    maximumFractionDigits: 1,
  }).format(value);

const formatTime = (value: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));

const BucketRow = ({
  bucket,
  observedAt,
}: {
  bucket: ProviderAllowanceBucket;
  observedAt: string;
}): React.JSX.Element => {
  const { locale, t } = useI18n();
  const name = bucket.name ?? t(`providerAllowance.bucket.${bucket.kind}`);

  return (
    <li className="provider-allowance__bucket">
      <span className="provider-allowance__bucket-name">{name}</span>
      <strong>
        {t("providerAllowance.remaining", {
          percent: formatPercent(bucket.remainingPercent, locale),
        })}
      </strong>
      <span>{formatAllowanceWindow(bucket.windowDurationMins, t)}</span>
      <span>{t("providerAllowance.resets", { time: formatTime(bucket.resetsAt, locale) })}</span>
      <details>
        <summary>{t("providerAllowance.details")}</summary>
        <span>
          {t("providerAllowance.used", { percent: formatPercent(bucket.usedPercent, locale) })} ·{" "}
          {t("providerAllowance.observed", { time: formatTime(observedAt, locale) })}
        </span>
      </details>
    </li>
  );
};

const Advisory = ({ advisory }: { advisory: ProviderAllowanceAdvisory }): React.JSX.Element => {
  const { locale, t } = useI18n();
  const parameters =
    advisory.deferUntil === null ? undefined : { time: formatTime(advisory.deferUntil, locale) };
  const labelKey =
    advisory.deferUntil === null && advisory.status === "LOW_CAPACITY"
      ? "providerAllowance.advisory.lowWithoutReset"
      : advisory.deferUntil === null && advisory.status === "LIMIT_REACHED"
        ? "providerAllowance.advisory.reachedWithoutReset"
        : advisoryLabelKeys[advisory.status];
  return (
    <p className="provider-allowance__advisory">
      <Icon name="info" size={13} />
      <span>{t(labelKey, parameters)}</span>
    </p>
  );
};

const AllowanceBody = ({ snapshot }: { snapshot: ProviderAllowanceSnapshot }): React.JSX.Element => {
  const { t } = useI18n();
  if (snapshot.freshness === "UNAVAILABLE") {
    return (
      <p className="provider-allowance__unavailable">{t(unavailableLabelKeys[snapshot.unavailableReason])}</p>
    );
  }
  return (
    <ul className="provider-allowance__buckets">
      {snapshot.buckets.map((bucket) => (
        <BucketRow bucket={bucket} key={bucket.id} observedAt={snapshot.observedAt} />
      ))}
    </ul>
  );
};

export const ProviderAllowanceStrip = ({
  error,
  loading,
  onRefresh,
  refreshing,
  response,
  surface,
}: ProviderAllowanceStripProps): React.JSX.Element => {
  const { t } = useI18n();
  const snapshot = response?.current;
  const provider =
    snapshot === undefined ? t("providerAllowance.provider") : providerLabels[snapshot.provider];
  const freshness = snapshot?.freshness ?? "UNAVAILABLE";
  const awaitingFirstRead = loading && response === undefined;

  return (
    <section
      aria-label={t(`providerAllowance.surface.${surface}`, { provider })}
      aria-live="polite"
      className={`provider-allowance provider-allowance--${surface} ${awaitingFirstRead ? "is-loading" : `is-${freshness.toLowerCase()}`}`}
    >
      <header className="provider-allowance__header">
        <strong>{t("providerAllowance.title", { provider })}</strong>
        <span className="provider-allowance__freshness">
          <Icon name={awaitingFirstRead ? "spinner" : freshnessIcons[freshness]} size={13} />
          {awaitingFirstRead ? t("providerAllowance.loading") : t(freshnessLabelKeys[freshness])}
        </span>
        <Button
          disabled={loading || refreshing}
          loading={refreshing}
          onClick={onRefresh}
          size="sm"
          type="button"
        >
          {t("providerAllowance.refresh")}
        </Button>
      </header>
      {awaitingFirstRead ? (
        <div
          aria-label={t("providerAllowance.loading")}
          className="provider-allowance__loading"
          role="status"
        >
          <Skeleton width="96px" />
          <Skeleton width="152px" />
        </div>
      ) : response === undefined || snapshot === undefined ? (
        <p className="provider-allowance__unavailable">{t("providerAllowance.unavailable.read")}</p>
      ) : (
        <>
          <AllowanceBody snapshot={snapshot} />
          <Advisory advisory={response.advisory} />
        </>
      )}
      {error !== null ? (
        <p className="provider-allowance__error" role="alert">
          {response === undefined ? t("providerAllowance.error") : t("providerAllowance.errorWithSnapshot")}
        </p>
      ) : null}
    </section>
  );
};

export const ProjectProviderAllowanceStrip = ({
  projectId,
  surface,
}: {
  projectId: string;
  surface: AllowanceSurface;
}): React.JSX.Element => {
  const allowanceQuery = useProjectProviderAllowance(projectId);
  const refreshMutation = useRefreshProjectProviderAllowance();
  return (
    <ProviderAllowanceStrip
      error={refreshMutation.error ?? allowanceQuery.error}
      loading={allowanceQuery.isPending}
      onRefresh={() => {
        refreshMutation.reset();
        refreshMutation.mutate(projectId);
      }}
      refreshing={refreshMutation.isPending}
      response={allowanceQuery.data}
      surface={surface}
    />
  );
};
