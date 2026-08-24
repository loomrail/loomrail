import { cloneElement, Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactElement, ReactNode, Ref, RefObject } from "react";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";

import { Button, cn, IconButton } from "./foundation.js";
import { Icon, type IconName } from "./icons.js";

export type FilterNode = {
  children?: readonly FilterNode[];
  count?: number;
  description?: string;
  dividerBefore?: boolean;
  icon?: IconName;
  id: string;
  label: string;
};

export type FilterMessages = {
  add: string;
  addFilterPlaceholder: string;
  backTo: string;
  clear: string;
  close: string;
  description: string;
  edit: string;
  filterPlaceholder: string;
  is: string;
  isAnyOf: string;
  noMatchingProperties: string;
  noMatchingValues: string;
  oneValue: string;
  options: string;
  remove: string;
  rootTitle: string;
  search: string;
  selectedValues: string;
};

const defaultFilterMessages: FilterMessages = {
  add: "Add",
  addFilterPlaceholder: "Add Filter…",
  backTo: "Back to",
  clear: "Clear",
  close: "Close filters",
  description: "Choose one or more task properties. Each selection is applied immediately.",
  edit: "Edit",
  filterPlaceholder: "Filter…",
  is: "is",
  isAnyOf: "is any of",
  noMatchingProperties: "No matching properties",
  noMatchingValues: "No matching values",
  oneValue: "1 value",
  options: "options",
  remove: "Remove",
  rootTitle: "Filters",
  search: "Search",
  selectedValues: "selected values",
};

export type CascadingFilterProps = {
  ariaLabel: string;
  defaultValue?: readonly string[];
  messages?: Partial<FilterMessages>;
  onValueChange?: (value: readonly string[]) => void;
  options: readonly FilterNode[];
  trigger: ReactElement;
  value?: readonly string[];
};

export type AppliedFilterBarProps = {
  addFilter: ReactNode;
  ariaLabel: string;
  className?: string;
  messages?: Partial<FilterMessages>;
  onValueChange: (value: readonly string[]) => void;
  options: readonly FilterNode[];
  value: readonly string[];
};

type FilterColumn = {
  key: string;
  nodes: readonly FilterNode[];
  path: readonly string[];
  title: string;
};

type AppliedFilterGroup = {
  icon: IconName | undefined;
  id: string;
  label: string;
  options: readonly FilterNode[];
  selected: readonly FilterNode[];
};

const mobileFilterQuery = "(max-width: 760px)";
const filterHoverIntentDelay = 80;
const rootFilterPanelOffset = 187;
const nestedFilterPanelStride = 197;

