# ADR-0030: Bind standard deployment to environment-specific workflows and Preview evidence

**Status:** Accepted
**Date:** 2026-09-11
**Decision:** PD-031; L-track D4/D5/D7/D9
**Supersedes:** ADR-0029 only for new target selection; legacy records and all other ADR-0029 constraints remain

## Context

ADR-0029 introduced one owner-approved GitHub Actions dispatch, but its v1 target always named
`.github/workflows/deploy-production.yml` while the domain admitted only a `PREVIEW` Environment. The Recurkit
dogfood repository made the mismatch concrete: that workflow performs a real production deployment. Separately, a
Release embeds one Environment, so two Releases are needed for Preview and Production even when they carry the same
tree and evidence. Comparing Release ids or content hashes therefore cannot prove D5's “same snapshot” rule.

Allowing a free workflow path or environment input would turn the narrow preset into remote command authority.
Treating matching source SHAs alone as equivalent would let different gate/evidence snapshots borrow a prior
Preview. Rewriting immutable legacy records would destroy audit meaning.

## Decision

New plans use one v2 target with a closed mapping:

- `PREVIEW` → `.github/workflows/deploy-preview.yml`;
- `PRODUCTION` → `.github/workflows/deploy-production.yml`.

The daemon derives the path from the immutable Release Environment and passes the kind into the deployment driver.
The target, Plan, Deployment and approval digest all retain the kind. No caller supplies a workflow path or inputs.

Production STANDARD is eligible only when persistence supplies a prior v2 `SUCCEEDED` Preview Deployment from the
same Project whose Release Evidence Digest equals the current Production Release digest. The digest covers the
source tree, release-source identities, selected WorkItem evidence, gates and required/passed counts. It excludes
Environment data, Release identity, timestamps and presentation metadata. Domain code validates the qualifying
Deployment; the indexed persistence query is not the source of policy.

Legacy v1 records remain readable and observable by exact saved run id. They cannot be adopted again and cannot
qualify a Production promotion because they lack an environment-bound target and Release Evidence Digest.

## Consequences

- Preview and Production authority cannot be confused by one fixed filename.
- A Project needs a committed top-level `workflow_dispatch` workflow for the exact target Environment.
- Production cannot borrow a Preview from another Project, another evidence snapshot, a failed/unknown run or a
  legacy record.
- The same GitHub CLI adapter remains behind the existing `preflight / dispatch / observe` seam; provider adapters
  receive no deployment capability.
- HOTFIX, waivers, rollback, probes, automatic polling/retry and live dispatch remain unavailable.

## Rejected alternatives

- **One `deploy-production.yml` for both kinds:** the filename and observed Recurkit behavior contradict Preview.
- **Caller-supplied workflow or environment input:** broadens a closed preset into remote command execution.
- **Match only Git commit:** ignores changed evidence and gates on the same tree.
- **Rewrite v1 history as v2:** invents evidence that was never captured or approved.
