# ADR-0027: Owner-approved local launch measurements

- Status: Accepted
- Date: 2026-09-10
- Decision owners: Loomrail maintainers
- Supersedes: none
- Extends: ADR-0014, ADR-0020, Q17 and the L track

## Context

Loomrail can already execute finite owner-approved verification recipes and collect deterministic Browser QA
evidence from a loopback target. Neither mechanism proves launch-specific facts. A verification recipe is expected to
terminate, while a local application server must remain alive during measurements. Browser QA records product
scenarios, but does not own performance budgets, response-header policy, unauthenticated-route expectations, client
bundle secret scanning or dependency-audit linkage.

Treating provider prose, an already-running arbitrary process or a repository-authored URL as launch evidence would
create a second, unaudited source of truth. Reusing a provider workspace tool would also give an AgentRun authority
over a project-level release gate.

## Decision

L2 introduces a project-level `LaunchMeasurementPlan` and append-only `LaunchMeasurementRun`.

The plan is adopted only by the authenticated owner and is bound to an exact active Verification Plan. It selects one
`SERVE` recipe, an optional `AUDIT` recipe, one bare loopback origin, bounded same-origin paths, three to five browser
samples and explicit numeric budgets. The stored plan contains no secret values, shell string, arbitrary executable,
external origin or provider payload.

For monorepos, the verification proposal scanner may additionally discover service scripts from direct conventional
`apps/<portable-name>/package.json` manifests. This bounded discovery is limited to regular non-symlink directories,
at most 32 app entries, the closed `start | dev | preview` vocabulary and the existing 12-recipe Plan cap. It does
not parse workspace glob languages, recurse, execute manifest text or propose nested finite checks. The resulting
recipe still carries exact manifest hash, package-manager argv and canonical relative cwd and is revalidated before
spawn. Inherited package-manager authority is revalidated against the exact root manifest while the service script
is revalidated against the exact nested manifest; neither source may drift independently.

The daemon starts only the exact adopted `SERVE` recipe through the existing verified executable resolver, scrubbed
environment and process-tree supervisor. It waits for the exact loopback health path, collects measurements, then
stops and proves the complete process tree stopped before releasing authority. An early exit, timeout, output cap,
tree mutation, cancellation or daemon restart is a typed outcome. If process-tree termination cannot be proved, the
Run remains active as durable `BLOCKED / SERVICE_TERMINATION_FAILED`: no second Run may start and the owner may retry
the safe stop. A missing process record is not stop proof for an already blocked Run. Automatic replay is forbidden.

`packages/browser-qa` exposes one additional deep, provider-neutral measurement operation. Its input is the validated
plan snapshot; its output is a closed typed projection containing only numeric samples, response status/header
presence, aggregate script bytes and secret-finding counts. Response bodies, header values, cookies, credentials,
absolute paths and raw browser/provider payloads never cross the contract or enter SQLite.

The domain, not the driver, calculates the six gate results:

- `PERF_WEB_VITALS`;
- `PERF_BUNDLE_BUDGET`;
- `SEC_RESPONSE_HEADERS`;
- `SEC_UNAUTHENTICATED_ROUTES`;
- `SEC_CLIENT_BUNDLE_SECRETS`;
- `DEPS_AUDIT`.

`DEPS_AUDIT` links to a current Q17 `AUDIT` check on the same tree; L2 does not parse arbitrary audit text or run a
second hidden command. A missing applicable input is `ACTION_REQUIRED`, not success. Freshness is derived from the
current tree, active Launch Measurement Plan and active Verification Plan. L3 may reference this evidence but cannot
rewrite it.

Provider adapters receive neither adoption/run commands nor measurement payloads. Launch measurements do not change
workflow state, provider budgets, permissions, Acceptance or Git state and grant no commit, push, merge, install,
deploy or external-network authority.

## Consequences

- The service recipe lifecycle is distinct from finite Verification Runs, while executable/path/environment safety is
  shared.
- `BLOCKED` deliberately retains project-level execution authority until recovery proves the process tree stopped;
  it is not a terminal failure or a synthetic cleanup success.
- Repository configuration is untrusted proposal material until owner adoption; changing it cannot mutate an active
  plan silently.
- A locally compromised same-user process remains able to race loopback traffic. Exact loopback admission, fresh
  browser contexts and bounded evidence reduce exposure but are not an OS sandbox.
- Windows automated lifecycle coverage is required with paths containing spaces and Unicode. Credentialed provider
  execution is unrelated and remains a separate stable gate.
- L4 deploy and external post-deploy probes remain prohibited until their separate product decision.
