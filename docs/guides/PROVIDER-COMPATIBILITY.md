# Provider API compatibility

> Public pre-alpha · [Русская версия](PROVIDER-COMPATIBILITY.ru.md)

Loomrail has two runtime provider adapters: OpenAI Responses and Anthropic Messages. There is no selectable
synthetic provider and no successful fallback. If neither API credential is configured, new provider work is blocked.

## Current matrix

| UI choice          | Internal ID   | Credential          | API             | Current stages                      |
| ------------------ | ------------- | ------------------- | --------------- | ----------------------------------- |
| OpenAI Responses   | `CODEX`       | `OPENAI_API_KEY`    | `/v1/responses` | Discovery, Plan, Review, Acceptance |
| Anthropic Messages | `CLAUDE_CODE` | `ANTHROPIC_API_KEY` | `/v1/messages`  | Discovery, Plan, Review, Acceptance |

The internal IDs remain stable because they already exist in durable workflow history. They do not mean Loomrail
launches a provider CLI. Both active adapters use HTTPS APIs and a provider-native output-token cap.

`IMPLEMENT` and `QA` are intentionally unavailable. Those stages need a security-reviewed local workspace executor
that can produce measured file and command evidence. Loomrail does not accept provider prose as proof that a file was
changed or a test ran.

## Configure and inspect

Set one key in the same process environment that starts Loomrail:

```bash
export OPENAI_API_KEY="..."
# or
export ANTHROPIC_API_KEY="..."
npx loomrail doctor
```

On PowerShell, set `$env:OPENAI_API_KEY` or `$env:ANTHROPIC_API_KEY`. Loomrail reports credential readiness but never
prints or persists the key. In **Settings → AI provider**, select one provider explicitly or leave **Auto** enabled.
Auto picks only a ready adapter that supports the requested stage and has hard token-budget enforcement.

`LOOMRAIL_PROVIDER=CODEX` or `LOOMRAIL_PROVIDER=CLAUDE_CODE` locks the process-wide selection. An invalid value or a
missing credential blocks work; it never redirects to a different provider.

## Evidence status

Protocol parsing, token-cap construction, abort behavior, response validation, selection, persistence, and restart
paths are covered with injected network transports and local integration tests. Those tests make no paid calls.
Credentialed fixed-commit runs and Windows/macOS provider evidence remain release gates and are recorded as pending
until an owner authorizes quota-bearing verification.

The superseded CLI compatibility tables remain in historical plans and evidence as an audit record. They do not
describe the current runtime.
