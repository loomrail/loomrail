# Q11 public-intake and roadmap evidence

**Date:** 2026-09-03

**Scope:** local source policy and live repository configuration; macOS/Windows CI pending

## Public repository observations

The exact public `loomrail/loomrail` repository has Issues enabled. Its previously documented Private Vulnerability
Reporting route was disabled, so an external reporter could not use the canonical `security/advisories/new` path.
The repository setting is now enabled and a read-back reports `{"enabled":true}`. No issue, advisory, label, project,
assignee or release was created.

The committed source adds two issue forms and one chooser config. Bug intake requires version/commit, OS, install and
provider routes, current/expected behavior and synthetic reproduction steps. Product proposals require a problem,
bounded outcome, acceptance evidence and security/privacy impact. Both refuse implicit priority and require
public-data, existing-scope and conduct acknowledgements. Blank external issues are disabled; the two contact routes
are the private advisory and public roadmap.

## Roadmap observations

The root roadmap exposes outcome-ordered Now/Next/Later and explicit pre-stable non-goals without calendar targets or
support promises. It names the still-open live-provider, private dogfood, opt-in telemetry, security review,
provenance and full cross-platform release gates. It links back to normative product decisions/master plan and states
that issue activity is input rather than priority authority.

README, docs index, CONTRIBUTING and SECURITY link the structured chooser, roadmap and private route. Historical
implementation plans remain engineering records rather than a competing public roadmap.

## Local verification

- `pnpm test:community` validates the exact regular/bounded template set, required top-level and body fields, unique
  IDs, exact required-field contract, no upload request, safety copy, private route, disabled blanks, roadmap headings
  and cross-document links.
- Five standard-library policy tests cover the valid tree and refuse public blanks, missing private routing, weakened
  required fields and a dated roadmap commitment.
- Prettier parses and formats the YAML forms; focused ESLint and `git diff --check` pass. The public-tree gate accepts
  616 files with the pinned Node/pnpm toolchain.
- Full workspace tests pass, including 15/15 root policy tests, 198/198 daemon, 33/33 CLI and every other workspace
  suite. Full build and workspace typecheck pass.
- Production dependency audit reports no known vulnerabilities.
- Repository-wide `pnpm verify` passes format, public-tree, toolchain and full build, then reports only the three
  protected `apps/landing/src/main.ts` ESLint findings on lines 630, 631 and 634.
- Q11 changes no runtime API/state, package tarball, provider adapter, npm publication or `apps/landing/**` file.

## Remaining evidence

The named community gate must still pass on macOS and Windows. Repository-wide Verify may remain red only for the
separately developed protected landing. Q11 does not close telemetry, final security review, exact live-provider row,
private dogfood, trusted registry provenance or the stable-release gate.
