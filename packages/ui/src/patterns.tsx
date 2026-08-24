import type { HTMLAttributes, ReactNode } from "react";

import {
  Avatar,
  Badge,
  Button,
  cn,
  ProgressBar,
  Status,
  type BadgeTone,
  type StatusTone,
} from "./foundation.js";
import { Icon, type IconName } from "./icons.js";

export type TaskCardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  active?: boolean;
  agent?: string;
  badge?: { label: string; tone?: BadgeTone };
  description?: string;
  id: string;
  meta?: string;
  progress?: number;
  provider?: string;
  selected?: boolean;
  title: string;
};

export const TaskCard = ({
  active = false,
  agent,
  badge,
  className,
  description,
  id,
  meta,
  progress,
  provider,
  selected = false,
  title,
  ...props
}: TaskCardProps): React.JSX.Element => (
  <article
    className={cn("lr-task-card", active && "is-active", selected && "is-selected", className)}
    {...props}
  >
    <div className="lr-task-card__header">
      <span>{id}</span>
      {badge ? (
        <Badge tone={badge.tone ?? "neutral"}>{badge.label}</Badge>
      ) : provider ? (
        <Badge>{provider}</Badge>
      ) : null}
    </div>
    <strong className="lr-task-card__title">{title}</strong>
    {description ? <p>{description}</p> : null}
    {progress !== undefined ? <ProgressBar label={`${title} progress`} value={progress} /> : null}
    <footer>
      <span className="lr-task-card__agent">
        {agent ? <Avatar label={agent} /> : null}
        {meta}
      </span>
      {active ? <span className="lr-task-card__live">now</span> : null}
    </footer>
  </article>
);

export type KanbanColumnProps = {
  addLabel?: string;
  children: ReactNode;
  count: number;
  label: string;
  onAdd?: () => void;
  tone: StatusTone;
};

export const KanbanColumn = ({
  addLabel,
  children,
  count,
  label,
  onAdd,
  tone,
}: KanbanColumnProps): React.JSX.Element => (
  <section className="lr-kanban-column">
    <header>
      <Status label={label} tone={tone} />
      <span className="lr-kanban-column__count">{count}</span>
      <Button
        aria-label={addLabel ?? `Add task to ${label}`}
        className="lr-kanban-column__add"
        disabled={onAdd === undefined}
        onClick={onAdd}
        size="sm"
      >
        <Icon name="add" size={13} />
      </Button>
    </header>
    <div className="lr-kanban-column__stack">{children}</div>
  </section>
);

export type HumanRequestRowProps = {
  description: string;
  id: string;
  onAnswer?: () => void;
  provider: string;
  title: string;
};

export const HumanRequestRow = ({
  description,
  id,
  onAnswer,
  provider,
  title,
}: HumanRequestRowProps): React.JSX.Element => (
  <section className="lr-human-request">
    <span aria-hidden="true" className="lr-human-request__icon">
      <Icon name="question" size={15} />
    </span>
    <div>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
    <span className="lr-human-request__meta">
      {id} · {provider}
    </span>
    <Button disabled={onAnswer === undefined} onClick={onAnswer} shape="pill" size="sm" variant="secondary">
      Answer
    </Button>
  </section>
);

export type BudgetMeterProps = {
  limit: number;
  label?: string;
  used: number;
};

export const BudgetMeter = ({ label = "Budget", limit, used }: BudgetMeterProps): React.JSX.Element => {
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return (
    <div className="lr-budget-meter">
      <div>
        <span>{label}</span>
        <strong>
          {(used / 1000).toFixed(1)}k / {(limit / 1000).toFixed(0)}k
        </strong>
      </div>
      <ProgressBar label={`${label} used`} value={percentage} />
    </div>
  );
};

export type TimelineEventProps = {
  detail?: string;
  icon?: IconName;
  label: string;
  time: string;
  tone?: "neutral" | "accent" | "success" | "warning";
};

export const TimelineEvent = ({
  detail,
  icon = "check",
  label,
  time,
  tone = "neutral",
}: TimelineEventProps): React.JSX.Element => (
  <div className={cn("lr-timeline-event", `lr-timeline-event--${tone}`)}>
    <span aria-hidden="true" className="lr-timeline-event__icon">
      <Icon name={icon} size={12} />
    </span>
    <div>
      <strong>{label}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
    <time>{time}</time>
  </div>
);

export type InspectorSectionProps = {
  action?: ReactNode;
  children: ReactNode;
  title: string;
};

export const InspectorSection = ({ action, children, title }: InspectorSectionProps): React.JSX.Element => (
  <section className="lr-inspector-section">
    <header>
      <strong>{title}</strong>
      {action}
    </header>
    <div className="lr-inspector-section__body">{children}</div>
  </section>
);

export type SummaryProperty = {
  label: string;
  value: ReactNode;
};

export type RunSummaryProps = {
  properties: readonly SummaryProperty[];
};

export const RunSummary = ({ properties }: RunSummaryProps): React.JSX.Element => (
  <dl className="lr-run-summary">
    {properties.map((property) => (
      <div key={property.label}>
        <dt>{property.label}</dt>
        <dd>{property.value}</dd>
      </div>
    ))}
  </dl>
);
