# ADR-0018: Provider admission uses the session engine version

**Status:** Accepted

**Date:** 2026-09-08

**Amends:** ADR-0015 and ADR-0016

## Context

Loomrail admits a local provider only when the exact CLI/runtime target has evidence for the containment flags used
by production sessions. A Claude Code installation can contain a native launcher and a separately selected session
engine. The launcher's bare `--version` result is therefore not necessarily the version whose option parser and
runtime execute `claude -p`.

Investigation during private dogfood found that the same installed launcher could report different engine versions
depending on the working directory that entered its option parser. A bare probe inherited the daemon's project
directory, while production sessions use a fresh temporary directory. Treating the inherited-cwd launcher label as
runtime identity makes exact-version admission decorative: readiness can answer for an engine selection different
from the one production will actually launch.

## Decision

- Compatibility is determined from the engine that parses production session options, not from a native launcher's
  fast-path version label.
- Claude Code version probing runs in a fresh temporary directory with the same provider-owned engine-selection
  environment as a production session, then enters that parser with the inert containment prefix
  `--setting-sources "" --version`. It starts no model session, receives no repository input and consumes no provider
  quota. The normalized version is then evaluated by the existing exact platform/architecture matrix and minimum
  floor.
- Authentication is probed only after the engine is compatible. An installed launcher whose engine is too old,
  unreadable or unverified is not ready even when the bare launcher prints an admitted version.
- Provider-specific probe arguments remain inside the Claude adapter diagnostics. The provider-neutral registry sees
  only typed executable, compatibility and authentication facts.
- Loomrail does not remove `--restricted`, retry with weaker flags, update the CLI, select an API transport or invent
  success. `AUTO` may select another independently ready local CLI; an explicit Claude preference remains visibly
  blocked with the existing typed compatibility reason.

## Consequences

- Readiness now agrees with the executable that would run a session, including split launcher/engine installations.
- The probe is slightly more provider-specific but does not broaden authority or start billable work.
- A locally installed Claude Code whose production-shaped scratch probe is not admitted may require repair or update
  through Claude's own supported workflow before Loomrail can use it. Loomrail does not mutate that installation.
- Exact argv tests and a real local probe must cover divergent launcher/engine versions without persisting raw CLI
  output.
