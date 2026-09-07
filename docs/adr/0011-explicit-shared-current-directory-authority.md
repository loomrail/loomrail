# ADR-0011 — Explicit shared current-directory authority

**Status:** Accepted

**Date:** 2026-09-06

## Context

Isolated branch + linked worktree is Loomrail's safe default, but some repositories explicitly prohibit worktrees.
Dogfood Alpha requires such a repository to run without violating its own policy, while preserving existing user
changes and preventing two Loomrail writers from racing in the same checkout.

A repository path, a provider working directory and writer authority are different concerns. Treating “use the
registered path” as a path override would bypass durable policy, make recovery guess the mode and leave per-WorkItem
leases unable to fence two different WorkItems that point at the same checkout.

## Decision

- Store a versioned Project Workspace Strategy with isolated worktree as the absence/default state.
- Record the chosen strategy on every WorkItemWorkspace when it is created; later Project changes do not reinterpret
  existing workspaces.
- Shared mode uses the canonical registered Git top-level and current named branch. It creates a temporary-index
  carry-in baseline but no branch, checkout, linked worktree, stash or history commit.
- Make shared writer and verification authority exclusive across all WorkItemWorkspace rows of one Project. SQLite
  guarded claims are the decision point; a partial unique index is the invariant backstop.
- Read-only provider stages do not take writer authority. They still receive the same recorded folder and baseline.
- Require explicit authenticated owner opt-in with a warning that Loomrail cannot lock external same-user processes
  and that current-directory mode is not a security sandbox.

## Consequences

Shared repositories can be dogfooded without contradicting their repository policy, and recovery can distinguish an
intentional current-directory workspace from a missing linked worktree. The cost is lower collision isolation:
external editors and terminals remain outside Loomrail's lease. Existing user changes are a measured baseline, not
physically protected files, so review and exact before/after dogfood evidence remain mandatory.

The `worktreePath` storage column is retained for compatibility but means the executable working directory for both
strategies. UI uses the strategy-specific label and does not expose that legacy name as product language.

## Rejected alternatives

- **Ignore the repository policy and keep creating worktrees:** makes Loomrail's own dogfood invalid.
- **Environment variable/path override:** not durable, not auditable and not project-scoped.
- **One lease per WorkItemWorkspace:** allows two WorkItems to write the same shared checkout.
- **Automatically stash or restore owner changes:** mutates owner state and can destroy work after a crash.
- **Hold one lease for read-only stages:** safe but needlessly serializes discovery/review and contradicts the
  approved shared strategy.

## Required tests

See `docs/plans/84-shared-current-directory-workspace-spec.ru.md` §6.
