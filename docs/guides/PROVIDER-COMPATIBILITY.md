# Local provider compatibility

> Stable for macOS Apple Silicon · [Русская версия](PROVIDER-COMPATIBILITY.ru.md)

Loomrail runs one of two official local agents: Codex CLI or Claude Code CLI. There is no selectable synthetic
provider, direct provider API route, API-key configuration, or successful fallback.

## Current matrix

Stable live execution is verified only on `darwin/arm64`: Codex CLI `0.153.4` and `0.154.0-alpha.6.2`, and Claude
Code CLI `2.1.260`. Each value is an exact admitted target, not a semver range. Windows and Linux rows are unverified
and provider dispatch fails closed on those targets.

| UI choice       | Internal ID   | Login owned by | Required safety surface                          | Stages         |
| --------------- | ------------- | -------------- | ------------------------------------------------ | -------------- |
| Codex CLI       | `CODEX`       | Codex CLI      | ephemeral exec, read-only scratch, Loomrail MCP  | All six stages |
| Claude Code CLI | `CLAUDE_CODE` | Claude Code    | restricted mode, strict allowlisted Loomrail MCP | All six stages |

The internal IDs remain stable because they already exist in durable workflow history. Provider-specific command
arguments and stream payloads stay inside their adapters. The domain model—not the CLI—owns workflow state,
permissions, gates, budgets, and acceptance.

## Install, sign in, and inspect

Install an official CLI by following its provider documentation, then sign in through that CLI:

```bash
codex login
# or
claude auth login
npx loomrail doctor
```

An existing working login is enough. Loomrail does not ask for `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, does not read
the stored OAuth/session credential, and does not create separate API charges. Doctor reports only installation,
normalized version, compatibility, and authenticated/not-authenticated state.

In **Settings → AI provider**, select a provider or leave **Auto** enabled. Auto selects only a locally installed,
exact-version-compatible, authenticated CLI that serves the requested stage. `LOOMRAIL_PROVIDER=CODEX` or
`LOOMRAIL_PROVIDER=CLAUDE_CODE` locks the process-wide selection but cannot bypass compatibility, login, workspace
permissions, or budgets.

## Workspace and budget boundary

The CLI runs in a fresh empty scratch directory and receives no repository path, provider API key, `.env` value, or
arbitrary project environment. It can touch the selected workspace only through one-use loopback MCP tools backed by
Loomrail's provider-neutral executor. Every operation is path-confined, permission-checked, bounded, audited, and
idempotent.

The official CLIs expose usage after a session rather than an exact token interrupt. Both adapters therefore declare
`POST_SESSION`: Loomrail has hard elapsed-time, turn, tool, command-output, and provider-output limits, reconciles
actual usage to its durable ledger, and blocks later work when needed. The current CLI turn may exceed its token
estimate; the UI states this instead of presenting a false hard token cap.

## Evidence status

Adapter streams, safe arguments, environment filtering, aborts, schema validation, workspace allow/deny paths,
idempotency, restart recovery, selection, and persistence are covered by real-CLI recordings, test-only CLI fixtures
and local integration tests. Codex `0.154.0-alpha.6.2` additionally completed the production six-stage flow with an
audited IMPLEMENT mutation, a passing required Project check, measured Browser QA, restart recovery and owner
Acceptance on one tree. Test automation does not invoke a paid API. Compatibility remains fail-closed for an
unverified OS/version target. Windows source, browser and clean-install CI is green, but it is not live-provider
evidence and does not expand the Stable support target.

Historical API and older CLI matrices remain in dated plans and evidence as an audit record. They do not describe the
active runtime boundary.
