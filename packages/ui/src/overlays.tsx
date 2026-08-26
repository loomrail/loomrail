import { useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import {
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";

import { cn, IconButton, Kbd } from "./foundation.js";
import { Icon, type IconName } from "./icons.js";

export type TooltipProps = {
  children: ReactElement;
  label: string;
  side?: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
};

export const Tooltip = ({ children, label, side = "bottom" }: TooltipProps): React.JSX.Element => (
  <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        asChild
        // Radix opens a tooltip on any focus at all. A popover or dialog hands focus to its first
        // control the moment it opens, so a tooltip on that control would announce itself to an
        // owner who only clicked the overlay open. Focus the browser calls keyboard focus still
        // earns the tooltip; a click that merely lands focus here does not.
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="lr-tooltip" side={side} sideOffset={6}>
          {label}
          <TooltipPrimitive.Arrow className="lr-tooltip__arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
);

export type ActionMenuItem = {
  danger?: boolean;
  disabled?: boolean;
  icon?: IconName;
  label: string;
  onSelect?: () => void;
  shortcut?: string;
};

export type ActionMenuProps = {
  align?: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>["align"];
  contentClassName?: string;
  groups: readonly (readonly ActionMenuItem[])[];
  side?: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>["side"];
  trigger: ReactElement;
  triggerTooltip?: string;
};

export const ActionMenu = ({
  align = "start",
  contentClassName,
  groups,
  side = "bottom",
  trigger,
  triggerTooltip,
}: ActionMenuProps): React.JSX.Element => (
  <DropdownMenuPrimitive.Root>
    {triggerTooltip ? (
      <Tooltip label={triggerTooltip}>
        <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      </Tooltip>
    ) : (
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
    )}
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        className={cn("lr-menu", contentClassName)}
        collisionPadding={8}
        side={side}
        sideOffset={5}
      >
        {groups.map((group, groupIndex) => (
          <div className="lr-menu__group" key={group.map((item) => item.label).join("-")}>
            {group.map((item) => (
              <DropdownMenuPrimitive.Item
                className={cn("lr-menu__item", item.icon && "has-icon", item.danger && "is-danger")}
                disabled={item.disabled === true || item.onSelect === undefined}
                key={item.label}
                {...(item.onSelect === undefined ? {} : { onSelect: item.onSelect })}
              >
                {item.icon ? (
                  <span className="lr-menu__item-icon">
                    <Icon name={item.icon} size={14} />
                  </span>
                ) : null}
                <span>{item.label}</span>
                {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
              </DropdownMenuPrimitive.Item>
            ))}
            {groupIndex < groups.length - 1 ? (
              <DropdownMenuPrimitive.Separator className="lr-menu__separator" />
            ) : null}
          </div>
        ))}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  </DropdownMenuPrimitive.Root>
);

export type PopoverSurfaceProps = {
  align?: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>["align"];
  children: ReactNode;
  className?: string;
  label?: string;
  side?: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>["side"];
  trigger: ReactElement;
  triggerTooltip?: string;
};

export const PopoverSurface = ({
  align = "end",
  children,
  className,
  label,
  side = "bottom",
  trigger,
  triggerTooltip,
}: PopoverSurfaceProps): React.JSX.Element => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <PopoverPrimitive.Root onOpenChange={setOpen} open={open}>
      {triggerTooltip ? (
        <Tooltip label={triggerTooltip}>
          <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
        </Tooltip>
      ) : (
        <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          aria-label={label}
          className={cn("lr-popover", className)}
          collisionPadding={8}
          // Radix hands Escape to the topmost dismissable layer alone, and a tooltip standing over
          // this surface is that layer -- which would leave the surface sitting through the press
          // meant to close it. It answers for its own Escape instead, and only for one pressed on
          // the surface itself: a portalled menu or select still answers for the presses it owns.
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (!(event.target instanceof Node)) return;
            if (!event.currentTarget.contains(event.target)) return;
            setOpen(false);
          }}
          // Radix would arm whichever control sits first inside, ringing it and offering it to the
          // next keypress -- a choice the owner never made by opening the surface. The surface
          // itself takes the focus instead: it still announces its label and Tab still walks in.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          ref={contentRef}
          side={side}
          sideOffset={6}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

export type DialogSurfaceProps = {
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  description?: string;
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  size?: "sm" | "md" | "lg";
  title: string;
  trigger?: ReactElement;
  triggerTooltip?: string;
};

export const DialogSurface = ({
  children,
  className,
  closeLabel = "Close dialog",
  description,
  footer,
  onOpenChange,
  open,
  size = "md",
  title,
  trigger,
  triggerTooltip,
}: DialogSurfaceProps): React.JSX.Element => {
  const contentRef = useRef<HTMLDivElement>(null);
  const rootProps = {
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
    ...(open === undefined ? {} : { open }),
  };

  return (
    <DialogPrimitive.Root {...rootProps}>
      {trigger ? (
        triggerTooltip ? (
          <Tooltip label={triggerTooltip}>
            <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
          </Tooltip>
        ) : (
          <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
        )
      ) : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lr-dialog-overlay" />
        <DialogPrimitive.Content
          className={cn("lr-dialog", `lr-dialog--${size}`, className)}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          ref={contentRef}
          tabIndex={-1}
        >
          <header className="lr-dialog__header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description>{description}</DialogPrimitive.Description> : null}
            </div>
            <Tooltip label={closeLabel}>
              <DialogPrimitive.Close asChild>
                <IconButton label={closeLabel} name="close" size="lg" />
              </DialogPrimitive.Close>
            </Tooltip>
          </header>
          <div className="lr-dialog__body">{children}</div>
          {footer ? <footer className="lr-dialog__footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