const subscribeToMobileFilter = (onStoreChange: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const mediaQuery = window.matchMedia(mobileFilterQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => {
    mediaQuery.removeEventListener("change", onStoreChange);
  };
};

const getMobileFilterSnapshot = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(mobileFilterQuery).matches;

const getMobileFilterServerSnapshot = (): boolean => false;

const pathKey = (path: readonly string[]): string => (path.length === 0 ? "root" : path.join("/"));

const getColumns = (
  options: readonly FilterNode[],
  path: readonly string[],
  rootTitle: string,
): readonly FilterColumn[] => {
  const columns: FilterColumn[] = [{ key: "root", nodes: options, path: [], title: rootTitle }];
  let currentNodes = options;

  for (const [index, nodeId] of path.entries()) {
    const node = currentNodes.find((candidate) => candidate.id === nodeId);
    if (!node?.children || node.children.length === 0) {
      break;
    }

    const nextPath = path.slice(0, index + 1);
    columns.push({
      key: pathKey(nextPath),
      nodes: node.children,
      path: nextPath,
      title: node.label,
    });
    currentNodes = node.children;
  }

  return columns;
};

const estimateFilterPanelHeight = (nodes: readonly FilterNode[]): number =>
  Math.min(
    707,
    50 +
      nodes.reduce(
        (height, node) => height + (node.dividerBefore ? 12 : 0) + (node.description ? 46 : 32),
        0,
      ),
  );

const getOrderedLeafIds = (nodes: readonly FilterNode[]): readonly string[] =>
  nodes.flatMap((node) =>
    node.children && node.children.length > 0 ? getOrderedLeafIds(node.children) : [node.id],
  );

const orderSelectedLeafIds = (
  options: readonly FilterNode[],
  selected: readonly string[],
): readonly string[] => getOrderedLeafIds(options).filter((nodeId) => selected.includes(nodeId));

const getAppliedFilterGroups = (
  options: readonly FilterNode[],
  selected: readonly string[],
): readonly AppliedFilterGroup[] => {
  const groups = new Map<string, AppliedFilterGroup>();

  const visit = (nodes: readonly FilterNode[], parent: FilterNode | undefined): void => {
    nodes.forEach((node) => {
      if (node.children && node.children.length > 0) {
        visit(node.children, node);
        return;
      }

      if (!selected.includes(node.id)) {
        return;
      }

      const owner = parent ?? node;
      const current = groups.get(owner.id);
      groups.set(owner.id, {
        icon: owner.icon,
        id: owner.id,
        label: owner.label,
        options: owner.children ?? [node],
        selected: current ? [...current.selected, node] : [node],
      });
    });
  };

  visit(options, undefined);
  return [...groups.values()];
};

const focusRelativeItem = (event: KeyboardEvent<HTMLButtonElement>, direction: -1 | 1): void => {
  const list = event.currentTarget.closest(".lr-filter-list");
  if (!list) {
    return;
  }

  const items = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-filter-item]"));
  const currentIndex = items.indexOf(event.currentTarget);
  const nextIndex = (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
};

const focusBoundaryItem = (event: KeyboardEvent<HTMLButtonElement>, position: "first" | "last"): void => {
  const list = event.currentTarget.closest(".lr-filter-list");
  if (!list) {
    return;
  }

  const items = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-filter-item]"));
  const item = position === "first" ? items[0] : items.at(-1);
  item?.focus();
};

type FilterLevelProps = {
  activeChildId: string | undefined;
  column: FilterColumn;
  floatingPosition?: {
    height: number;
    right: number;
    top: number;
  };
  mobile?: boolean;
  messages: FilterMessages;
  onBack: () => void;
  onOpenBranch: (
    node: FilterNode,
    column: FilterColumn,
    moveFocus?: boolean,
    anchor?: HTMLButtonElement,
  ) => void;
  onQueryChange: (key: string, value: string) => void;
  onToggle: (nodeId: string, closeAfter: boolean) => void;
  query: string;
  searchRef: RefObject<HTMLInputElement | null> | undefined;
  selected: readonly string[];
};

