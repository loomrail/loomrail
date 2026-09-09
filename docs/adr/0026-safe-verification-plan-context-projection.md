# ADR-0026: Safe Verification Plan context projection

**Status:** Accepted

**Date:** 2026-09-09

## Context

The executor already captures the current owner-approved Project Verification Plan and accepts only an exact recipe
ID. The provider context did not identify that Plan or enumerate the safe recipe names. During private Recurkit
dogfood a read-only Discovery session attempted verification, received the correct typed refusal, then opened a
HumanRequest whose wording implied that the owner's answer could grant execution authority. The answer could not and
did not change the immutable AgentRun policy, but the UI presented a misleading recovery path.

Sending the full Plan would expose unnecessary command structure (`argv`, script preview, cwd and provenance) as
instruction-bearing provider input. Letting adapters discover or render the Plan independently would also duplicate
policy and make Codex and Claude observe different authority.

## Decision

`READ_CONTEXT_SOURCES` includes an optional safe projection of the latest ACTIVE Project Verification Plan in the
same SQLite snapshot as the WorkItem, decisions and workflow position. The projection contains only Plan ID,
revision, status and at most twelve recipe summaries: ID, kind, bounded label, required flag, timeout and network
policy. It never contains argv, cwd, script/provenance, output limits, repository paths or publication data.

The existing required `WORKFLOW_POSITION` renderer owns this projection. Its recipe provenance records the Plan ID
and revision using a distinct `PROJECT_VERIFICATION_PLAN` source kind. Rendering states explicitly that the list
describes existing authority, that unavailable tools remain unavailable, and that a HumanRequest answer cannot widen
permissions, allowlists, budgets or workflow authority.

The generic HumanRequest answer form repeats the same non-escalation fact independently of provider-authored title,
context or recommendation, so misleading untrusted wording cannot become the UI's only explanation of the action.

The projection grants nothing. Tool availability still comes from the immutable AgentRun/MCP snapshot, and
`WorkspaceToolExecutor` still requires an exact recipe ID and verifies that the captured Plan remains current. Local
provider adapters receive the same assembled text and keep provider-specific payloads private.

## Consequences

- providers can choose an existing recipe without guessing its identity or asking the owner to repeat durable state;
- Discovery/PLAN/REVIEW remain read-only even when the Project has recipes;
- HumanRequest wording cannot be trusted as a capability grant, and the context tells both providers so directly;
- context recipes can prove which Plan revision was shown without persisting its command payload;
- old databases and old context recipes remain valid because the new source kind is additive and the source is
  optional.

## Required verification

- ACTIVE Plan metadata is rendered deterministically with bounded labels and exact provenance;
- DISABLED or absent Plan renders an explicit no-active-plan statement with no Plan provenance;
- argv, cwd, script preview/provenance, output limits and repository paths are absent;
- spaces and Unicode labels render identically on macOS and modeled Windows inputs;
- a provider-authored HumanRequest still cannot alter immutable workspace or recipe authority;
- context-source snapshot isolation prevents a concurrently adopted Plan from producing a torn pack.
