# ADR-0015: Local subscription-authenticated provider runtimes

**Status:** Accepted

**Date:** 2026-09-07

**Supersedes:** ADR-0013; amends ADR-0012 and ADR-0014

## Context

ADR-0013 replaced the production Mock with direct OpenAI Responses and Anthropic Messages requests. That route
requires API keys and usage-based API billing separate from the user's Codex or Claude subscription. The owner has
now rejected that product boundary: Loomrail is intended to orchestrate the official agent runtimes already installed
and authenticated on the user's machine, as other local agent harnesses do, without asking the user to copy a
provider credential into Loomrail.

Launching a CLI in the repository is not an acceptable replacement. Codex and Claude Code normally expose built-in
filesystem, shell, hooks, plugins and ambient configuration under the owner's OS account. A provider model and its
output remain untrusted. The runtime must therefore be prevented from bypassing Loomrail's workflow, permission,
workspace, recipe, audit and recovery authority.

The CLIs also report token usage after a turn. A subscription-authenticated local runtime does not currently expose
an exact provider-enforced Loomrail token ceiling for the active request. Calling this `HARD` would repeat the defect
recorded in ADR-0012. The owner has explicitly chosen the local-subscription route over the API-only hard-token-cap
route.

## Decision

### Production providers and authentication

- Production providers are the locally installed official Codex CLI (`CODEX`) and Claude Code CLI
  (`CLAUDE_CODE`). The stable provider IDs are unchanged.
- Loomrail launches each CLI as a supervised child process. The CLI itself reads its official cached login created by
  `codex login` or `claude auth login`; Loomrail never reads, copies, stores, exports or logs the underlying access
  token.
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are not Loomrail provider configuration. Direct OpenAI/Anthropic HTTPS
  adapters and automatic API fallback are removed from the production registry.
- Missing executable, missing login, unsupported version or incompatible security controls produce typed unavailable
  or blocked state with a provider-specific next action. They never select Mock, a direct API, another credential
  source or a synthetic success.

### Runtime containment

Each provider session runs in a fresh temporary directory, with provider session persistence, project instruction
discovery, ambient MCP configuration, hooks/plugins and built-in filesystem/shell/browser tools disabled by the
strongest documented fail-closed flags for the admitted runtime version. The selected repository path is not passed
as the CLI working directory or an additional directory.

The only workspace capability visible to the runtime is a one-use, loopback, session-scoped MCP connector. Its child
proxy holds an unguessable ephemeral capability and forwards only the closed tools from ADR-0014. The daemon invokes
the provider-neutral `WorkspaceToolExecutor`; adapters only translate the provider-specific CLI/MCP configuration and
parse the provider stream. Closing or revoking the ProviderSession closes the connector.

Codex runs with user configuration/rules ignored, an empty read-only scratch root, no web search and its native
shell plus general code-mode host disabled. Current GPT-5.6 metadata otherwise hides every MCP tool behind code
mode, so the adapter enables only the explicitly supplied `mcp__<session>` namespaces as direct tools. Its
non-interactive MCP acknowledgement is set to `approve` only for that closed enabled-tools list; this is not
filesystem or command authority, which remains in the executor.

Claude Code runs with setting sources empty, strict explicit MCP configuration, `--restricted`, an empty built-in
tool set, an exact Loomrail MCP allowlist, no Chrome/slash commands and no session persistence. `--safe-mode` is
intentionally not combined with this boundary because the admitted CLI disables explicitly supplied custom MCP
servers in safe mode. A runtime version for which these exact controls have not been verified is not ready. No
permission-bypass flag is ever enabled.

### Budgets and lifecycle

Both local adapters declare `POST_SESSION` token enforcement. Loomrail still owns immutable run, WorkItem, Project and
daily token ledgers; it refuses a new session when the remaining allowance is exhausted and records provider-reported
usage exactly once. During a session, outer wall-clock deadline, process-tree cancellation, bounded output, finite
turn/tool-call limits and loop detection are hard controls. Provider-native budget signals may be used only as an
additional compatible guard and are never presented as an exact Loomrail token cap.

`POST_SESSION` is eligible only because this ADR changes the approved product budget semantics for local
subscription execution. UI must label the limitation plainly: the current response can finish above the configured
token estimate; the limit prevents subsequent work, not already-consumed provider work. Cost/quota reporting stays
provider-attributed or unavailable and is never inferred from a subscription.

### Tests and live evidence

Automated adapter tests launch test-only CLI doubles and a real local proxy/executor; they never use production Mock
or provider HTTP transports. Live dogfood may reuse an already-authenticated local CLI after explicit owner approval,
but does not authorize account changes, CLI installation/update, API keys, purchases or direct API requests.

The approved macOS arm64 runtime check on 2026-09-07 used Codex CLI `0.153.4` and Claude Code `2.1.260`. Focused
IMPLEMENT and QA sessions for both providers reached the real Loomrail MCP proxy/executor in a temporary workspace
whose path contained spaces and Unicode: IMPLEMENT performed an audited read and write, while QA performed audited
read-only inspection. No credential, account field or raw provider payload was retained. This proves the focused
runtime slice on that host, not the complete private-project workflow or Windows compatibility.

## Consequences

- A user installs and signs in to the official CLI once; Loomrail discovers and reuses that login automatically.
- Loomrail does not offer API keys as a workaround and cannot silently consume separate API credit.
- Workspace operations remain provider-neutral, audited and recoverable. The model cannot invent argv, environment,
  repository paths or wider permissions.
- Exact in-flight token caps are no longer promised. Time, turn, tool and output limits remain preventive; token
  accounting stops later sessions.
- The same-OS-account child and local proxy are still not a complete OS sandbox. Version admission and the absence of
  built-in tools are release gates; failure to prove either blocks the provider.
- Claude Code versions lacking the required restricted/strict-MCP controls remain installed-but-incompatible until the user
  updates them through the provider's own supported flow.
