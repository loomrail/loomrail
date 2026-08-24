import { forwardRef, useId, useMemo, useState } from "react";
import type { ComponentPropsWithoutRef, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import {
  Checkbox as CheckboxPrimitive,
  Popover as PopoverPrimitive,
  RadioGroup as RadioPrimitive,
  Select as SelectPrimitive,
  Slider as SliderPrimitive,
  Switch as SwitchPrimitive,
} from "radix-ui";

import { cn, type ControlSize } from "./foundation.js";
import { Icon, type IconName } from "./icons.js";

export type FieldProps = {
  children: ReactNode;
  description?: string;
  error?: string;
  htmlFor: string;
  label: string;
  required?: boolean;
};

export const Field = ({
  children,
  description,
  error,
  htmlFor,
  label,
  required = false,
}: FieldProps): React.JSX.Element => (
  <div className={cn("lr-field", error && "has-error")}>
    <label className="lr-field__label" htmlFor={htmlFor}>
      {label}
      {required ? <span aria-hidden="true"> *</span> : null}
    </label>
    {children}
    {error ? (
      <span className="lr-field__error" id={`${htmlFor}-error`} role="alert">
        <Icon name="error" size={13} />
        {error}
      </span>
    ) : description ? (
      <span className="lr-field__description" id={`${htmlFor}-description`}>
        {description}
      </span>
    ) : null}
  </div>
);

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  icon?: IconName;
  invalid?: boolean;
  size?: ControlSize;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ className, icon, invalid = false, size = "lg", ...props }, ref) => (
    <span className={cn("lr-text-field", `lr-control--${size}`, invalid && "has-error", className)}>
      {icon ? <Icon name={icon} /> : null}
      <input aria-invalid={invalid} ref={ref} {...props} />
    </span>
  ),
);
TextField.displayName = "TextField";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid = false, ...props }, ref) => (
    <textarea
      aria-invalid={invalid}
      className={cn("lr-textarea", invalid && "has-error", className)}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export type CheckboxProps = ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & {
  description?: string;
  label: string;
};

export const Checkbox = ({
  className,
  description,
  id,
  label,
  ...props
}: CheckboxProps): React.JSX.Element => {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="lr-check-row" htmlFor={controlId}>
      <CheckboxPrimitive.Root className={cn("lr-checkbox", className)} id={controlId} {...props}>
        <CheckboxPrimitive.Indicator>
          <Icon name="check" size={12} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
};

export type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  description?: string;
  label: string;
};

export const Switch = ({ className, description, id, label, ...props }: SwitchProps): React.JSX.Element => {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="lr-switch-row" htmlFor={controlId}>
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <SwitchPrimitive.Root className={cn("lr-switch", className)} id={controlId} {...props}>
        <SwitchPrimitive.Thumb className="lr-switch__thumb" />
      </SwitchPrimitive.Root>
    </label>
  );
};

export type RadioOption = {
  description?: string;
  label: string;
  value: string;
};

export type RadioGroupProps = Omit<ComponentPropsWithoutRef<typeof RadioPrimitive.Root>, "children"> & {
  options: readonly RadioOption[];
};

export const RadioGroup = ({ className, options, ...props }: RadioGroupProps): React.JSX.Element => (
  <RadioPrimitive.Root className={cn("lr-radio-group", className)} {...props}>
    {options.map((option) => (
      <label className="lr-radio-row" key={option.value}>
        <RadioPrimitive.Item className="lr-radio" value={option.value}>
          <RadioPrimitive.Indicator className="lr-radio__indicator" />
        </RadioPrimitive.Item>
        <span>
          <strong>{option.label}</strong>
          {option.description ? <small>{option.description}</small> : null}
        </span>
      </label>
    ))}
  </RadioPrimitive.Root>
);

export type SelectOption = {
  description?: string;
  disabled?: boolean;
  label: string;
  value: string;
};

export type SelectControlVariant = "compact" | "default";

export type SelectControlProps = {
  ariaLabel: string;
  contentClassName?: string;
  defaultValue?: string;
  disabled?: boolean;
  id?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  size?: ControlSize;
  value?: string;
  variant?: SelectControlVariant;
};

