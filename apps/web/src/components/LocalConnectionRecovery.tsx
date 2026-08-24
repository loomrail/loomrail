import { Button, Icon } from "@loomrail/ui";

import { isLocalApiError } from "../api";
import { useI18n } from "../i18n";

type LocalConnectionRecoveryProps = {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The local operation could not be completed";

export const LocalConnectionRecovery = ({
  error,
  onRetry,
  retrying = false,
}: LocalConnectionRecoveryProps): React.JSX.Element => {
  const { t } = useI18n();
  const recovery = isLocalApiError(error) ? error.recovery : "none";

  if (recovery === "none") {
    return (
      <p className="local-operation-error" role="alert">
        {errorMessage(error)}
      </p>
    );
  }

  const reopen = recovery === "reopen";
  return (
    <section className="local-connection-recovery" role="alert">
      <span aria-hidden="true" className="local-connection-recovery__icon">
        <Icon name={reopen ? "terminal" : "warning"} size={16} />
      </span>
      <div>
        <strong>{t(reopen ? "connection.recovery.reopenTitle" : "connection.recovery.retryTitle")}</strong>
        <p>{t(reopen ? "connection.recovery.reopenDescription" : "connection.recovery.retryDescription")}</p>
        {reopen ? (
          <div className="local-connection-recovery__command">
            <span>{t("connection.recovery.command")}</span>
            <code>pnpm dev</code>
          </div>
        ) : null}
      </div>
      {!reopen && onRetry ? (
        <Button loading={retrying} onClick={onRetry} size="sm" variant="secondary">
          {t("connection.recovery.retryAction")}
        </Button>
      ) : null}
    </section>
  );
};
