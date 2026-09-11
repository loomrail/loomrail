# Stable 0.1.0 release evidence

**Date:** 2026-09-11

**Release:** `loomrail@0.1.0`, npm tag `latest`, Git tag `v0.1.0`

**Release Support Target:** `MACOS_ARM64` (`darwin/arm64`)

**Exact source:** `6388e26159eaa574186ce65795de992268bb4f4b`

## Gate state

- Stable gate: 9/9 gates required by `MACOS_ARM64` passed.
- The full compatibility index remains 9/11. `codexWindowsCompatibility` and `claudeWindowsCompatibility` remain
  `PENDING`; macOS Stable does not reinterpret source CI as real Windows local-provider evidence.
- Local `pnpm verify`, `pnpm test:fault-injection`, 65/65 product E2E scenarios, release packaging and clean-package
  verification passed before the exact source was pushed.
- Exact-source [CI run 34642101594](https://github.com/loomrail/loomrail/actions/runs/34642101594) completed all six
  macOS/Windows Verify, Browser smoke and Clean install jobs successfully.
- Exact-source [Pages run 34642101612](https://github.com/loomrail/loomrail/actions/runs/34642101612) completed both
  protected build/browser and deployment jobs successfully.

## Trusted staging and registry publication

- The `npm-release` GitHub Environment required owner review, allowed only `main` and admitted the exact selected
  source, `STABLE` channel, `0.1.0` version and `MACOS_ARM64` target.
- Exact-source [stage run 34645158260](https://github.com/loomrail/loomrail/actions/runs/34645158260) repeated source,
  fault-recovery, browser, package and clean-install gates. It produced signed stage
  `8de79d9e-20a9-4d2a-b337-58323d5d43c1`; separate owner WebAuthn approval published it and left the stage queue empty.
- The public registry reports name/version `loomrail@0.1.0`, SHA-1
  `90d78922313086a5a3ed51c11fa7eae929c59134` and integrity
  `sha512-hZBTiQz7vEj/M8b74Y6iod81LL/PjuWue0UWFBSBT02SRn/QGRNxVfOQrOcE87jTNy6uQVEdxGTKiEeDtuwn1A==`.
- `latest` resolves to `0.1.0`; `next` remains on the published `0.1.0-beta.1`.
- The provenance statement is recorded at
  [Sigstore log index 2798197699](https://search.sigstore.dev/?logIndex=2798197699).

## Public-registry clean install

The exact public version was installed with lifecycle scripts disabled into a new temporary project whose path
contained spaces, Greek and Cyrillic Unicode. The host default Node 22 correctly produced the package engine warning;
all runtime checks then used the supported pinned Node `24.19.0`.

- npm installed 189 packages and reported 0 vulnerabilities.
- `npm audit signatures` verified registry signatures for all 189 packages and attestations for 24 packages.
- `setup --mode live --json` returned `READY`, with browser and live route ready.
- `doctor --json` admitted Codex CLI `0.153.4` and Claude Code CLI `2.1.260` as authenticated, verified and ready for
  all six workflow stages. No provider credential was requested or read by Loomrail.
- The installed daemon bound to loopback, `/health/ready` returned `ready`, `/` served the Loomrail Workbench and
  SIGINT produced a clean shutdown.
- No provider model session or paid API call was made during this registry smoke.

## Public boundary and privacy

- The [landing page](https://loomrail.github.io/loomrail/), package metadata and
  [GitHub release](https://github.com/loomrail/loomrail/releases/tag/v0.1.0) identify Stable as macOS Apple
  Silicon-only.
- Windows source, browser, process-lifecycle and clean-package CI is green, but real Windows Codex/Claude execution
  remains unverified. Windows and Linux dispatch stays fail closed and no support is claimed for them.
- There is no Mock, direct provider API route, token credential, synthetic success or hidden fallback.
- No API keys, `.env` values, provider transcripts, raw provider payloads, cookies, bootstrap URLs or absolute local
  paths are recorded in this evidence.
