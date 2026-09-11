# Public Beta release evidence

**Date:** 2026-09-11

**Release:** `loomrail@0.1.0-beta.1`, npm tag `next`, Git tag `v0.1.0-beta.1`

**Exact source:** `a8073175cff13568f5be2eb018cb6b812c17bd5a`

## Gate state

- Beta gate: 9/9 passed.
- Stable gate: 9/11 passed. `codexWindowsCompatibility` and `claudeWindowsCompatibility` remain `PENDING`; synthetic
  Windows CI is not represented as real local-provider evidence.
- Local `pnpm verify` passed after the release-order regression fix.
- Exact-source [CI run 34631868733](https://github.com/loomrail/loomrail/actions/runs/34631868733) completed with all
  six macOS/Windows Verify, Browser smoke and Clean install jobs successful.

## Failed-closed rehearsal and fix

The first protected staging run `34618695093` stopped before packaging or registry staging because Chromium had not
been installed before `pnpm verify` reached the real BrowserDriver tests. It created no npm stage and made no registry
change. A regression test now requires the Chromium installation step to precede source verification. Commit
`a8073175cff13568f5be2eb018cb6b812c17bd5a` contains that fix, and both local verification and the succeeding trusted
workflow exercised the corrected order.

## Trusted staging and registry publication

- The `npm-release` GitHub Environment required an owner review and accepted only `main`.
- Exact-source [stage run 34635473637](https://github.com/loomrail/loomrail/actions/runs/34635473637) passed the release
  intent, dependency audit, source verification, fault injection, browser E2E, packaging and clean-install gates.
- The stage-only npm trusted publisher produced stage `93b92768-eb32-4605-b70d-5913f4d22fa3` with signed provenance.
  A separate interactive owner approval published it; the stage queue was empty afterward.
- The public registry reported name/version `loomrail@0.1.0-beta.1`, SHA-1
  `5e855220d37b8a2c9b65bf70d882003d39d360a5` and integrity
  `sha512-s9hQ+p57Deoed2R1km3ZNrTCFd70ItRvSZfpAwKM6hDAY7WkKV7qI+2D0r4MmY1I6Cfdc7wrJVQ/hsnn/ol75w==`.
- `next` resolved to `0.1.0-beta.1`; `latest` remained `0.1.0-alpha.1`.
- The provenance statement was recorded at
  [Sigstore log index 2797042075](https://search.sigstore.dev/?logIndex=2797042075).

## Public-registry clean install

The exact public version was installed with lifecycle scripts disabled into an empty temporary project whose path
contained spaces and Unicode. The host's default Node 22 correctly produced the package's engine warning; all runtime
checks then used the supported pinned Node `24.19.0`.

- npm installed 189 packages and reported 0 vulnerabilities.
- `npm audit signatures` verified registry signatures for all 189 packages and attestations for 24 packages.
- `setup --mode live --json` returned `READY`, with browser and live route ready.
- `doctor --json` admitted local Codex CLI `0.153.4` as authenticated and verified. The installed Claude Code
  `2.1.114` was honestly reported `TOO_OLD` and not ready; no fallback or promotion occurred.
- The packaged daemon bound to loopback, `/health/ready` returned `ready`, and `/` served the Loomrail Workbench.
- No provider model session or paid API call was made during this registry smoke.

## Public surfaces and privacy

- Exact-source [Pages run 34637832616](https://github.com/loomrail/loomrail/actions/runs/34637832616) completed both
  protected build/browser and deploy jobs successfully.
- The live [landing page](https://loomrail.github.io/loomrail/) identifies Public Beta and the macOS Apple Silicon
  boundary.
- The [GitHub prerelease](https://github.com/loomrail/loomrail/releases/tag/v0.1.0-beta.1) and npm package point to the
  exact release identity above.
- No API keys, `.env` values, provider transcripts, raw provider payloads, cookies, bootstrap URLs or absolute local
  paths are recorded in this evidence.

## Stable boundary at Beta publication time

At the moment this Beta was published, PD-032 still required owner-approved Windows Q20 evidence for the first Stable.
PD-033 / ADR-0032 subsequently replaced that platform set with an explicit `MACOS_ARM64` Stable support target while
preserving both Windows rows as pending. This evidence remains a historical record and does not itself authorize the
later Stable release.
