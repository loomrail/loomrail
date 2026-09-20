# ADR-0035 — A code-blind planning coordinator

**Status:** Accepted for implementation; live qualification passed; compatibility admission pending

**Date:** 2026-09-19

The owner requests an opt-in strong planner which never reads or writes repository code, while Luna/Sonnet
perform all repository work. Existing Lead PM permissions and free-text handoffs do not provide that boundary.

Use a separate PLAN profile and immutable assignment mode. Discovery remains a cheap repository-reading worker;
the coordinator receives a separate explicit owner-authored outcome and closed status/count projections only.
It never receives ordinary task/criterion text, repository instructions, worker prose, source, paths, diff,
tool output, Decisions or raw transcripts. The owner must keep the separate outcome free of source code;
this is an explicit input contract, not a claim that arbitrary text can be semantically classified as code.

Only artifact output is permitted. Remove workspace/network/MCP authority and Constitution binding in the domain,
skip repository preparation for this agent, and validate the restricted invocation before any adapter spawn.
Keep the native CLI scratch/ambient-settings controls. Typed bounded work orders become a durable PLAN checkpoint;
the executor owns technical investigation and implementation. The domain owns dispatch, budgets, permissions,
independent Review, measured QA, recovery and final human Acceptance. No nested native agents or new workflow engine.

The first coordinator is explicitly pinned to CODEX / gpt-6-astra. Every other stage uses Luna or Sonnet according
to its selected provider, independently of global tier overrides. No alias or model fallback is allowed. Fable
remains unavailable until its billing and fallback behavior is separately authorized and qualified. Existing exact
runtime admission remains unchanged; this implementation is not evidence for new CLI versions or platforms.

One manager at the planning milestone avoids per-tool coordination overhead. It sacrifices technical detail in
the manager context to enforce source isolation; missing facts must stay unknown and workers must verify the plan.
No token-saving percentage or non-inferiority claim is justified before a separately authorized paired benchmark.

Coordinator Codex invocations explicitly set `agents.enabled=false`; disabling shell alone does not disable native
delegation. This setting is documented in the [official subagents reference](https://learn.chatgpt.com/docs/agent-configuration/subagents).
It is additional fail-closed configuration, not new live runtime qualification.

The opt-in Codex path also sets `project_doc_max_bytes=0` and the smallest positive
`skills.max_context_tokens=1`. Ignoring user config and execpolicy rules is not itself a guarantee that ambient
AGENTS instructions or the available-skills catalog are absent. The former blocks AGENTS text; the latter bounds
the unrelated catalog rather than advertising a supported global skills-disable switch. See the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Workers obtain their approved project instructions from Loomrail's normal context, not native ambient discovery.
