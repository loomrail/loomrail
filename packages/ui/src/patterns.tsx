import type { HTMLAttributes, ReactNode } from "react";

import { Avatar, Badge, Button, cn, Status, type BadgeTone, type StatusTone } from "./foundation.js";
import { Icon, type IconName } from "./icons.js";

export type TaskCardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  agent?: string;
  badge?: { label: string; tone?: BadgeTone };
  description?: string;
  id: string;
  meta?: string;
  selected?: boolean;
  title: string;
};

export const TaskCard = ({
  agent,
  badge,
  className,
  description,
  id,
  meta,
  selected = false,
  title,
  ...props
}: TaskCardProps): React.JSX.Element => (
  <article className={cn("lr-task-card", selected && "is-selected", className)} {...props}>
    <div className="lr-task-card__header">
      <span>{id}</span>
      {badge ? <Badge tone={badge.tone ?? "neutral"}>{badge.label}</Badge> : null}
    </div>
    <strong className="lr-task-card__title">{title}</strong>
    {description ? <p>{description}</p> : null}
    <footer>
      <span className="lr-task-card__agent">
        {agent ? <Avatar label={agent} /> : null}
        {meta}
      </span>
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
      {onAdd ? (
        <Button
          aria-label={addLabel ?? `Add task to ${label}`}
          className="lr-kanban-column__add"
          onClick={onAdd}
          size="sm"
        >
          <Icon name="add" size={13} />
        </Button>
      ) : null}
    </header>
    <div className="lr-kanban-column__stack">{children}</div>
  </section>
);

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
