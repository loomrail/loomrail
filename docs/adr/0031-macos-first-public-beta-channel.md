# ADR-0031: Separate the macOS-first Public Beta channel from cross-platform Stable

**Status:** Accepted

**Date:** 2026-09-11

**Decision:** PD-032

## Context

Loomrail has committed live Codex CLI and Claude Code CLI execution evidence for `darwin/arm64`, accepted private
Recurkit dogfood, public rehearsal, protected landing evidence and green source/browser/package CI on macOS and
Windows. The two remaining stable gates require equivalent real local-CLI execution on Windows. The owner has chosen
to publish a public Beta now while explicitly deferring that live Windows evidence.

Treating the nine passed rows as an eleven-row Stable release would falsify compatibility. Keeping every public build
labelled pre-alpha would hide the demonstrated macOS boundary. A separate release channel can publish the proven
scope without weakening the existing Stable contract.

## Decision

The release boundary has two closed channels:

- `BETA` accepts only `0.1.0-beta.N`, maps only to npm dist-tag `next`, and requires the nine non-Windows rows in the
  release evidence manifest;
- `STABLE` accepts only plain semver, maps only to npm dist-tag `latest`, and continues to require all eleven rows.

Both channels require the exact package version, main commit, typed owner confirmation, unused npm version, the same
six successful macOS/Windows source/browser/clean-install CI jobs, a main-only protected GitHub Environment, OIDC
trusted publishing, `npm stage publish` and separate interactive npm 2FA approval. Neither channel accepts a caller
supplied dist-tag or publish command.

The manifest records separate exact Beta and Stable version selections. Windows rows remain `PENDING` for the first
Beta. Public documentation and compatibility surfaces name `darwin/arm64` as the verified live-provider target and
state that Windows/Linux dispatch is unsupported until an exact row is promoted. The product continues to fail
closed on every unverified platform/version and provides no Mock or API fallback.

## Consequences

- A public Beta can be distributed without misrepresenting Windows provider compatibility.
- `latest` remains unchanged until the original cross-platform Stable gate reaches 11/11.
- Green Windows CI proves package/code portability only; it is never interpreted as live-provider compatibility.
- Promotion to Stable needs new Windows evidence and a separate version/owner confirmation; Beta publication cannot
  waive or mutate those requirements.
- The existing trusted workflow remains the only publish entrypoint and gains a closed channel choice with fixed
  tags, keeping the npm trust relationship narrow.

## Rejected alternatives

- **Mark the Windows rows passed from synthetic CI:** fabricates live-provider evidence.
- **Publish the Beta as `latest`:** makes an unsupported-platform prerelease the default install.
- **Delete Windows from the Stable gate:** silently changes the promised first stable platform set.
- **Publish locally with a token:** bypasses protected review, OIDC provenance and stage-only approval.
