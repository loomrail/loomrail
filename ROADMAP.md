# Loomrail public roadmap

Loomrail is public pre-alpha software. This roadmap describes the current order of outcomes; it is not a schedule,
support promise, or substitute for the versioned [product decisions](docs/product/PRODUCT-DECISIONS.ru.md) and
[master plan](docs/product/MASTER-PLAN.ru.md). Completed engineering detail lives in release notes and historical
implementation plans.

## Now — prove the first stable local delivery loop

- Close every macOS and Windows release gate without bypassing protected source checks.
- Admit exact live Codex and Claude Code CLI versions only after separately authorized, quota-bearing compatibility
  evidence; keep unknown versions fail-closed.
- Complete one private dogfood epic across discovery, planning, implementation, independent review, measured Browser
  QA, restart recovery, bounded budget, criterion-linked acceptance, and owner approval.
- Preserve the completed final review's zero-P0/P1 boundary and produce trusted registry provenance before any stable
  publication.

## Next — connect the proven loop to normal repository delivery

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

## Not planned before stable

- Automatic merge, push, deployment, provider login, permission bypass, or silent dependency installation.
- Marketplace execution, arbitrary workflow code, cloud sync, team accounts, or remote daemon exposure.
- Calendar commitments, public support SLAs, reaction-based prioritization, or a promise to accept every proposal.

## How priorities change

Use the [structured issue chooser](https://github.com/loomrail/loomrail/issues/new/choose) for reproducible bugs and
bounded product proposals. Reports, operational evidence, security findings, and issue reactions inform priorities,
but maintainers decide ordering against product scope, risk, dependencies, and release evidence. Suspected
vulnerabilities must use the [private reporting route](SECURITY.md).
