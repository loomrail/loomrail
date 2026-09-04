# ADR-0010 — Session-scoped durable provider usage

**Status:** Accepted

**Date:** 2026-09-03

## Context

Live Codex and Claude Code adapters already emitted validated usage, but the daemon only logged it. The existing
UsageRecord ledger had one positive token amount and no place for provider input/output/cache/reasoning/cost detail
or ProviderSession/AgentRun lineage. Applying a provider report after a stage result would also leave a crash window
in which the daemon could start another session before spend caused a hard pause.

Providers expose different token shapes. Codex reports total input with cached input as detail. Claude reports
ordinary input, cache creation and cache read separately. Adding every exposed field in shared code would
double-charge Codex; using Claude's ordinary input alone would severely undercount a cache-heavy session.

## Decision

- A ProviderSession accepts one final cumulative ProviderUsage report, never streaming deltas.
- Each adapter normalizes `inputTokens` to all input classes. Cached/reasoning fields are attribution subdivisions
  and are not summed again.
- An append-only ProviderUsageReport stores exact execution lineage, detailed usage, optional provider cost, quality
  and a SHA-256 digest. SQLite enforces one report per ProviderSession.
- A positive `inputTokens + outputTokens` total creates one linked UsageRecord so thresholds, Insights and budget
  override retain one ledger. A zero report is durable but creates no artificial positive ledger row.
- The deterministic domain compares both pipeline cumulative usage and AgentRun cumulative usage with the immutable
  limits that own them.
- Recording a cap-crossing report atomically persists usage/audit, hard-pauses WorkItem/run/attempt, completes the
  dispatch, finishes AgentRun and releases its workspace lease. The daemon aborts and ends the ProviderSession only
  after that transaction commits.
- Budget hard pause opens no Human Request and uses no session-failure code. The existing versioned owner Budget
  Override is the only continuation path. It may raise either the pipeline cap or the per-AgentRun ceiling that was
  captured in the stopped attempt; raising one does not silently inflate the other, and a new AgentRun receives the
  new immutable policy revision.
- A live adapter exposes its validated tier-to-model mapping through the provider registry. The daemon resolves and
  persists the exact model ID in the immutable AgentRun policy before starting the CLI; the adapter executes that
  snapshot value. Historical snapshots without it retain the adapter-mapping fallback.

## Consequences

### Positive

- callback retry and daemon restart cannot double-charge or bypass the pause;
- provider detail remains inspectable without forking the budget/reporting ledger;
- Claude cache-heavy runs count their actual input magnitude;
- the owner sees exact reported quality and optional cost without raw provider output.

### Costs and risks

- adapters that cannot report usage still rely on the separate bounded session guard;
- token caps remain a provider-neutral control, not a currency-equivalent cost cap;
- a provider that changes cache field semantics requires an adapter compatibility review;
- one final report cannot stop spend earlier than the provider's terminal reporting boundary.

## Rejected alternatives

- **Log only:** preserves diagnostics but enforces no budget.
- **Store detail only in UsageRecord:** widens a stable ledger into provider-specific semantics.
- **Count cached/reasoning fields again:** double-counts providers where those fields are subdivisions.
- **Pause after END_PROVIDER_SESSION:** leaves a restart/next-session race between accounting and control.
- **Open a Human Request:** creates a second continuation mechanism beside Budget Override.

## Required tests

- schema total/link invariants and strict command input;
- domain below-cap, threshold, effective AgentRun cap and lineage refusal;
- SQLite transaction, replay, duplicate/actor refusal, restart read and append-only triggers;
- daemon records a live report and aborts before another session when the cap is reached;
- Claude recording proves ordinary + cache creation + cache read normalization;
- Task Cockpit renders token detail, quality and optional cost without relying on colour.
- provider-selection, domain and adapter tests prove that the owner-visible model mapping and executed snapshot ID
  cannot drift.
