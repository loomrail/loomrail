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

// Spec D5's nesting: a stage attempt is now a sequence of provider sessions, and the cockpit is
// obligated to show it or a stalled provider becomes invisible. Every string here arrives already
// formatted -- this component owns layout and disclosure, not wording or locale, matching every
// other pattern in this file.
export type CheckpointGroup = {
  items: readonly string[];
  label: string;
};

export type CheckpointViewModel = {
  defaultOpen?: boolean;
  groups: readonly CheckpointGroup[];
  id: string;
  summary: string;
  timeLabel: string;
};

export type ProviderSessionViewModel = {
  // Read by assistive tech in place of the bare ordinal digit the badge shows sighted readers, so
  // "session 1" survives being announced without the visual numbering it leans on.
  ariaLabel: string;
  checkpoints: readonly CheckpointViewModel[];
  emptyCheckpointsLabel?: string;
  handoffRequestedLabel?: string;
  id: string;
  occupancyLabel?: string;
  occupancyPercent?: number;
  // How the occupancy number was arrived at (spec §4.3, §5.2): a measured 92% and a guessed 92%
  // render identically without it, and the two mean different things to an owner deciding whether
  // a session was cut too early. Optional for the same reason `occupancyLabel` is -- a session that
  // never crossed the handoff threshold has no occupancy to qualify.
  occupancyQualityLabel?: string;
  usageCostLabel?: string;
  usageLabel?: string;
  usageQualityLabel?: string;
  ordinal: number;
  statusLabel: string;
  tone: StatusTone;
};

// D5's other half of the nesting fix: a sessions list with no attempt identity reads as belonging
// to whichever attempt the owner was last looking at, which stops being true the moment a second
// attempt exists (e.g. a budget-override retry). `heading` and `statusLabel` arrive pre-formatted
// for the same reason every other string in this file does; `tone` pairs with `statusLabel` through
// `Status` so the attempt's status is never conveyed by colour alone.
export type ProviderSessionTimelineAttempt = {
  heading: string;
  statusLabel: string;
  tone: StatusTone;
};

export type ProviderSessionTimelineProps = {
  // Identifies the attempt these sessions nest under. Optional: a caller with no attempt to name
  // (e.g. a story or preview with synthetic sessions) can omit it rather than fabricate one.
  attempt?: ProviderSessionTimelineAttempt;
  // A short explanatory line shown above the list -- e.g. that this provider cannot wind down on
  // request, so losing a session's tail is expected for it rather than a malfunction (spec §7).
  note?: string;
  sessions: readonly ProviderSessionViewModel[];
  title: string;
};

export const ProviderSessionTimeline = ({
  attempt,
  note,
  sessions,
  title,
}: ProviderSessionTimelineProps): React.JSX.Element => (
  <div className="lr-session-timeline-panel">
    {attempt ? (
      <div className="lr-session-timeline__row">
        <strong className="lr-session-timeline-panel__title">{attempt.heading}</strong>
        <Status label={attempt.statusLabel} tone={attempt.tone} />
      </div>
    ) : null}
    {/* Subordinate to the attempt heading above it -- "Sessions" names the list, it doesn't own the
        panel. When there's no attempt to nest under (a caller with no attempt to name, e.g. a story
        or preview), title is promoted back to the panel's heading rather than left visually orphaned. */}
    <strong className={attempt ? "lr-session-timeline-panel__subtitle" : "lr-session-timeline-panel__title"}>
      {title}
    </strong>
    {note ? <p className="lr-session-timeline-panel__note">{note}</p> : null}
    <ol className="lr-session-timeline">
      {sessions.map((session) => (
        <li aria-label={session.ariaLabel} className="lr-session-timeline__item" key={session.id}>
          <span aria-hidden="true" className="lr-session-timeline__ordinal">
            {session.ordinal}
          </span>
          <div className="lr-session-timeline__body">
            <div className="lr-session-timeline__row">
              <Status label={session.statusLabel} tone={session.tone} />
              {session.handoffRequestedLabel ? (
                <Badge tone="warning">{session.handoffRequestedLabel}</Badge>
              ) : null}
            </div>
            {session.occupancyPercent !== undefined && session.occupancyLabel !== undefined ? (
              <div className="lr-session-timeline__occupancy">
                {/* Presentational: the span beside it carries the same number as text, and an
                    aria-label here made a screen reader announce the figure twice in a row. */}
                <progress aria-hidden="true" max={100} value={session.occupancyPercent} />
                <p className="lr-session-timeline__occupancy-text">
                  <span>{session.occupancyLabel}</span>
                  {session.occupancyQualityLabel === undefined ? null : (
                    <span className="lr-session-timeline__occupancy-quality">
                      {session.occupancyQualityLabel}
                    </span>
                  )}
                </p>
              </div>
            ) : null}
            {session.usageLabel === undefined ? null : (
              <p className="lr-session-timeline__usage">
                <span>{session.usageLabel}</span>
                {session.usageCostLabel === undefined ? null : <span>{session.usageCostLabel}</span>}
                {session.usageQualityLabel === undefined ? null : (
                  <span className="lr-session-timeline__usage-quality">{session.usageQualityLabel}</span>
                )}
              </p>
            )}
            {session.checkpoints.length > 0 ? (
              <ul className="lr-session-timeline__checkpoints">
                {session.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.id}>
                    <details className="lr-checkpoint-card" open={checkpoint.defaultOpen}>
                      <summary>
                        {/* Decorative: native <details> already exposes expanded state to
                            assistive tech via <summary>'s button-like role. This is the only
                            persistent (non-hover) sign a sighted reader has that a collapsed
                            checkpoint -- otherwise a plain line of text -- is openable at all. */}
                        <Icon
                          aria-hidden="true"
                          className="lr-checkpoint-card__chevron"
                          name="chevronRight"
                          size={12}
                        />
                        <span>{checkpoint.summary}</span>
                        <time>{checkpoint.timeLabel}</time>
                      </summary>
                      <div className="lr-checkpoint-card__body">
                        {checkpoint.groups.map((group) =>
                          group.items.length > 0 ? (
                            <div key={group.label}>
                              <strong>{group.label}</strong>
                              <ul>
                                {/* Keyed by index+value, not value alone: a checkpoint's lists are
                                    untrusted provider output (spec §8) with no uniqueness
                                    constraint -- schema allows up to 50 free-text entries that may
                                    repeat -- and keying by the repeated string alone would collide
                                    and corrupt React's reconciliation, not just warn. */}
                                {group.items.map((item, index) => (
                                  <li key={`${index.toString()}-${item}`}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            ) : session.emptyCheckpointsLabel ? (
              <p className="lr-session-timeline__empty">{session.emptyCheckpointsLabel}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  </div>
);
