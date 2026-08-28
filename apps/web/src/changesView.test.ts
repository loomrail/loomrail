import { describe, expect, it } from "vitest";

import { LocalApiError } from "./api";
import { changeStatusLabelKeys, changeStatusTones, changesRefusalKey } from "./changesView";

const refusal = (code: string, status: number): LocalApiError =>
  new LocalApiError({ code, message: `daemon said ${code}`, recovery: "none", status });

describe("changesView", () => {
  it("names every status the contract can report, as itself", () => {
    // The map is exhaustive by construction (`Record<ChangeStatus, …>`), so what is left to get
    // wrong is which label lands on which status -- and a map that answered "Added" for a deletion
    // type-checks perfectly happily. Every entry is pinned rather than a sample, because the
    // browser test only ever opens a worktree holding three of the four.
    expect(changeStatusLabelKeys).toEqual({
      ADDED: "changes.status.ADDED",
      MODIFIED: "changes.status.MODIFIED",
      DELETED: "changes.status.DELETED",
      RENAMED: "changes.status.RENAMED",
    });
    // Four distinct tones, so the colour beside the label never says the same thing for two
    // different fates. The label is always printed beside it, so the colour is never the only
    // carrier (AGENTS.md).
    expect(new Set(Object.values(changeStatusTones)).size).toBe(4);
  });

  it("tells each refusal the two change handles can answer with apart", () => {
    // Every code raised by the changes routes in apps/daemon/src/server.ts. The point of the
    // assertion is that they are DISTINCT: a mapping that collapsed a deleted worktree, an
    // unreachable one and a missing git into one sentence would send the owner looking in the
    // wrong place, and would still satisfy a test that only checked the fallback.
    const codes = [
      "WORKSPACE_WORKTREE_MISSING",
      "WORKSPACE_WORKTREE_UNREADABLE",
      "WORKSPACE_HAS_NO_BASELINE",
      "CHANGES_UNREADABLE",
      "GIT_UNAVAILABLE",
      "PATH_OUTSIDE_WORKSPACE",
      "PATH_NOT_A_FILE",
      "PATH_UNRESOLVABLE",
    ];
    const keys = codes.map((code) => changesRefusalKey(refusal(code, 409)));

    expect(keys).toEqual(codes.map((code) => `changes.error.${code}`));
    expect(new Set(keys).size).toBe(codes.length);
  });

  it("falls back to a sentence that claims no cause, rather than to silence", () => {
    // A daemon that stopped answering, and a code this build has never heard of. Neither may
    // produce an empty file list: an empty list is a claim that the worktree is unchanged, and a
    // read that did not happen is not entitled to make it (spec D7).
    expect(changesRefusalKey(refusal("LOCAL_DAEMON_UNAVAILABLE", 0))).toBe("changes.error.other");
    expect(changesRefusalKey(refusal("SOME_CODE_FROM_A_LATER_DAEMON", 500))).toBe("changes.error.other");
    expect(changesRefusalKey(new Error("not a local API error"))).toBe("changes.error.other");
  });
});
