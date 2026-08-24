import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./icons.js";

type ClassValue = string | false | null | undefined;

export const cn = (...values: readonly ClassValue[]): string => values.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "surface";
export type IconButtonVariant = ButtonVariant;
export type ControlSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  loading?: boolean;
  shape?: "rounded" | "pill";
  size?: ControlSize;
  trailingIcon?: IconName;
  variant?: ButtonVariant;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      disabled,
      icon,
      loading = false,
      shape = "rounded",
      size = "md",
      trailingIcon,
      variant = "ghost",
      ...props
    },
    ref,
  ) => (
    <button
      aria-busy={loading}
      className={cn(
        "lr-button",
        `lr-button--${variant}`,
        `lr-button--${shape}`,
        `lr-control--${size}`,
        loading && "is-loading",
        className,
      )}
      disabled={loading || disabled === true}
      ref={ref}
      {...props}
    >
      {icon ? <Icon name={loading ? "spinner" : icon} /> : null}
      <span className={cn("lr-button__content", !icon && loading && "is-visually-loading")}>{children}</span>
      {trailingIcon ? <Icon name={trailingIcon} /> : null}
      {!icon && loading ? <Icon name="spinner" /> : null}
    </button>
  ),
);
Button.displayName = "Button";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  label: string;
  loading?: boolean;
  name: IconName;
  size?: ControlSize;
  variant?: IconButtonVariant;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, disabled, label, loading = false, name, size = "md", variant = "ghost", ...props }, ref) => (
    <button
      aria-busy={loading}
      aria-label={label}
      className={cn("lr-icon-button", `lr-button--${variant}`, `lr-control--${size}`, className)}
      disabled={loading || disabled === true}
      ref={ref}
      {...props}
    >
      <Icon name={loading ? "spinner" : name} />
    </button>
  ),
);
IconButton.displayName = "IconButton";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

export const Badge = ({ className, tone = "neutral", ...props }: BadgeProps): React.JSX.Element => (
  <span className={cn("lr-badge", `lr-badge--${tone}`, className)} {...props} />
);

export type StatusTone = "ready" | "running" | "review" | "waiting" | "paused" | "complete" | "queued";

export type StatusProps = HTMLAttributes<HTMLSpanElement> & {
  label: string;
  tone: StatusTone;
};

export const Status = ({ className, label, tone, ...props }: StatusProps): React.JSX.Element => (
  <span className={cn("lr-status", `lr-status--${tone}`, className)} {...props}>
    <span aria-hidden="true" className="lr-status__icon" />
    <span>{label}</span>
  </span>
);

export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  label: string;
  tone?: "neutral" | "accent" | "success" | "warning";
};

export const Avatar = ({ className, label, tone = "neutral", ...props }: AvatarProps): React.JSX.Element => (
  <span aria-label={label} className={cn("lr-avatar", `lr-avatar--${tone}`, className)} role="img" {...props}>
    {label
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase()}
  </span>
);

export type ProgressBarProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: number;
};

export const ProgressBar = ({ className, label, value, ...props }: ProgressBarProps): React.JSX.Element => {
  const boundedValue = Math.max(0, Math.min(100, value));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={boundedValue}
      className={cn("lr-progress", className)}
      role="progressbar"
      {...props}
    >
      <span style={{ width: `${boundedValue.toString()}%` }} />
    </div>
  );
};

export type SkeletonProps = HTMLAttributes<HTMLSpanElement> & {
  width?: string;
};

export const Skeleton = ({ className, width, ...props }: SkeletonProps): React.JSX.Element => (
  <span className={cn("lr-skeleton", className)} style={width ? { width } : undefined} {...props} />
);

export type FeedbackTone = "empty" | "error" | "offline" | "success";

export type FeedbackStateProps = HTMLAttributes<HTMLDivElement> & {
  action?: ReactNode;
  description: string;
  title: string;
  tone?: FeedbackTone;
};

const feedbackIcons: Record<FeedbackTone, IconName> = {
  empty: "inbox",
  error: "error",
  offline: "monitor",
  success: "success",
};

export const FeedbackState = ({
  action,
  className,
  description,
  title,
  tone = "empty",
  ...props
}: FeedbackStateProps): React.JSX.Element => (
  <div className={cn("lr-feedback", `lr-feedback--${tone}`, className)} {...props}>
    <span aria-hidden="true" className="lr-feedback__icon">
      <Icon name={feedbackIcons[tone]} size={18} />
    </span>
    <div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
    {action ? <div className="lr-feedback__action">{action}</div> : null}
  </div>
);

export const Kbd = ({ className, ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element => (
  <kbd className={cn("lr-kbd", className)} {...props} />
);
