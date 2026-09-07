# Q19 real-provider-only API evidence

**Date:** 2026-09-06

**Status:** PARTIAL — deterministic adapter and product-boundary verification passed; credentialed execution and
workspace tool execution are pending.

## Verified locally

- OpenAI Responses and Anthropic Messages adapter suites assert API-key admission, exact provider-native output cap,
  context-window-aware request reservation, strict structured-result request, actual usage persistence input,
  malformed response rejection and over-budget rejection through injected test transports (47 OpenAI tests and 12
  Anthropic tests).
- Provider selection exposes exactly `CODEX` and `CLAUDE_CODE`; missing keys and unknown overrides fail closed.
- CLI setup and guided launch require the real-provider route.
- Protected landing contains no Mock provider copy or recorded synthetic run.
- The production `@loomrail/provider-mock` package and release-manifest entry were removed. Stateful workflow doubles
  live only under `apps/daemon/test` and identify as a real-provider contract fixture.
- New HTTP starts issue `START_PIPELINE`; old `START_MOCK_PIPELINE` remains readable only for append-only history.
- `pnpm verify` passed, including 244 daemon tests and 154 SQLite/migration tests. The complete Playwright suite passed
  60/60, including the real-provider Settings surface and the explicit executor refusal in guided activation.
- A release candidate was packed and `pnpm test:release` passed from a clean install, including setup, guided launch,
  receipt/file-integrity checks and operational-log lifecycle.

## Not claimed

No paid/live request was sent during this change: no provider credentials were supplied or authorized for use.
IMPLEMENT and QA remain absent from both API capability lists until a reviewed local workspace tool executor exists.
This evidence therefore does not promote stable release, full-route dogfood, macOS/Windows API compatibility or
real code-writing acceptance gates.
