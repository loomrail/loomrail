# Q13 final security and reliability evidence

**Date:** 2026-09-03

**Implementation gate commit:** `2f54346`

**Cross-platform follow-up commit:** `1ddd835`

**Scope:** final internal security/reliability review and macOS/Windows release-candidate gates

## Review outcome

Independent Standards and Spec reviews inspected the implementation against repository rules, product decisions,
Q13 plans, ADRs and the threat model. Their final delta reviews report no P0/P1/P2 findings. The review rounds drove
the runtime corrections rather than only auditing them after the fact.

The resulting boundaries include:

- immutable AgentRun policy gates provider, capability, model, budget, workspace, network, MCP and session authority;
- no ProviderSession starts without a RUNNING StageAttempt and active authoritative AgentRun in the same transaction;
- Soft Pause preserves an in-flight turn, while owner cancel and hard-budget stop retain authority until provider
  shutdown is confirmed;
- restart recovery keeps writer authority for an unconfirmed orphan process and self-heals only after safe evidence;
- Acceptance Manager is artifact-only and cannot make the owner's Accept, Return or Reject decision;
- REVIEW receives an exact Constitution snapshot and bounded actual diff; Browser QA stays read-only/offline and
  provider evidence is framed as untrusted input;
- BrowserDriver and recovery boundaries expose closed typed errors and reject symlinked managed-root traversal.

## Local verification

- format, the 645-file public-tree/toolchain gate, full build and workspace typecheck pass;
- landing-excluded ESLint reports no findings;
- the complete workspace tests pass, including 116 persistence and 210 daemon tests;
- the complete browser matrix passes 53/53;
- fault injection and the process crash drill pass with one interruption, no replay and one durable report;
- the production dependency audit reports no known vulnerabilities;
- the 73-entry `0.1.0-alpha.5` tarball passes receipt, installed-file, samples, setup, launcher and log-lifecycle checks
  from a clean temporary installation.

No Q13 commit changes `apps/landing/**`, starts a live provider, publishes a package, creates a tag or claims stable
release completion.

## Cross-platform verification

[GitHub Actions run 33760230993](https://github.com/loomrail/loomrail/actions/runs/33760230993) verifies the final Q13
source on macOS and Windows:

| Evidence                                   | macOS                             | Windows                           |
| ------------------------------------------ | --------------------------------- | --------------------------------- |
| Production audit and named policy gates    | pass                              | pass                              |
| Crash and fault recovery                   | pass                              | pass                              |
| Receipt-checked clean package installation | pass                              | pass                              |
| Browser smoke                              | 53/53                             | 53/53                             |
| Repository source verify                   | protected landing lint only (3/3) | protected landing lint only (3/3) |

The first Q13 run, `33758287696`, exposed two pre-existing Git-backed repository-repair tests whose 30-second whole
test timeout was too narrow for the slower Windows runner. The product assertions did not fail; timeout cleanup then
encountered an open SQLite file. Commit `1ddd835` gives only those two filesystem-heavy tests a 60-second lifecycle
budget. The repeated Windows fault gate passes all 210 daemon tests and the crash drill. It does not weaken the
assertions, skip Windows, increase a product deadline or mask a failure.

Both final source jobs reach ESLint after format, public-tree, toolchain, build and the named platform gates, then
stop only at `apps/landing/src/main.ts` lines 630, 631 and 634. That separately owned directory is neither changed nor
excluded from repository-wide verification.

## Remaining stable-release evidence

Q13 is complete, but stable release is not. Private dogfood, one exact quota-bearing live-provider compatibility row,
the protected landing gate and trusted registry provenance remain open. The current evidence does not authorize an
npm publication, tag, GitHub Release or dist-tag mutation.
