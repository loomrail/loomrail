# ADR-0007: Project scaffolding uses marker-bound durable publication

- Status: accepted
- Date: 2026-09-01
- Owners: Loomrail maintainers

## Context

B4 has to create a new repository without overwriting an existing path, and it must recover if the daemon stops
between the first directory write and Project registration. Building in a sibling temporary directory and renaming
looks atomic, but the portable Node `rename` API has no no-replace flag for directories: on POSIX it may replace an
existing empty directory. Calling that safe would hide the exact target race the feature must prevent.

The other tempting approach is to generate directly and delete the directory on failure. A recursive rollback cannot
reliably distinguish files Loomrail created from files another process or the owner added during the attempt, so it
would turn recovery into a destructive capability.

## Decision

Scaffolding is a durable two-boundary operation:

1. SQLite records the exact confirmed proposal, pending follow-up and audit Event before filesystem mutation.
2. The publisher exclusively claims a previously nonexistent target with non-recursive `mkdir`, immediately writes
   an operation-bound marker, then creates only the recipe's known files using create-new semantics.
3. Restart recovery resumes only an exact marker/proposal match. Any unknown marker, changed file, symlink or special
   file fails closed without deletion or repair.
4. After Git top-level and file digests are verified, a domain command atomically registers the Project, completes the
   operation and appends its Event.

The public module exposes proposal and publication outcomes, not filesystem primitives. Recipe rendering is pure;
Git and filesystem live in the publisher adapter. B4 does not install dependencies, execute generated code, commit,
push or create remotes.

## Rejected alternatives

### Sibling staging directory plus ordinary rename

Rejected because absence checked before `rename` is a race and ordinary directory rename is not portable
no-replace. A platform-native `renameat2(RENAME_NOREPLACE)` adapter may be reconsidered only with equivalent Windows
semantics and tests.

### Generate in target and delete on any failure

Rejected because automatic recursive deletion can remove concurrent owner data. Loomrail leaves exact failure state
and a recoverable, attributable directory instead.

### Copy or clone arbitrary templates

Rejected because template provenance, symlinks, hooks, binary bounds and update trust are separate product/security
problems. B4 starts with reviewed built-in immutable recipes.

## Consequences

- target creation is fail-closed and never overwrites a pre-existing directory;
- a partially published target may be visible after a crash, but is attributable and safely resumable;
- recovery requires a small durable state machine rather than best-effort cleanup;
- owner cleanup of a failed target is explicit, never an automatic recursive rollback;
- future recipes must pass the same closed path/content contract.

## Required verification

- target race and create-new conflict preserve the other writer's data;
- restart at every step resumes only a matching marker and proposal;
- marker/file/symlink mismatch fails without mutation or deletion;
- operation/event/follow-up precede all filesystem writes;
- Project registration and operation completion are transactional and idempotent;
- macOS and Windows integration suites exercise paths with spaces and non-ASCII characters.
