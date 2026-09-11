# ADR-0032: Stable releases are scoped by an explicit support target

**Status:** Accepted

**Date:** 2026-09-11

**Decision:** PD-033

## Context

Loomrail has published a verified macOS Apple Silicon Beta and has complete product, security, private-dogfood,
landing, package and exact Codex/Claude live-provider evidence for `darwin/arm64`. Windows source, process, browser and
clean-package CI is green, but real Windows local-provider evidence is still absent. The owner chose to make the
proved macOS product the first default Stable release without claiming Windows or Linux compatibility.

Equating Stable with every planned platform would keep a proved platform permanently prerelease-only. Simply dropping
the Windows rows would hide the limitation and let future releases accidentally claim support they do not have.

## Decision

Release eligibility is the pair **Release Channel + Release Support Target**. `STABLE` continues to require a plain
semver and maps only to npm `latest`; the first selected target is the closed value `MACOS_ARM64`. That target requires
the nine existing product/security/private-dogfood/landing and macOS live-provider gates. Windows compatibility rows
remain `PENDING` in the same manifest and are neither passed nor required for this target.

The manifest stores the exact Stable version and target. Missing or unknown targets fail closed. Public surfaces must
name macOS Apple Silicon as the only supported live-provider target, while provider admission continues to refuse
Windows/Linux. The six-job macOS/Windows source/browser/clean-install CI matrix, exact main SHA, protected reviewed
environment, OIDC stage-only trusted publisher and separate npm 2FA approval remain mandatory.

A future target containing Windows requires a new product decision, both exact Windows live-provider evidence rows,
a new version and the complete protected publication flow. Existing Stable status or npm `latest` is not evidence for
an unlisted platform.

## Consequences

- `0.1.0` may be Stable for `darwin/arm64` while Windows/Linux remain visibly unsupported and fail closed.
- Stable describes maturity inside its declared support target, not cross-platform coverage.
- Green Windows CI continues to prove code/package portability only.
- The release verifier must reject target drift independently of channel, semver and evidence status.
