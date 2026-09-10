# ADR-0029 — Owner-approved GitHub Actions deployment

**Status:** Accepted
**Date:** 2026-09-10
**Decision:** PD-030; L-track D3/D4/D7/D9/D10

## Context

L3 can describe an Environment and freeze a Release, but deliberately has no deploy authority. Recurkit already
keeps its production credentials and VPS procedure inside a repository-owned GitHub Actions workflow. Copying that
procedure into Loomrail would make the local daemon an SSH/VPS credential holder, duplicate the repository's deploy
truth and exceed the L4 v1 boundary.

A dispatch is irreversible and the local process can lose its response after GitHub accepted it. A retry or a
search for the newest workflow run can therefore create or attach to the wrong deployment.

## Decision

L4 v1 adds one deep provider-neutral `DeploymentDriver` contract with typed `preflight`, `dispatch` and `observe`
outcomes. Its only production adapter is `GITHUB_ACTIONS_WORKFLOW_V1`. Provider adapters and provider sessions do
not import this contract and receive no deployment tool.

The preset dispatches only the repository-owned `.github/workflows/deploy-production.yml` through the locally
authenticated GitHub CLI. Loomrail never receives the workflow's GitHub Environment, VPS or hosting secrets. The
owner first adopts an immutable Deployment Plan and then approves one exact Deployment. The approval digest binds
the Release content hash, Environment identity, plan revision and content hash, repository slug, branch, commit,
workflow content hash, exact argv and intent.

Before a Plan is adopted, the adapter proves that:

- the registered path is the canonical Git top level and no merge/rebase/cherry-pick/bisect is in progress;
- the working tree equals `HEAD`, and `HEAD^{tree}` equals the immutable Release tree;
- `HEAD` is on a named branch and `origin/<branch>` resolves to the same commit;
- the origin is a credential-free `github.com/<owner>/<repository>` remote;
- the fixed workflow is a committed, regular non-symlink file under the repository and its bounded bytes are hashed.

The process is launched without a shell, with fixed executable/argv, deadline and output limit. Its output is
untrusted, sanitized and never persisted verbatim. Dispatch success is accepted only when stdout contains exactly
one strict Actions run URL for the expected repository and numeric run id. If the process may have reached GitHub
but no exact id is available, the Deployment becomes `UNKNOWN`; it is never retried or correlated by "latest run".

Observation is read-only and names the exact captured run id. The adapter validates typed JSON, repository URL,
event and commit before returning a closed status. Startup changes every interrupted `RUNNING` Deployment to
`UNKNOWN`; only an explicit owner observation can reconcile it.

L4 v1 does not execute SSH, hosting CLIs, arbitrary workflow inputs, automatic retries, automatic rollback or
automatic probes. A rollback is shown as `UNAVAILABLE` until a later preset can prove and dispatch an exact previous
Release using a repository-owned contract.

## Consequences

- Existing repository deploy procedures remain the source of operational truth; Loomrail owns approval, gates,
  identity, audit and recovery.
- GitHub CLI authentication is user-owned. Loomrail stores no token and does not accept a token through HTTP,
  provider output or a HumanRequest.
- A clean commit already present on the remote is mandatory. Local dirty or ahead-only Recurkit work cannot be
  deployed by this preset.
- An ambiguous outcome requires human reconciliation and may remain `UNKNOWN` permanently.
- Other repository hosts and deployment mechanisms require a separate preset and threat delta, not a looser argv
  field.

## Rejected alternatives

- **Run the Recurkit SSH/VPS commands locally:** duplicates deploy logic and exposes production secrets to Loomrail.
- **Accept arbitrary workflow path, inputs or command text:** turns a narrow deploy capability into remote command
  execution.
- **Find the latest run after dispatch:** races with other users and cannot prove identity after a lost response.
- **Retry an ambiguous dispatch:** can deploy twice.
- **Call provider tools to deploy:** gives untrusted provider output irreversible authority.
