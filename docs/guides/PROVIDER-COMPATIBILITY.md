# Provider CLI compatibility

> Public pre-alpha · [Русская версия](PROVIDER-COMPATIBILITY.ru.md)

Loomrail treats a provider CLI as ready only when three independent observations agree: its executable exists, its
exact version has a reviewed compatibility row, and the provider-owned authentication status succeeds. Installation
or login alone is not a compatibility claim.

## Current matrix

The `0.1.0-alpha.5` candidate begins with no verified live-provider row. This is intentional: neither provider
promises a versioned backward-compatible schema for the whole JSONL event stream, and the existing recordings do not
prove the same invocation on both macOS and Windows.

| Provider    | Version  | Evidence                                                       | Managed live admission |
| ----------- | -------- | -------------------------------------------------------------- | ---------------------- |
| Mock        | built-in | Deterministic local, macOS, and Windows gates                  | `BUILT_IN` — ready     |
| Codex       | 0.144.1  | Real successful recordings on macOS arm64; MCP path unverified | `UNVERIFIED` — blocked |
| Claude Code | 2.1.114  | Real unauthenticated stream; successful result is derived      | `TOO_OLD` — blocked    |
| Codex       | 0.152.1  | Current upstream candidate; no Loomrail adapter run            | `UNVERIFIED` — blocked |
| Claude Code | 2.1.258  | Current upstream candidate; no Loomrail adapter run            | `UNVERIFIED` — blocked |

Upstream versions are the releases current at the 2026-09-02 research cut, not recommendations to install or
downgrade. See the [primary research](../product/PROVIDER-COMPATIBILITY-PRIMARY-RESEARCH-2026-09.md) for first-party
sources and the exact limits of each claim.

Until a live row is promoted, use the Mock walkthrough. AUTO stays on the clearly marked Mock fallback. Explicitly
selecting Codex or Claude Code keeps that choice visible but refuses a new provider process; it does not silently run
another provider or report Mock work as live work.

## Read the local status

Run:

```bash
npx loomrail doctor
```

Or open **Settings → AI provider** and choose **Check again**. Loomrail reports only a normalized version and one
closed status:

- `VERIFIED` — exact matrix row; authentication may then be checked;
- `UNVERIFIED` — version parsed, but no exact cross-platform row exists;
- `TOO_OLD` — below a documented admission floor;
- `VERSION_UNREADABLE` or `UNLAUNCHABLE` — the bounded version observation could not establish identity;
- `MISSING` — no executable was found;
- `BUILT_IN` — Mock only.

The version probe runs fixed `codex --version` or `claude --version` argv without a shell. It has a three-second
deadline, accepts at most 96 bytes of stdout, ignores stderr, and returns no executable path, raw output, account, or
exception text. Auth status is not invoked until the version is `VERIFIED`.

## Why there is no semver range

Both CLIs document JSONL and schema-constrained final output. The JSON Schema applies to the final model result, not
the complete stream envelope. Neither provider documents a backward-compatibility policy for every intermediate
event. Claude Code also documents schema and stdout-drain fixes within the same `2.1.x` line. Loomrail therefore does
not infer that `>=`, `^`, a newer patch, or `latest` is compatible.

Claude Code versions below `2.1.214` are not eligible for a new matrix row. This floor only rejects known-weaker
behavior; it does not make `2.1.214` or anything newer verified. Codex has no inferred floor or range.

## Promoting a version

A live version becomes `VERIFIED` only in a reviewed Loomrail change that records the exact CLI version, OS and
architecture, install kind, invocation-contract revision, sanitized real-CLI success/failure/workspace/MCP streams,
negative parser corpus, and matching macOS/Windows evidence. A provider update never edits the matrix automatically.

Capturing those streams starts real provider work and may spend quota, so it requires separate owner authorization.
Loomrail never runs an installer, updater, login, or downgrade command. Use the provider's official documentation to
manage its CLI, then keep using Mock until the installed version appears as `VERIFIED`.
