import { useState } from "react";

import type { HumanRequest } from "@loomrail/contracts";
import { Button, Icon, RadioGroup, TextField } from "@loomrail/ui";

import { useI18n } from "../i18n";
import { useAnswerHumanRequest } from "../workspace";
import { LocalConnectionRecovery } from "./LocalConnectionRecovery";

export const HumanRequestAnswerForm = ({
  onAnswered,
  request,
  showTitle = true,
}: {
  onAnswered?: () => void;
  request: HumanRequest;
  showTitle?: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const answerMutation = useAnswerHumanRequest();
  const [selection, setSelection] = useState("");
  const [otherText, setOtherText] = useState("");
  const otherSelected = selection === "__other__";
  const canSubmit = otherSelected ? otherText.trim().length > 0 : selection.length > 0;

  const submit = (): void => {
    if (!canSubmit) return;
    answerMutation.mutate(
      {
        request,
        answer: otherSelected
          ? { type: "OTHER", text: otherText.trim() }
          : { type: "OPTION", optionIds: [selection] },
      },
      {
        onSuccess: () => {
          setSelection("");
          setOtherText("");
          onAnswered?.();
        },
      },
    );
  };

  return (
    <div className="human-request-card">
      <div className="human-request-card__eyebrow">
        <Icon name="question" size={13} />
        <span>{t(request.blocking ? "humanRequest.blocking" : "humanRequest.request")}</span>
      </div>
      {showTitle ? <h3>{request.title}</h3> : null}
      <p>{request.context}</p>
      {request.recommendation ? (
        <div className="human-request-card__recommendation">
          <strong>{t("humanRequest.recommendation")}</strong>
          <span>{request.recommendation}</span>
        </div>
      ) : null}
      <RadioGroup
        aria-label={request.title}
        onValueChange={setSelection}
        options={[
          ...request.options.map((option) => ({
            value: option.id,
            label: option.recommended ? `${option.label} · ${t("humanRequest.recommended")}` : option.label,
            description: option.consequence,
          })),
          ...(request.allowOther ? [{ value: "__other__", label: t("humanRequest.other") }] : []),
        ]}
        value={selection}
      />
      {otherSelected ? (
        <TextField
          aria-label={t("humanRequest.other")}
          autoFocus
          maxLength={2_000}
          onChange={(event) => {
            setOtherText(event.currentTarget.value);
          }}
          placeholder={t("humanRequest.otherPlaceholder")}
          value={otherText}
        />
      ) : null}
      {!canSubmit && selection ? (
        <span className="human-request-card__hint">{t("humanRequest.chooseAnswer")}</span>
      ) : null}
      {answerMutation.error ? (
        <LocalConnectionRecovery
          error={answerMutation.error}
          onRetry={submit}
          retrying={answerMutation.isPending}
        />
      ) : null}
      <Button disabled={!canSubmit} loading={answerMutation.isPending} onClick={submit} variant="primary">
        {t("humanRequest.answerResume")}
      </Button>
    </div>
  );
};
