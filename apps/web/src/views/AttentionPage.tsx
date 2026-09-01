import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { AttentionItem, AttentionSection } from "@loomrail/contracts";
import { Badge, Button, FeedbackState, Icon, Skeleton } from "@loomrail/ui";

import { groupAttentionItems, nextAttentionIndex, type AttentionNavigationKey } from "../attentionView";
import { HumanRequestAnswerForm } from "../components/HumanRequestAnswerForm";
import { LocalConnectionRecovery } from "../components/LocalConnectionRecovery";
import { useI18n, type TranslationKey } from "../i18n";
import { useAttentionInbox, useWorkspace } from "../workspace";

const navigationKeys = new Set<AttentionNavigationKey>(["ArrowDown", "ArrowUp", "End", "Home"]);

const sectionKey = (section: AttentionSection): TranslationKey => `attention.section.${section}`;

const categoryKey = (category: AttentionItem["category"]): TranslationKey => `attention.category.${category}`;

const priorityKey = (priority: AttentionItem["workItem"]["priority"]): TranslationKey =>
  `priority.${priority}`;

const stageKey = (stage: AttentionItem["stage"]["name"]): TranslationKey => `stage.${stage}`;

export const AttentionPage = (): React.JSX.Element => {
  const { locale, t } = useI18n();
  const navigate = useNavigate({ from: "/attention" });
  const { selectProject } = useWorkspace();
  const attentionQuery = useAttentionInbox();
  const items = attentionQuery.data?.items ?? [];
  const groups = useMemo(() => groupAttentionItems(items), [items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedItem = items.find(({ id }) => id === selectedId) ?? items.at(0) ?? null;

  useEffect(() => {
    if (selectedItem?.id !== selectedId) setSelectedId(selectedItem?.id ?? null);
  }, [selectedId, selectedItem?.id]);

  const openTask = (item: AttentionItem): void => {
    selectProject(item.project.id);
    void navigate({
      to: "/",
      search: { project: item.project.id, task: item.workItem.id },
    });
  };

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, item: AttentionItem): void => {
    if (!navigationKeys.has(event.key as AttentionNavigationKey)) return;
    event.preventDefault();
    const currentIndex = items.findIndex(({ id }) => id === item.id);
    const nextIndex = nextAttentionIndex(currentIndex, event.key as AttentionNavigationKey, items.length);
    const next = items[nextIndex];
    if (!next) return;
    setSelectedId(next.id);
    itemRefs.current.get(next.id)?.focus();
  };

  if (attentionQuery.isPending) {
    return (
      <div aria-busy="true" aria-label={t("attention.loading")} className="attention-inbox">
        <section className="attention-inbox__index">
          <header className="attention-inbox__heading">
            <Skeleton width="120px" />
            <Skeleton width="42px" />
          </header>
          <div className="attention-inbox__skeleton">
            <Skeleton width="34%" />
            <Skeleton width="90%" />
            <Skeleton width="70%" />
          </div>
        </section>
        <section className="attention-inbox__detail">
          <div className="attention-inbox__skeleton">
            <Skeleton width="54%" />
            <Skeleton width="86%" />
            <Skeleton width="72%" />
          </div>
        </section>
      </div>
    );
  }

  if (attentionQuery.error) {
    return (
      <div className="attention-inbox attention-inbox--state">
        <LocalConnectionRecovery
          error={attentionQuery.error}
          onRetry={() => void attentionQuery.refetch()}
          retrying={attentionQuery.isFetching}
        />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="attention-inbox attention-inbox--state">
        <div>
          <h1 className="lr-visually-hidden">{t("attention.inboxTitle")}</h1>
          <FeedbackState description={t("attention.emptyDescription")} title={t("attention.emptyTitle")} />
        </div>
      </div>
    );
  }

  return (
    <div className="attention-inbox">
      <section aria-label={t("attention.listLabel")} className="attention-inbox__index">
        <header className="attention-inbox__heading">
          <div>
            <h1>{t("attention.inboxTitle")}</h1>
            <p>{t("attention.inboxDescription")}</p>
          </div>
          <Badge tone={items.some(({ request }) => request.blocking) ? "warning" : "neutral"}>
            {items.length.toString()}
            {attentionQuery.data.hasMore ? "+" : ""}
          </Badge>
        </header>

        {attentionQuery.isFetching ? (
          <p className="attention-inbox__refresh" role="status">
            {t("attention.refreshing")}
          </p>
        ) : null}

        <div className="attention-groups">
          {groups.map((group) => (
            <section className="attention-group" key={group.section}>
              <h2>
                <span>{t(sectionKey(group.section))}</span>
                <span>{group.items.length}</span>
              </h2>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button
                      aria-current={selectedItem?.id === item.id ? "true" : undefined}
                      className="attention-row"
                      onClick={() => {
                        setSelectedId(item.id);
                      }}
                      onDoubleClick={() => {
                        openTask(item);
                      }}
                      onKeyDown={(event) => {
                        moveSelection(event, item);
                      }}
                      ref={(node) => {
                        if (node) itemRefs.current.set(item.id, node);
                        else itemRefs.current.delete(item.id);
                      }}
                      type="button"
                    >
                      <span className="attention-row__title">{item.request.title}</span>
                      <span className="attention-row__context">
                        {item.project.name} · {item.workItem.title}
                      </span>
                      <span className="attention-row__meta">
                        {t(categoryKey(item.category))} · {t(stageKey(item.stage.name))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {attentionQuery.data.hasMore ? (
          <p className="attention-inbox__limit" role="status">
            {t("attention.limitReached")}
          </p>
        ) : null}
      </section>

      <section aria-live="polite" className="attention-inbox__detail">
        {selectedItem ? (
          <div className="attention-detail" key={selectedItem.id}>
            <header>
              <div className="attention-detail__context">
                <span>{selectedItem.project.name}</span>
                <Icon name="chevronRight" size={12} />
                <span>{selectedItem.workItem.title}</span>
              </div>
              <h2>{selectedItem.request.title}</h2>
            </header>

            <dl className="attention-detail__facts">
              <div>
                <dt>{t("attention.fact.category")}</dt>
                <dd>{t(categoryKey(selectedItem.category))}</dd>
              </div>
              <div>
                <dt>{t("attention.fact.priority")}</dt>
                <dd>{t(priorityKey(selectedItem.workItem.priority))}</dd>
              </div>
              <div>
                <dt>{t("attention.fact.stage")}</dt>
                <dd>{t(stageKey(selectedItem.stage.name))}</dd>
              </div>
              <div>
                <dt>{t("attention.fact.created")}</dt>
                <dd>
                  <time dateTime={selectedItem.request.createdAt}>
                    {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(selectedItem.request.createdAt))}
                  </time>
                </dd>
              </div>
            </dl>

            {selectedItem.action === "ANSWER_REQUEST" ? (
              <HumanRequestAnswerForm request={selectedItem.request} showTitle={false} />
            ) : (
              <div className="attention-detail__acceptance">
                <div>
                  <strong>{t("attention.acceptanceTitle")}</strong>
                  <p>{t("attention.acceptanceDescription")}</p>
                </div>
                <Button
                  onClick={() => {
                    openTask(selectedItem);
                  }}
                  trailingIcon="chevronRight"
                  variant="primary"
                >
                  {t("attention.reviewAcceptance")}
                </Button>
              </div>
            )}

            {selectedItem.action === "ANSWER_REQUEST" ? (
              <Button
                className="attention-detail__open-task"
                onClick={() => {
                  openTask(selectedItem);
                }}
                variant="secondary"
              >
                {t("attention.openTask")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};
