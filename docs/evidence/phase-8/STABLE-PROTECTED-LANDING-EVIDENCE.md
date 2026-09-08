# Stable protected landing evidence

**Date:** 2026-09-08

**Scope:** canonical activation contract consumption and protected GitHub Pages build/deploy

## Proven boundary

The public landing imports `packages/contracts/src/guided-activation.v1.json` directly and renders its exact five
install commands in order. Its unit and browser tests compare visible and copied commands with that same source. The
independent activation verifier rejects duplicated commands, version drift and removal of the Pages trigger.

The Pages workflow is path-scoped to the landing, its reviewed assets, the canonical activation contract and its
verifier. The build job has read-only repository permission; only the dependent deploy job receives Pages write and
OIDC identity permissions. The static public surface has no account, form, analytics, external runtime resource or
local-daemon authority.

## Fixed-surface Pages evidence

Commit `1cf4b2523e9624445efff577113387dcb1f4a32d` produced
[Pages run 34165990314](https://github.com/loomrail/loomrail/actions/runs/34165990314), where both `Build static
landing` and `Deploy landing` completed successfully. The build job passed:

- the canonical activation contract verifier;
- landing typecheck, unit tests and production build;
- the protected landing browser gate;
- Pages artifact creation and upload before the separately permissioned deploy.

GitHub Pages reports `https://loomrail.github.io/loomrail/` with HTTPS enforcement and workflow-based publication from
`main`.

## Current-tree identity

The successful Pages commit is an ancestor of Q15 candidate `dd4f5ac3593c45541d8236fe89209d4ac29937e9`.
An exact Git diff is empty between those commits for:

- `.github/workflows/pages.yml`;
- `apps/landing/**` and `docs/assets/**`;
- the CLI package metadata and canonical activation contract;
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the activation verifier/tests.

Therefore the deployed and browser-tested protected surface is byte-identical in all scoped inputs to the current
candidate. This evidence does not claim private dogfood, Windows live-provider compatibility, npm publication or a
stable version.
