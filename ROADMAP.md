# Loomrail public roadmap

Loomrail Stable is available for macOS Apple Silicon. Windows and Linux live-provider execution remain unsupported
and fail closed. This roadmap describes the current order of outcomes; it is not a schedule,
support promise, or substitute for the versioned [product decisions](docs/product/PRODUCT-DECISIONS.ru.md) and
[master plan](docs/product/MASTER-PLAN.ru.md). Completed engineering detail lives in release notes and historical
implementation plans.

## Shipped — the macOS Stable local delivery loop

- Local authenticated Codex/Claude CLI execution, independent Review, measured Project verification and Browser QA,
  durable restart recovery, budgets, criterion-linked Acceptance and final owner approval.
- One canonical safe install route and guided mission. Setup is read-only; explicitly starting model work consumes
  provider quota. Provider allowance is separate from Loomrail budgets; unsupported reporting remains unavailable.
- Private multi-task dogfood, package integrity/provenance and clean install/backup/restore evidence for the declared
  support target. See the [release record](docs/RELEASE.md) for published versions versus pending candidates.
- An opt-in, experimental code-blind planning coordinator, from `0.2.0`, that plans from a separate owner-written outcome and closed
  progress facts, with no repository, workspace, network or tool access. Workers keep all repository work, and every
  gate above still applies. It is off by default and claims no measured saving.

## Now — maintain the proven local delivery loop

- Keep source, diagnostics, public documentation and the next package candidate consistent; every release still
  requires exact-source macOS/Windows source/browser/package checks and separate owner publication approval.
- Admit exact live Codex and Claude Code CLI versions only after separately authorized, quota-bearing compatibility
  evidence; keep unknown versions fail-closed.
- Preserve all verification, recovery and security gates while measuring context/worker overhead. Fewer prompt bytes
  or cheaper model calls alone do not prove fewer total tokens or unchanged quality.

## Next — connect the proven loop to normal repository delivery

- Measure whether the opt-in code-blind planner is worth its cost. The mode itself now exists behind an explicit
  opt-in, with its own product decision, security boundary and native qualification, but no token saving and no
  quality non-inferiority has been measured. A same-task paired benchmark needs its own budget and decision before
  any such claim is made.
- Prove one owner-approved, one-shot GitHub Actions Guided Deploy against an exact clean Release, then require an
  environment-bound successful Preview before Production while keeping deployment secrets and operational procedure
  inside repository-owned workflows.
- Validate an optional, bounded Guided Launch service around repository readiness, verification setup, the first live
  route, and Acceptance Package review; keep the Apache-2.0 local workflow fully useful.
- Prepare GitHub pull requests with linked issues and required checks while preserving explicit owner merge authority.
- Strengthen isolated execution and platform packaging without describing a worktree or container as a complete
  security sandbox.
- Add measured provider/version coverage and safe update/rollback evidence beyond the first stable matrix.
- Evaluate importable workflows and roles only after their permissions, attribution, versioning, and review contract
  are explicit.

## Later — broaden collaboration after local trust is earned

- Team workspaces, organization policy, reviewer assignment, and shared cost controls.
- Additional issue trackers, provider ecosystems, repository hosts, and deployment evidence.
- Remote or cloud coordination with an explicit encryption, identity, retention, and audit model.
- Delivery workflows outside software engineering only after the software loop proves sustained retention.

## Outside the current approved scope

- Automatic merge, push, deployment, retry/rollback, provider login, permission bypass, or silent dependency
  installation. A separately approved one-shot Guided Deploy is not automatic deployment.
- Marketplace execution, arbitrary workflow code, cloud sync, team accounts, or remote daemon exposure.
- Calendar commitments, public support SLAs, reaction-based prioritization, or a promise to accept every proposal.

## How priorities change

Use the [structured issue chooser](https://github.com/loomrail/loomrail/issues/new/choose) for reproducible bugs and
bounded product proposals. Reports, operational evidence, security findings, and issue reactions inform priorities,
but maintainers decide ordering against product scope, risk, dependencies, and release evidence. Suspected
vulnerabilities must use the [private reporting route](SECURITY.md).
