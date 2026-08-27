import { describe, expect, it } from "vitest";

import {
  filterColumnKey,
  pruneFilterPath,
  searchFilterNodes,
  type FilterNode,
} from "../src/filter-search.js";

const options: readonly FilterNode[] = [
  {
    id: "status",
    label: "Статус",
    children: [
      { id: "status-todo", label: "К работе" },
      { id: "status-done", label: "Готово" },
    ],
  },
  {
    id: "priority",
    label: "Приоритет",
    children: [
      { id: "priority-urgent", label: "Критический" },
      { id: "priority-low", label: "Низкий" },
    ],
  },
  {
    id: "risk",
    label: "Риск",
    description: "Оценка риска",
    children: [
      { id: "risk-critical", label: "Критический" },
      { id: "risk-low", label: "Низкий" },
    ],
  },
];

describe("searchFilterNodes", () => {
  it("lists every node of the level when the query is empty", () => {
    expect(searchFilterNodes(options, "  ", true).map((result) => result.node.id)).toEqual([
      "status",
      "priority",
      "risk",
    ]);
  });

  it("keeps a shallow level to its own nodes", () => {
    const level = options[1]?.children ?? [];
    expect(searchFilterNodes(level, "крит").map((result) => result.node.id)).toEqual(["priority-urgent"]);
  });

  it("surfaces values from every property when the level searches deep", () => {
    expect(
      searchFilterNodes(options, "крит", true).map((result) => [result.parent?.id, result.node.id]),
    ).toEqual([
      ["priority", "priority-urgent"],
      ["risk", "risk-critical"],
    ]);
  });

  it("does not surface values of a property that matches by itself", () => {
    expect(searchFilterNodes(options, "приоритет", true).map((result) => result.node.id)).toEqual([
      "priority",
    ]);
  });

  it("matches a description as well as a label", () => {
    expect(searchFilterNodes(options, "оценка", true).map((result) => result.node.id)).toEqual(["risk"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(searchFilterNodes(options, "  КРИТ  ", true)).toHaveLength(2);
  });

  it("returns nothing when neither properties nor values match", () => {
    expect(searchFilterNodes(options, "нетничего", true)).toEqual([]);
  });
});

describe("pruneFilterPath", () => {
  it("keeps an open property that the search still lists", () => {
    expect(pruneFilterPath(options, ["priority"], { root: "приор" })).toEqual(["priority"]);
  });

  it("closes an open property that the search hides", () => {
    expect(pruneFilterPath(options, ["priority"], { root: "риск" })).toEqual([]);
  });

  it("closes an open property when the search only surfaces its values", () => {
    expect(pruneFilterPath(options, ["priority"], { root: "крит" })).toEqual([]);
  });

  it("keeps the path when no level is searched", () => {
    expect(pruneFilterPath(options, ["priority"], {})).toEqual(["priority"]);
  });

  it("drops a path that names an unknown property", () => {
    expect(pruneFilterPath(options, ["missing"], {})).toEqual([]);
  });
});

describe("filterColumnKey", () => {
  it("names the root level", () => {
    expect(filterColumnKey([])).toBe("root");
  });

  it("names a nested level by its path", () => {
    expect(filterColumnKey(["priority", "priority-urgent"])).toBe("priority/priority-urgent");
  });
});
