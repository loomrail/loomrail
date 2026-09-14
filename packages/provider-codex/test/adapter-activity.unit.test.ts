import { describe, expect, it } from "vitest";

import { parseCodexActivity } from "../src/activity.js";
import { parseCodexEvent } from "../src/stream.js";

// Mirrors the adapter's onLine bookkeeping so the counter rule is pinned by a test rather than by
// a comment: a line that produced activity is no longer "unused", or the adapter's own diagnostic
// would report a healthy run as one it could not read.
const classify = (line: string): { activity: number; unused: number } => {
  const activity = parseCodexActivity(line);
  const event = parseCodexEvent(line);
  const unused = event === null && activity.length === 0 ? 1 : 0;
  return { activity: activity.length, unused };
};

describe("adapter line bookkeeping", () => {
  it("does not count a command execution as an unused line", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "pnpm test", exit_code: 0 },
    });
    expect(classify(line)).toEqual({ activity: 1, unused: 0 });
  });

  it("still counts a line nothing understands", () => {
    expect(classify('{"type":"unknown.event"}')).toEqual({ activity: 0, unused: 1 });
  });
});
