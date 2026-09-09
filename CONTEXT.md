# Loomrail domain context

This glossary is the canonical vocabulary for the work-management dependency slice. It describes domain meaning,
not implementation structure.

- **WorkItem** — a versioned unit of product work owned by one Project. A WorkItem may be a container or an
  executable leaf.
- **Epic** — a container WorkItem whose children express decomposition. An Epic itself is not executable while it
  has children.
- **Hierarchy** — the containment relation expressed by `parentId`. Hierarchy answers “what is part of this
  outcome?” and never determines execution order by itself.
- **Dependency** — a directed execution constraint between two WorkItems in the same Project. It is separate from
  hierarchy.
- **Blocker** — the source WorkItem of a `BLOCKS` dependency. The blocked WorkItem cannot start its workflow until
  every blocker is `DONE`.
- **Dependency-ready** — a WorkItem whose incoming blockers are all `DONE`. This is distinct from the board state
  `READY`: both facts must hold before a workflow can start.
- **Blocked dependency** — an incoming dependency whose blocker is not `DONE`, including a blocker in `CANCELLED`.
  Cancellation does not silently satisfy or remove an approved dependency.
