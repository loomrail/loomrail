import type { AnonymousReport, LocalProductMetrics } from "@loomrail/contracts";
import { Button, Skeleton } from "@loomrail/ui";

import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type TranslationKey } from "../i18n";
import { downloadAnonymousReport, serializeAnonymousReport } from "../reportDownload";
import { useInsights } from "../workspace";

const rateValue = (value: number | null, noEvidence: string): string =>
  value === null ? noEvidence : `${value.toString()}%`;

const ReportPreview = ({
  description,
  report,
  title,
}: {
  description: string;
  report: AnonymousReport;
  title: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <article className="insights-report">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <pre aria-label={t("insights.report.previewLabel")}>{serializeAnonymousReport(report)}</pre>
      <div className="insights-report__actions">
        <Button
          onClick={() => {
            downloadAnonymousReport(report);
          }}
          size="sm"
        >
          {t("insights.report.download")}
        </Button>
      </div>
    </article>
  );
};

const countRows = (
  metrics: LocalProductMetrics,
): readonly { label: TranslationKey; value: string | number }[] => [
  {
    label: "insights.count.workItems",
    value: `${metrics.workItems.accepted.toString()} / ${metrics.workItems.total.toString()}`,
  },
  {
    label: "insights.count.activeWork",
    value: metrics.workItems.active,
  },
  {
    label: "insights.count.cancelledWork",
    value: metrics.workItems.cancelled,
  },
  {
    label: "insights.count.pipelines",
    value: `${metrics.pipelineRuns.succeeded.toString()} / ${metrics.pipelineRuns.total.toString()}`,
  },
  {
    label: "insights.count.pipelineFailures",
    value: metrics.pipelineRuns.failed + metrics.pipelineRuns.interrupted + metrics.pipelineRuns.cancelled,
  },
  {
    label: "insights.count.agentRuns",
    value: `${metrics.agentRuns.succeeded.toString()} / ${metrics.agentRuns.total.toString()}`,
  },
  {
    label: "insights.count.agentFailures",
    value: metrics.agentRuns.failed + metrics.agentRuns.interrupted,
  },
  {
    label: "insights.count.reviews",
    value: metrics.reviews.total,
  },
  {
    label: "insights.count.qaRuns",
    value: metrics.qa.total,
  },
  {
    label: "insights.count.qaDefects",
    value: `${metrics.qa.defectsOpen.toString()} / ${(
      metrics.qa.defectsOpen +
      metrics.qa.defectsResolved +
      metrics.qa.defectsWaived
    ).toString()}`,
  },
  {
    label: "insights.count.humanRequests",
    value: `${metrics.humanRequests.resolved.toString()} / ${metrics.humanRequests.total.toString()}`,
  },
  {
    label: "insights.count.tokens",
    value: metrics.usage.estimatedTokens,
  },
  {
    label: "insights.count.recoveries",
    value: metrics.reliability.daemonRestartRecoveries,
  },
];

export const InsightsPage = (): React.JSX.Element => {
  const { locale, t } = useI18n();
  const insightsQuery = useInsights();

  if (insightsQuery.isPending) {
    return (
      <div aria-busy="true" aria-label={t("insights.loading")} className="insights">
        <header className="insights__header">
          <div>
            <Skeleton width="120px" />
            <Skeleton width="360px" />
          </div>
        </header>
        <div className="insights__skeleton">
          <Skeleton width="100%" />
          <Skeleton width="100%" />
          <Skeleton width="100%" />
        </div>
      </div>
    );
  }

  if (insightsQuery.error) {
    return (
      <div className="insights insights--state">
        <LocalConnectionRecovery
          error={insightsQuery.error}
          onRetry={() => void insightsQuery.refetch()}
          retrying={insightsQuery.isFetching}
        />
      </div>
    );
  }

  const insights = insightsQuery.data;
  const metrics = insights.localMetrics;
  const formatter = new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US");

  return (
    <div className="insights">
      <header className="insights__header">
        <div>
          <h1>{t("insights.title")}</h1>
          <p>{t("insights.description")}</p>
        </div>
        <span>{t("insights.localOnly")}</span>
      </header>

      <section aria-labelledby="insights-outcomes" className="insights__section">
        <div className="insights__section-heading">
          <h2 id="insights-outcomes">{t("insights.outcomes.title")}</h2>
          <p>{t("insights.outcomes.description")}</p>
        </div>
        <dl className="insights-rates">
          {[
            ["insights.rate.acceptance", metrics.rates.acceptedCompletionPercent],
            ["insights.rate.firstReview", metrics.rates.firstPassReviewPercent],
            ["insights.rate.qa", metrics.rates.terminalQaPassPercent],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{t(label as TranslationKey)}</dt>
              <dd>{rateValue(value as number | null, t("insights.noEvidence"))}</dd>
            </div>
          ))}
        </dl>
        <dl className="insights-counts">
          {countRows(metrics).map((row) => (
            <div key={row.label}>
              <dt>{t(row.label)}</dt>
              <dd>{typeof row.value === "number" ? formatter.format(row.value) : row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="insights-reports" className="insights__section">
        <div className="insights__section-heading">
          <h2 id="insights-reports">{t("insights.report.title")}</h2>
          <p>{t("insights.report.description")}</p>
          <p className="insights__exclusions">{t("insights.report.exclusions")}</p>
        </div>
        <ReportPreview
          description={t("insights.report.aggregateDescription")}
          report={insights.aggregateReport}
          title={t("insights.report.aggregate")}
        />
        {insights.crashReport === null ? (
          <p className="insights__empty-report">{t("insights.report.noCrash")}</p>
        ) : (
          <ReportPreview
            description={t("insights.report.crashDescription")}
            report={insights.crashReport}
            title={t("insights.report.crash")}
          />
        )}
      </section>
    </div>
  );
};