const FilterLevel = ({
  activeChildId,
  column,
  floatingPosition,
  mobile = false,
  messages,
  onBack,
  onOpenBranch,
  onQueryChange,
  onToggle,
  query,
  searchRef,
  selected,
}: FilterLevelProps): React.JSX.Element => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleNodes = column.nodes.filter((node) =>
    `${node.label} ${node.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
  );

  return (
    <section
      aria-label={column.title}
      className={cn("lr-filter-level", mobile && "lr-filter-level--mobile")}
      data-filter-column={column.key}
      data-filter-depth={column.path.length}
      style={floatingPosition}
    >
      <label className="lr-filter-search">
        <span className="lr-visually-hidden">
          {messages.search} {column.title}
        </span>
        <input
          aria-label={`${messages.search} ${column.title}`}
          onChange={(event) => {
            onQueryChange(column.key, event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") {
              return;
            }

            event.preventDefault();
            event.currentTarget
              .closest(".lr-filter-level")
              ?.querySelector<HTMLButtonElement>("[data-filter-item]")
              ?.focus();
          }}
          placeholder={column.path.length === 0 ? messages.addFilterPlaceholder : messages.filterPlaceholder}
          ref={searchRef}
          spellCheck={false}
          type="search"
          value={query}
        />
      </label>
      <div aria-label={`${column.title} ${messages.options}`} className="lr-filter-list" role="menu">
        {visibleNodes.map((node) => {
          const hasChildren = Boolean(node.children && node.children.length > 0);
          const isActive = hasChildren && activeChildId === node.id;
          const isSelected = !hasChildren && selected.includes(node.id);
          const divider = node.dividerBefore ? (
            <div className="lr-filter-separator" role="separator" />
          ) : null;

          if (!hasChildren) {
            return (
              <Fragment key={node.id}>
                {divider}
                <div className="lr-filter-choice" role="none">
                  <button
                    aria-label={`${isSelected ? messages.remove : messages.add} ${node.label}`}
                    aria-pressed={isSelected}
                    className="lr-filter-choice__checkbox"
                    onClick={() => {
                      onToggle(node.id, false);
                    }}
                    type="button"
                  >
                    {isSelected ? <Icon name="check" size={10} /> : null}
                  </button>
                  <button
                    aria-checked={isSelected}
                    className="lr-filter-item lr-filter-item--choice"
                    data-filter-item
                    data-filter-node={node.id}
                    onClick={() => {
                      onToggle(node.id, true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusRelativeItem(event, 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusRelativeItem(event, -1);
                      } else if (event.key === "Home") {
                        event.preventDefault();
                        focusBoundaryItem(event, "first");
                      } else if (event.key === "End") {
                        event.preventDefault();
                        focusBoundaryItem(event, "last");
                      } else if (event.key === "ArrowLeft" && column.path.length > 0) {
                        event.preventDefault();
                        onBack();
                      }
                    }}
                    role="menuitemcheckbox"
                    type="button"
                  >
                    <span className="lr-filter-item__copy">
                      <span>{node.label}</span>
                      {node.description ? <small>{node.description}</small> : null}
                    </span>
                    <span className="lr-filter-item__meta">
                      {node.count !== undefined ? <small>{node.count}</small> : null}
                    </span>
                  </button>
                </div>
              </Fragment>
            );
          }

          return (
            <Fragment key={node.id}>
              {divider}
              <button
                aria-expanded={isActive}
                aria-haspopup="menu"
                className="lr-filter-item"
                data-active={isActive}
                data-filter-item
                data-filter-node={node.id}
                onClick={(event) => {
                  onOpenBranch(node, column, true, event.currentTarget);
                }}
                onPointerEnter={(event) => {
                  if (!mobile) {
                    onOpenBranch(node, column, false, event.currentTarget);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusRelativeItem(event, 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusRelativeItem(event, -1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusBoundaryItem(event, "first");
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusBoundaryItem(event, "last");
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    onOpenBranch(node, column, true, event.currentTarget);
                  } else if (event.key === "ArrowLeft" && column.path.length > 0) {
                    event.preventDefault();
                    onBack();
                  }
                }}
                role="menuitem"
                type="button"
              >
                <span className="lr-filter-item__icon">
                  {node.icon ? <Icon name={node.icon} size={14} /> : null}
                </span>
                <span className="lr-filter-item__copy">
                  <span>{node.label}</span>
                  {node.description ? <small>{node.description}</small> : null}
                </span>
                <span className="lr-filter-item__meta">
                  <Icon name="chevronRight" size={12} />
                </span>
              </button>
            </Fragment>
          );
        })}
        {visibleNodes.length === 0 ? (
          <p className="lr-filter-empty">{messages.noMatchingProperties}</p>
        ) : null}
      </div>
    </section>
  );
};

export const CascadingFilter = ({
  ariaLabel,
  defaultValue = [],
  messages,
  onValueChange,
  options,
  trigger,
  value,
}: CascadingFilterProps): React.JSX.Element => {
  const copy: FilterMessages = { ...defaultFilterMessages, ...messages };
  const isMobile = useSyncExternalStore(
    subscribeToMobileFilter,
    getMobileFilterSnapshot,
    getMobileFilterServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [uncontrolledValue, setUncontrolledValue] = useState<readonly string[]>(defaultValue);
  const committedValue = value ?? uncontrolledValue;
  const [path, setPath] = useState<readonly string[]>([]);
  const [panelTops, setPanelTops] = useState<Readonly<Record<string, number>>>({});
  const [queries, setQueries] = useState<Readonly<Record<string, string>>>({});
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  const desktopPointerDismissRef = useRef(false);
  const hoverIntentTimeoutRef = useRef<number | undefined>(undefined);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerWithRef = cloneElement(trigger as ReactElement<{ ref?: Ref<HTMLButtonElement> }>, {
    ref: triggerRef,
  });
  const columns = getColumns(options, path, copy.rootTitle);
  const currentColumn = columns.at(-1) ?? {
    key: "root",
    nodes: options,
    path: [],
    title: copy.rootTitle,
  };

  const clearScheduledBranch = (): void => {
    if (hoverIntentTimeoutRef.current === undefined) {
      return;
    }

    window.clearTimeout(hoverIntentTimeoutRef.current);
    hoverIntentTimeoutRef.current = undefined;
  };

  useEffect(
    () => () => {
      if (hoverIntentTimeoutRef.current !== undefined) {
        window.clearTimeout(hoverIntentTimeoutRef.current);
      }
    },
    [],
  );

  const handleOpenChange = (nextOpen: boolean): void => {
    clearScheduledBranch();
    if (nextOpen) {
      desktopPointerDismissRef.current = false;
      setPath([]);
      setPanelTops({});
      setQueries({});
    }
    setOpen(nextOpen);
  };

  const handleToggle = (nodeId: string, closeAfter: boolean): void => {
    clearScheduledBranch();
    const nextValue = committedValue.includes(nodeId)
      ? committedValue.filter((selectedId) => selectedId !== nodeId)
      : [...committedValue, nodeId];
    const orderedIds = orderSelectedLeafIds(options, nextValue);

    if (value === undefined) {
      setUncontrolledValue(orderedIds);
    }
    onValueChange?.(orderedIds);
    if (closeAfter) {
      setOpen(false);
    }
  };

  const handleOpenBranch = (
    node: FilterNode,
    column: FilterColumn,
    moveFocus = true,
    anchor?: HTMLButtonElement,
  ): void => {
    clearScheduledBranch();

    const openBranch = (): void => {
      hoverIntentTimeoutRef.current = undefined;
      const nextPath = [...column.path, node.id];
      const nextColumnKey = pathKey(nextPath);

      if (!isMobile && anchor) {
        const popover = anchor.closest<HTMLElement>(".lr-filter-popover");
        if (popover) {
          const popoverRect = popover.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const panelHeight = estimateFilterPanelHeight(node.children ?? []);
          const availableBottom = window.innerHeight - popoverRect.top - 8;
          const maximumTop = Math.max(0, availableBottom - panelHeight);
          const nextTop = Math.min(Math.max(0, anchorRect.top - popoverRect.top - 1), maximumTop);
          setPanelTops((current) => ({ ...current, [nextColumnKey]: nextTop }));
        }
      }

      setPath(nextPath);
      if (!moveFocus) {
        return;
      }

      window.requestAnimationFrame(() => {
        const target = isMobile
          ? mobileSearchRef.current
          : document.querySelector<HTMLInputElement>(
              `.lr-filter-level[data-filter-depth="${nextPath.length.toString()}"] input`,
            );
        target?.focus();
      });
    };

    if (!moveFocus && !isMobile) {
      hoverIntentTimeoutRef.current = window.setTimeout(openBranch, filterHoverIntentDelay);
      return;
    }

    openBranch();
  };

  const handleBack = (): void => {
    const departingNodeId = path.at(-1);
    const nextPath = path.slice(0, -1);
    setPath(nextPath);
    window.requestAnimationFrame(() => {
      if (isMobile) {
        mobileSearchRef.current?.focus();
        return;
      }

      if (departingNodeId) {
        document.querySelector<HTMLButtonElement>(`[data-filter-node="${departingNodeId}"]`)?.focus();
      }
    });
  };

  const handleQueryChange = (key: string, nextQuery: string): void => {
    setQueries((current) => ({ ...current, [key]: nextQuery }));
  };

  if (isMobile) {
    const parentTitle = columns.at(-2)?.title ?? ariaLabel;
    return (
      <DialogPrimitive.Root onOpenChange={handleOpenChange} open={open}>
        <DialogPrimitive.Trigger asChild>{triggerWithRef}</DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="lr-dialog-overlay" />
          <DialogPrimitive.Content
            className="lr-filter-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              mobileSearchRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
          >
            <header className="lr-filter-dialog__header">
              <div className="lr-filter-dialog__heading">
                {path.length > 0 ? (
                  <IconButton
                    label={`${copy.backTo} ${parentTitle}`}
                    name="chevronLeft"
                    onClick={handleBack}
                    size="lg"
                  />
                ) : null}
                <DialogPrimitive.Title>
                  {path.length === 0 ? ariaLabel : currentColumn.title}
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close asChild>
                <IconButton label={copy.close} name="close" size="lg" />
              </DialogPrimitive.Close>
            </header>
            <DialogPrimitive.Description className="lr-visually-hidden">
              {copy.description}
            </DialogPrimitive.Description>
            <div className="lr-filter-dialog__body">
              <FilterLevel
                activeChildId={undefined}
                column={currentColumn}
                key={currentColumn.key}
                mobile
                messages={copy}
                onBack={handleBack}
                onOpenBranch={handleOpenBranch}
                onQueryChange={handleQueryChange}
                onToggle={handleToggle}
                query={queries[currentColumn.key] ?? ""}
                searchRef={mobileSearchRef}
                selected={committedValue}
              />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <PopoverPrimitive.Root onOpenChange={handleOpenChange} open={open}>
      <PopoverPrimitive.Trigger asChild>{triggerWithRef}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          aria-label={ariaLabel}
          className="lr-filter-popover"
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            desktopSearchRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!desktopPointerDismissRef.current) {
              triggerRef.current?.focus();
            }
            desktopPointerDismissRef.current = false;
          }}
          onEscapeKeyDown={() => {
            desktopPointerDismissRef.current = false;
          }}
          onPointerDownOutside={() => {
            desktopPointerDismissRef.current = true;
          }}
          sideOffset={6}
        >
          <div className="lr-filter-main-panel">
            <FilterLevel
              activeChildId={path[0]}
              column={columns[0] ?? { key: "root", nodes: options, path: [], title: copy.rootTitle }}
              messages={copy}
              onBack={handleBack}
              onOpenBranch={handleOpenBranch}
              onQueryChange={handleQueryChange}
              onToggle={handleToggle}
              query={queries["root"] ?? ""}
              searchRef={desktopSearchRef}
              selected={committedValue}
            />
          </div>
          <div className="lr-filter-submenus">
            {columns.slice(1).map((column) => (
              <FilterLevel
                activeChildId={path[column.path.length]}
                column={column}
                floatingPosition={{
                  height: estimateFilterPanelHeight(column.nodes),
                  right: rootFilterPanelOffset + (column.path.length - 1) * nestedFilterPanelStride,
                  top: panelTops[column.key] ?? 0,
                }}
                key={column.path.length}
                messages={copy}
                onBack={handleBack}
                onOpenBranch={handleOpenBranch}
                onQueryChange={handleQueryChange}
                onToggle={handleToggle}
                query={queries[column.key] ?? ""}
                searchRef={undefined}
                selected={committedValue}
              />
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

type AppliedFilterEditorProps = {
  group: AppliedFilterGroup;
  messages: FilterMessages;
  onValueChange: (value: readonly string[]) => void;
  options: readonly FilterNode[];
  value: readonly string[];
};

const AppliedFilterEditor = ({
  group,
  messages,
  onValueChange,
  options,
  value,
}: AppliedFilterEditorProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = group.options.filter((option) =>
    `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  const selectedIds = group.selected.map((option) => option.id);
  const valueLabel =
    group.selected.length === 1
      ? (group.selected[0]?.label ?? messages.oneValue)
      : `${group.selected[0]?.label ?? group.selected.length.toString()} +${(
          group.selected.length - 1
        ).toString()}`;

  const handleToggle = (nodeId: string, closeAfter: boolean): void => {
    const nextValue = value.includes(nodeId)
      ? value.filter((selectedId) => selectedId !== nodeId)
      : [...value, nodeId];
    onValueChange(orderSelectedLeafIds(options, nextValue));
    if (closeAfter) {
      setOpen(false);
    }
  };

  return (
    <PopoverPrimitive.Root
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setQuery("");
        }
        setOpen(nextOpen);
      }}
      open={open}
    >
      <div className="lr-applied-filter">
        <PopoverPrimitive.Trigger asChild>
          <button
            aria-label={`${messages.edit} ${group.label}`}
            className="lr-applied-filter__editor"
            type="button"
          >
            <span className="lr-applied-filter__property">
              <Icon name={group.icon ?? "filter"} size={12} />
              {group.label}
            </span>
            <span className="lr-applied-filter__operator">
              {group.selected.length === 1 ? messages.is : messages.isAnyOf}
            </span>
            <span className="lr-applied-filter__value">{valueLabel}</span>
          </button>
        </PopoverPrimitive.Trigger>
        <button
          aria-label={`${messages.remove} ${group.label}`}
          className="lr-applied-filter__remove"
          onClick={() => {
            onValueChange(value.filter((nodeId) => !selectedIds.includes(nodeId)));
          }}
          type="button"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          aria-label={`${messages.edit} ${group.label}`}
          className="lr-applied-filter-popover"
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          sideOffset={6}
        >
          <label className="lr-filter-search lr-applied-filter-popover__search">
            <span className="lr-visually-hidden">
              {messages.search} {group.label}
            </span>
            <input
              aria-label={`${messages.search} ${group.label}`}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              placeholder={messages.filterPlaceholder}
              ref={searchRef}
              spellCheck={false}
              type="search"
              value={query}
            />
          </label>
          <div
            aria-label={`${group.label} ${messages.selectedValues}`}
            className="lr-filter-list"
            role="menu"
          >
            {visibleOptions.map((option) => {
              const selected = value.includes(option.id);
              return (
                <div className="lr-filter-choice" key={option.id} role="none">
                  <button
                    aria-label={`${selected ? messages.remove : messages.add} ${option.label}`}
                    aria-pressed={selected}
                    className="lr-filter-choice__checkbox"
                    onClick={() => {
                      handleToggle(option.id, false);
                    }}
                    type="button"
                  >
                    {selected ? <Icon name="check" size={12} /> : null}
                  </button>
                  <button
                    aria-checked={selected}
                    className="lr-filter-item lr-filter-item--choice"
                    data-filter-item
                    onClick={() => {
                      handleToggle(option.id, true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusRelativeItem(event, 1);
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusRelativeItem(event, -1);
                      }
                      if (event.key === "Home") {
                        event.preventDefault();
                        focusBoundaryItem(event, "first");
                      }
                      if (event.key === "End") {
                        event.preventDefault();
                        focusBoundaryItem(event, "last");
                      }
                    }}
                    role="menuitemcheckbox"
                    type="button"
                  >
                    <span className="lr-filter-item__copy">
                      <span>{option.label}</span>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    <span className="lr-filter-item__meta">
                      {option.count !== undefined ? <small>{option.count}</small> : null}
                    </span>
                  </button>
                </div>
              );
            })}
            {visibleOptions.length === 0 ? (
              <p className="lr-filter-empty">{messages.noMatchingValues}</p>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

export const AppliedFilterBar = ({
  addFilter,
  ariaLabel,
  className,
  messages,
  onValueChange,
  options,
  value,
}: AppliedFilterBarProps): React.JSX.Element => {
  const copy: FilterMessages = { ...defaultFilterMessages, ...messages };
  const groups = getAppliedFilterGroups(options, value);

  return (
    <div aria-label={ariaLabel} className={cn("lr-applied-filter-bar", className)} role="region">
      <div className="lr-applied-filter-bar__conditions">
        {groups.map((group) => (
          <AppliedFilterEditor
            group={group}
            key={group.id}
            messages={copy}
            onValueChange={onValueChange}
            options={options}
            value={value}
          />
        ))}
        <div className="lr-applied-filter-bar__add">{addFilter}</div>
      </div>
      {value.length > 0 ? (
        <Button
          className="lr-applied-filter-bar__clear"
          onClick={() => {
            onValueChange([]);
          }}
          shape="pill"
        >
          {copy.clear}
        </Button>
      ) : null}
    </div>
  );
};
