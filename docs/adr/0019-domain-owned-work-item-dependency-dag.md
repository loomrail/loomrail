# ADR-0019: WorkItem execution dependencies are a domain-owned DAG

**Status:** Accepted

**Date:** 2026-09-09

**Extends:** ADR-0002, ADR-0011, PD-005, WD-001 and WD-006

## Context

Loomrail already owns WorkItem hierarchy through `parentId`, prevents non-leaf execution and describes a Task DAG
in the approved product model. Private Recurkit dogfood proved the provider workflow for one WorkItem, but the three
ordered delivery parts existed only in brief text. Textual ordering cannot survive restart as executable state, gate
another WorkItem or prove the approved private-Epic release criterion.

A dependency is not hierarchy: a child belongs to an Epic, while one leaf may block another. It is also not provider
output: provider planning may propose order, but only an owner-authorized command can change the graph that gates
execution.

## Decision

- Loomrail stores one directed `BLOCKS` relation from `blockerWorkItemId` to `blockedWorkItemId`. `blocked by` is its
  inverse projection. Non-executing `relates to` links remain outside this Beta slice.
- Both ends must exist in the same Project, an item cannot block itself, and the complete Project graph must remain
  acyclic. Graph mutation fails closed when bounded validation cannot inspect it.
- The public mutation is one deep command: atomically replace the complete set of incoming blockers for one
  WorkItem using its expected version. The domain canonicalizes the set, validates it against the current graph and
  returns one decision; persistence applies the edge diff, advances the WorkItem version and appends one audit Event
  in the same SQLite transaction and command receipt.
- Dependencies may change only while the blocked WorkItem has no active workflow and is not terminal. An unchanged
  command ID replays its receipt; reusing the ID with different input is rejected. A fresh command that changes
  nothing is not represented as a new audit fact.
- Board `READY` and dependency readiness are separate facts. `START_PIPELINE` requires a leaf WorkItem in `READY`
  and every incoming blocker in `DONE`, checked inside the start transaction. `CANCELLED` is not success and remains
  visibly blocking until the owner changes the graph.
- The browser receives a bounded graph projection containing only WorkItem IDs, relation kind and creation time. It
  renders titles/states from the separately validated WorkItem list, disables start when blockers remain, and shows
  the same typed blocked state returned by the daemon if its view became stale.
- The provider receives ordinary WorkItem/context facts but no authority to mutate dependencies. Provider-specific
  session payloads and local CLI behavior are unchanged.

## Consequences

- A private Epic can now contain durable child WorkItems whose execution order survives restart and is enforced by
  Loomrail rather than by a prompt.
- Replacing one incoming set is less flexible than a general relationship editor, but gives one concurrency boundary,
  one cycle check and one audit event. Additional relation kinds or cross-Project graphs require a new decision.
- Completing a blocker makes dependants eligible without mutating them; readiness is derived from current durable
  states. No automatic cross-WorkItem scheduler dispatch is claimed in this slice: the owner still starts each ready
  leaf workflow.
- Existing databases require an additive migration and keep all historical Events and command receipts unchanged.
