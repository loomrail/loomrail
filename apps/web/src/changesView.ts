import type { ChangeStatus } from "@loomrail/contracts";
import type { BadgeTone } from "@loomrail/ui";

import { isLocalApiError } from "./api";
import type { TranslationKey } from "./i18n";

/**
 * The largest measured median of one summary read in Task 7, rounded to a stable millisecond
 * boundary: 1,594 ms over a real 20,000-file repository. The original 750 ms in the plan was an
 * unmeasured working value; keeping it would schedule work faster than that repository can finish
 * it. This window applies only to change reads -- the rest of the event-driven workbench keeps the
 * channel's 50 ms coalescing window.
 */
export const SUMMARY_REFRESH_DEBOUNCE_MS = 1_600;

export type SummaryRefresher = (() => void) & { dispose: () => void };

/**
 * Schedules one read at the end of a fixed window that starts with the first event in a burst.
 *
 * Later events do not move the deadline: a stage that publishes continuously must still refresh
 * while it is running. `dispose` makes closing the card cancel a read nobody can see.
 */
export const makeSummaryRefresher = (
  read: () => void | Promise<void>,
  windowMs: number = SUMMARY_REFRESH_DEBOUNCE_MS,
): SummaryRefresher => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      // A query client records its own read failure. Catch the returned promise here so a failed
      // background refresh does not also become an unhandled rejection in the browser.
      void Promise.resolve()
        .then(read)
        .catch(() => undefined);
    }, windowMs);
  }) as SummaryRefresher;
  refresh.dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return refresh;
};

/**
 * How a changed file's status is named and toned.
 *
 * A `Record<ChangeStatus, …>` rather than a switch with a default, so adding a fifth status to the
 * contract fails `pnpm typecheck` here instead of silently rendering as whatever the default was.
 * The tone never carries the meaning on its own -- every row prints the label beside the colour
 * (AGENTS.md, "Status/priority/severity must not rely on color alone").
 */
export const changeStatusLabelKeys: Record<ChangeStatus, TranslationKey> = {
  ADDED: "changes.status.ADDED",
  MODIFIED: "changes.status.MODIFIED",
  DELETED: "changes.status.DELETED",
  RENAMED: "changes.status.RENAMED",
};

export const changeStatusTones: Record<ChangeStatus, BadgeTone> = {
  ADDED: "success",
  MODIFIED: "info",
  DELETED: "danger",
  RENAMED: "accent",
};

/**
 * The sentence the card shows instead of a file list, for each refusal the two change handles can
 * answer with.
 *
 * Every code here is raised by `apps/daemon/src/server.ts` and nowhere else: the three a client's
 * own path can earn (400), the two a workspace can earn plus a baseline that is not recorded (409),
 * and the two this machine has to answer for (500). They are mapped to localized sentences rather
 * than shown as the daemon's own message, because that message is English prose built for a log and
 * this text is read by an owner who may have the cockpit in Russian.
 *
 * Each sentence says what happened and stops there. None of them offers an action, because Loomrail
 * has none to offer for any of these: nothing returns a deleted worktree, re-cuts a workspace, or
 * repairs a git installation from inside the cockpit, and a control that could only ever fail is
 * worse than the plain fact.
 */
const changesRefusalKeys: Readonly<Record<string, TranslationKey>> = {
  WORKSPACE_WORKTREE_MISSING: "changes.error.WORKSPACE_WORKTREE_MISSING",
  WORKSPACE_WORKTREE_UNREADABLE: "changes.error.WORKSPACE_WORKTREE_UNREADABLE",
  WORKSPACE_HAS_NO_BASELINE: "changes.error.WORKSPACE_HAS_NO_BASELINE",
  CHANGES_UNREADABLE: "changes.error.CHANGES_UNREADABLE",
  GIT_UNAVAILABLE: "changes.error.GIT_UNAVAILABLE",
  PATH_OUTSIDE_WORKSPACE: "changes.error.PATH_OUTSIDE_WORKSPACE",
  PATH_NOT_A_FILE: "changes.error.PATH_NOT_A_FILE",
  PATH_UNRESOLVABLE: "changes.error.PATH_UNRESOLVABLE",
};

/**
 * Which of those sentences a failed change read earns.
 *
 * Anything that is not a named refusal -- a daemon that stopped answering, a body that did not
 * parse, a code this build has never heard of -- falls back to one that claims nothing about the
 * cause. It must never fall back to silence or to an empty file list: an empty list is a claim that
 * the worktree is unchanged, and a read that did not happen is not entitled to make it (spec D7).
 */
export const changesRefusalKey = (error: unknown): TranslationKey =>
  (isLocalApiError(error) ? changesRefusalKeys[error.code] : undefined) ?? "changes.error.other";
