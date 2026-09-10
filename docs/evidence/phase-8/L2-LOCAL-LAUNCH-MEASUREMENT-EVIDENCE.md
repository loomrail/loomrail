# L2 local launch-measurement evidence — Recurkit

**Status:** MECHANISM PASSED on macOS; measured target gates remain honestly non-passing

**Observed:** 2026-09-10

**Target:** private Recurkit working tree

## Production-shaped run

The built Loomrail daemon used the durable private-dogfood state and ordinary authenticated HTTP commands. The
owner-approved Verification Plan revision 3 was published with 11 recipes. Loomrail selected the exact optional
`SERVE` recipe for `apps/dashboard` / `start`, started the production dashboard on its declared loopback origin,
collected three fresh Chromium samples and proved the supervised process tree stopped.

- Launch Measurement Plan revision: `1`.
- Launch Measurement Run: `launchMeasurementRun-1eb62ee9-912e-4ebf-8ac7-37c747145d32`.
- Tested tree: `2d7dcefbef52126a3abedc25b76a3d33a9fa0198`.
- Terminal status: `FAILED`, with no runner error code.
- Freshness after completion: `CURRENT`, with no stale reasons.
- Active process after completion: none; the declared dashboard port had no listener.

The first publication attempt exposed a real monorepo defect and remained durable as
`FAILED / PROPOSAL_CHANGED`. The nested app manifest intentionally omits `packageManager`, while the recipe inherits
`pnpm` from the root manifest. Revalidation incorrectly inferred `npm` from the nested manifest. A regression test
reproduced the same typed refusal before the fix. Revalidation now checks exact nested script authority and exact
root package-manager authority separately. The normal owner `Retry publication` path then completed as `APPLIED`;
the follow-up current-target preview was adopted as revision 3 used by the run. No state or error was silently
rewritten.

## Measured gate results

| Gate                         | Result            | Bounded evidence                                                                 |
| ---------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `PERF_WEB_VITALS`            | `ACTION_REQUIRED` | LCP 3/3, CLS 3/3, INP 1/3; medians 100 ms / 0 / 16 ms where observed             |
| `PERF_BUNDLE_BUDGET`         | `PASSED`          | 3 samples; median 1,008,410 bytes under the owner-approved 3,000,000-byte budget |
| `SEC_RESPONSE_HEADERS`       | `FAILED`          | CSP, nosniff and referrer policy present; `Permissions-Policy` absent            |
| `SEC_UNAUTHENTICATED_ROUTES` | `ACTION_REQUIRED` | no private 401/403 route was approved for this plan                              |
| `SEC_CLIENT_BUNDLE_SECRETS`  | `PASSED`          | 1,008,410 bounded script bytes scanned; zero retained category counts            |
| `DEPS_AUDIT`                 | `ACTION_REQUIRED` | no owner-approved `AUDIT` recipe/current Q17 evidence exists                     |

Loomrail did not reinterpret missing evidence, a partial INP sample set or the absent response header as success.
This run validates L2 service lifecycle and evidence plumbing; it does not claim that Recurkit is production-ready.

## Privacy and authority

- No Codex or Claude session was started for L2. No OpenAI/Anthropic API key, direct provider API, paid request or
  login mutation was used.
- Recurkit's existing tracked and untracked owner changes were preserved. The dogfood updated only its already
  owner-managed `.loomrail/verification-plan.json` and ignored production build output; it did not commit, push,
  merge, install, deploy or call an external target.
- Persisted launch evidence contains numeric samples, header presence, HTTP status/count categories and typed
  references only. It excludes response/header values, cookies, browser bodies, service output, `.env` values,
  provider credentials, raw provider payloads and absolute personal paths.
- The Recurkit dashboard build completed before launch. It reported that local environment configuration existed but
  no value from it was printed or copied into this evidence.

## Candidate verification

After the monorepo publication fix and evidence update, the exact Loomrail candidate passed:

- `pnpm verify`: formatting, public-tree/security checks, lint, build and typecheck; 37/37 Node checks plus
  1,773/1,773 Vitest tests across 23 packages;
- `pnpm test:e2e`: 63/63 Playwright tests, including the local launch measurement UI and real local fixture;
- `pnpm test:fault-injection`: one interrupted crash-recovery run, no replay and one durable report;
- `pnpm audit --prod --audit-level high`: no known vulnerabilities;
- `pnpm pack:release && pnpm test:release`: receipt-backed `loomrail-0.1.0-alpha.5.tgz` built and executed from a
  clean installation with zero installed-package vulnerabilities;
- `pnpm release:status`: 9/11 gates passed, with only the two Windows Q20 provider-compatibility rows pending.

## Remaining platform gate

Windows lifecycle coverage is still pending by owner decision. This macOS result does not close either Windows
local-provider compatibility row or authorize L3/L4 deployment behavior.
