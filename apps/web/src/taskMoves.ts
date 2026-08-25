import type { WorkItemState } from "@loomrail/contracts";

/** Manual state changes an owner may apply to a WorkItem that no workflow run currently owns. */
export const transitionTargets: Record<WorkItemState, readonly WorkItemState[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

export type MoveShortcuts = {
  /** The move that carries delivery forward, emphasised in the inspector footer. */
  primary: WorkItemState | null;
  /** The most useful remaining move, offered without emphasis. */
  secondary: WorkItemState | null;
};

/**
 * Footer shortcuts are chosen by meaning, not by the order of `transitionTargets`.
 *
 * `IN_PROGRESS` has no forward shortcut on purpose: `DONE` is reachable only through recorded owner
 * acceptance, so promoting a sideways or backward move would misrepresent it. `CANCELLED` is never a
 * shortcut — it stays behind the explicit Move menu, which always offers the full transition set.
 */
const moveShortcuts: Record<WorkItemState, MoveShortcuts> = {
  BACKLOG: { primary: "READY", secondary: null },
  READY: { primary: "IN_PROGRESS", secondary: "BACKLOG" },
  IN_PROGRESS: { primary: null, secondary: "BLOCKED" },
  BLOCKED: { primary: "IN_PROGRESS", secondary: "READY" },
  DONE: { primary: null, secondary: null },
  CANCELLED: { primary: null, secondary: null },
};

const allowed = (state: WorkItemState, target: WorkItemState | null): WorkItemState | null =>
  target !== null && transitionTargets[state].includes(target) ? target : null;

/**
 * Resolves the inspector footer shortcuts for a WorkItem. While a workflow run owns the item the
 * owner acts through workflow controls, so no manual shortcut is offered.
 */
export const moveShortcutsFor = (state: WorkItemState, workflowActive: boolean): MoveShortcuts => {
  if (workflowActive) return { primary: null, secondary: null };
  const { primary, secondary } = moveShortcuts[state];
  return { primary: allowed(state, primary), secondary: allowed(state, secondary) };
};