export const SelectControl = ({
  ariaLabel,
  contentClassName,
  defaultValue,
  disabled = false,
  id,
  onValueChange,
  options,
  placeholder = "Select…",
  size = "lg",
  value,
  variant = "default",
}: SelectControlProps): React.JSX.Element => {
  const rootProps = {
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(onValueChange === undefined ? {} : { onValueChange }),
    ...(value === undefined ? {} : { value }),
  };

  return (
    <SelectPrimitive.Root disabled={disabled} {...rootProps}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "lr-select-trigger",
          `lr-control--${size}`,
          variant === "compact" && "lr-select-trigger--compact",
        )}
        id={id}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <Icon name="chevronDown" size={13} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={cn(
            "lr-select-content",
            variant === "compact" && "lr-select-content--compact",
            contentClassName,
          )}
          position="popper"
          sideOffset={4}
        >
          <SelectPrimitive.Viewport className="lr-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="lr-select-item"
                key={option.value}
                value={option.value}
                {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
              >
                <span className="lr-select-item__copy">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                <SelectPrimitive.ItemIndicator className="lr-select-item__indicator">
                  <Icon name="check" size={13} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
};

export type ComboboxOption = {
  keywords?: readonly string[];
  label: string;
  value: string;
};

export type ComboboxProps = {
  ariaLabel: string;
  id?: string;
  onValueChange?: (value: string) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  size?: ControlSize;
  value?: string;
};

export const Combobox = ({
  ariaLabel,
  id,
  onValueChange,
  options,
  placeholder = "Search…",
  size = "lg",
  value,
}: ComboboxProps): React.JSX.Element => {
  const optionsId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      [option.label, option.value, ...(option.keywords ?? [])].some((candidate) =>
        candidate.toLowerCase().includes(normalized),
      ),
    );
  }, [options, query]);

  return (
    <PopoverPrimitive.Root onOpenChange={setOpen} open={open}>
      <PopoverPrimitive.Trigger asChild>
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className={cn("lr-combobox-trigger", `lr-control--${size}`)}
          id={id}
          type="button"
        >
          <span className={selected ? undefined : "is-placeholder"}>{selected?.label ?? placeholder}</span>
          <Icon name="chevronDown" size={13} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align="start" className="lr-combobox-content" sideOffset={4}>
          <div className="lr-combobox-search">
            <Icon name="search" size={14} />
            <input
              aria-controls={optionsId}
              aria-expanded={open}
              aria-label={ariaLabel}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              placeholder={placeholder}
              role="combobox"
              value={query}
            />
          </div>
          <div className="lr-combobox-options" id={optionsId} role="listbox">
            {filtered.length > 0 ? (
              filtered.map((option) => (
                <button
                  aria-selected={option.value === value}
                  className="lr-combobox-option"
                  key={option.value}
                  onClick={() => {
                    onValueChange?.(option.value);
                    setOpen(false);
                    setQuery("");
                  }}
                  role="option"
                  type="button"
                >
                  <span>{option.label}</span>
                  {option.value === value ? <Icon name="check" size={13} /> : null}
                </button>
              ))
            ) : (
              <span className="lr-combobox-empty">No matches</span>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

export type BudgetSliderProps = {
  label: string;
  max: number;
  min?: number;
  onValueChange?: (value: number) => void;
  step?: number;
  value: number;
};

export const BudgetSlider = ({
  label,
  max,
  min = 0,
  onValueChange,
  step = 1,
  value,
}: BudgetSliderProps): React.JSX.Element => (
  <div className="lr-budget-slider">
    <div>
      <span>{label}</span>
      <output>{value.toLocaleString()} tokens</output>
    </div>
    <SliderPrimitive.Root
      aria-label={label}
      className="lr-slider"
      max={max}
      min={min}
      onValueChange={(values) => {
        const next = values[0];
        if (next !== undefined) onValueChange?.(next);
      }}
      step={step}
      value={[value]}
    >
      <SliderPrimitive.Track className="lr-slider__track">
        <SliderPrimitive.Range className="lr-slider__range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="lr-slider__thumb" />
    </SliderPrimitive.Root>
  </div>
);
