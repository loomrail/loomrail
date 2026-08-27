import type { IconName } from "./icons.js";

export type FilterNode = {
  children?: readonly FilterNode[];
  count?: number;
  description?: string;
  dividerBefore?: boolean;
  icon?: IconName;
  id: string;
  label: string;
};

/**
 * A row rendered by a filter level. `parent` is set only when a deep search surfaced a value from
 * inside a property, so the row can show the property it belongs to.
 */
export type FilterSearchResult = {
  node: FilterNode;
  parent?: FilterNode;
};

export const filterColumnKey = (path: readonly string[]): string =>
  path.length === 0 ? "root" : path.join("/");

export const normalizeFilterQuery = (query: string): string => query.trim().toLocaleLowerCase();

const hasChildren = (node: FilterNode): boolean => (node.children?.length ?? 0) > 0;

const matchesQuery = (node: FilterNode, normalizedQuery: string): boolean =>
  `${node.label} ${node.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);

/**
 * Rows to show for one filter level. A deep level also searches the values nested under each
 * property, so the root search behaves like a single search across every filter. A property that
 * matches by itself stays a single row: its values remain reachable by opening it.
 */
export const searchFilterNodes = (
  nodes: readonly FilterNode[],
  query: string,
  deep = false,
): readonly FilterSearchResult[] => {
  const normalizedQuery = normalizeFilterQuery(query);
  if (normalizedQuery === "") {
    return nodes.map((node) => ({ node }));
  }

  const collect = (
    candidates: readonly FilterNode[],
    parent: FilterNode | undefined,
  ): readonly FilterSearchResult[] =>
    candidates.flatMap((node) => {
      if (matchesQuery(node, normalizedQuery)) {
        return parent ? [{ node, parent }] : [{ node }];
      }

      if (!deep || !hasChildren(node)) {
        return [];
      }

      return collect(node.children ?? [], node);
    });

  return collect(nodes, undefined);
};

/**
 * The part of an open branch path that is still reachable under the current searches. Typing in a
 * level hides properties, and a submenu whose property is no longer listed has nothing to hang on.
 */
export const pruneFilterPath = (
  options: readonly FilterNode[],
  path: readonly string[],
  queries: Readonly<Record<string, string>>,
): readonly string[] => {
  const reachable: string[] = [];
  let nodes = options;

  for (const nodeId of path) {
    const columnPath = [...reachable];
    const results = searchFilterNodes(
      nodes,
      queries[filterColumnKey(columnPath)] ?? "",
      columnPath.length === 0,
    );
    const branch = results.find((result) => result.node.id === nodeId && !result.parent)?.node;
    if (!branch || !hasChildren(branch)) {
      break;
    }

    reachable.push(nodeId);
    nodes = branch.children ?? [];
  }

  return reachable;
};
