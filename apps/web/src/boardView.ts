import type { WorkItem, WorkItemState } from "@loomrail/contracts";

/**
 * How cards are ordered inside a delivery column.
 *
 * The board itself is always grouped by delivery state: the columns are the accountable route a
 * WorkItem travels, not an arbitrary axis. Only the order within a column is a view preference.
 */
export type BoardOrdering = "priority" | "created" | "updated" | "title";
export type BoardDirection = "asc" | "desc";

export type BoardView = {
  direction: BoardDirection;
  ordering: BoardOrdering;
  /** When false, columns with no matching card are hidden instead of shown empty. */
  showEmptyColumns: boolean;
};

export const defaultBoardView: BoardView = {
  direction: "desc",
  ordering: "priority",
  showEmptyColumns: true,
};

export const boardOrderings: readonly BoardOrdering[] = ["priority", "created", "updated", "title"];

export const isBoardOrdering = (value: unknown): value is BoardOrdering =>
  typeof value === "string" && boardOrderings.some((ordering) => ordering === value);

export const isBoardDirection = (value: unknown): value is BoardDirection =>
  value === "asc" || value === "desc";

const priorityRank: Record<WorkItem["priority"], number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};

const compareBy = (ordering: BoardOrdering, left: WorkItem, right: WorkItem): number => {
  if (ordering === "priority") return priorityRank[left.priority] - priorityRank[right.priority];
  if (ordering === "created") return left.createdAt.localeCompare(right.createdAt);
  if (ordering === "updated") return left.updatedAt.localeCompare(right.updatedAt);
  return left.title.localeCompare(right.title);
};

/**
 * Orders cards for display. The comparison is total — ties fall back to creation time and then to
 * the opaque ID — so the same data always renders in the same order.
 */
export const orderWorkItems = (
  items: readonly WorkItem[],
  { direction, ordering }: Pick<BoardView, "direction" | "ordering">,
): readonly WorkItem[] => {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    const primary = compareBy(ordering, left, right);
    if (primary !== 0) return primary * sign;
    const created = left.createdAt.localeCompare(right.createdAt);
    if (created !== 0) return created * sign;
    return left.id.localeCompare(right.id);
  });
};

/**
 * Which slice of a project's delivery the board shows. `active` hides finished work, `backlog`
 * narrows to unstarted work, and `all` is the only place a DONE or CANCELLED task stays visible.
 */
export type BoardScope = "active" | "backlog" | "all";

export const scopeStates: Record<BoardScope, readonly WorkItemState[]> = {
  active: ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED"],
  backlog: ["BACKLOG"],
  all: ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
};

export const isBoardScope = (value: unknown): value is BoardScope =>
  value === "active" || value === "backlog" || value === "all";

export const scopeShows = (scope: BoardScope, state: WorkItemState): boolean =>
  scopeStates[scope].includes(state);
