import type { AgentRunActivityPage } from "@loomrail/contracts";

// A plain function value, not a component -- kept out of RunActivitySection.tsx itself (a
// component file react-refresh expects to export only components), the same reason
// isWorkItemTimelineEvent lives in its own module rather than WorkbenchPage.tsx.
//
// `degraded` and `omittedCount` are run-level facts: every page's read of them comes from the same
// whole-buffer query (apps/daemon/src/agent-run-activity.ts), so the freshest page's value is the
// current one. `gap`, unlike those two, is per-PAGE -- true only on the one page whose cursor
// landed on pruned data, false on the first page and on every page fetched after it. Reading only
// the last loaded page's `gap` would make an announced gap vanish the moment the owner loads one
// more page: exactly the silent hole this flag exists to prevent.
export const anyPageHasGap = (pages: readonly AgentRunActivityPage[]): boolean =>
  pages.some((page) => page.gap);
