# ADR-0033 — Stage context and single-copy workspace tool results

**Status:** Accepted

**Date:** 2026-09-12

## Context

The public 0.1.1 documentation workflow reported 3,738,745 raw tokens. Durable pack recipes account for only
26,598 byte-estimated input tokens across twelve sessions. Workspace MCP responses repeat each result in both
text and structuredContent. Each new stage reads only its own checkpoint, so Discovery and Plan findings never
reach their next consumer. Audit activity varies early in the prefix without providing task authority.

## Decision

Use one complete text JSON tool result with its existing typed fields, digest, range, truncation and error status.
There is no outputSchema requiring structuredContent on this tool surface. Audit reservation/completion stays
before delivery. Do not memoize effects or claim a stale read as current; CAS and measured evidence remain unchanged.

An opt-in production assembly policy omits only optional ACTIVITY and applies per-stage pack ceilings. Required
sections are never omitted. All Decisions within the existing 200-source bound are retained in full; a 201st
record detects overflow and causes an explicit refusal instead of silently losing the oldest decisions.
Stable execution instructions precede variable sections.

PLAN may receive the latest successful DISCOVERY checkpoint; IMPLEMENT may receive the latest successful PLAN
checkpoint from the same PipelineRun. These are untrusted structured artifacts, not acceptance or permissions.
The current attempt's checkpoint remains separate and takes precedence for continuation. REVIEW never inherits
an author's checkpoint. A new provider session always receives self-contained authority; a hash-only delta cannot
work with ephemeral CLI sessions and is deliberately rejected. Native resume/transcript transfer is not added.

Stage guidance asks for targeted bounded reads, reuse of supplied evidence, and no attempts to call unavailable
recipes. It does not waive checks. Context caps are preventive byte-estimate bounds; the existing immutable role
and pipeline envelopes remain POST_SESSION token controls. Predictions cannot know provider-hidden prompts,
cache hits, number of turns or output length; label estimates and unknowns instead of promising exact spend.

## Recovery and security

No new runtime cache or mutable summary store exists. Handoffs are queried with context in one SQLite snapshot,
lineage is included in recipe provenance, and failures use existing typed pause/recovery paths. Checkpoint and
repository text remain untrusted; fresh Review, recipe grants, exact-tree verification and Acceptance are untouched.

## Verification

Compare old and new assembly on identical deterministic fixtures. Verify optional omission provenance, required
floor refusal, hostile delimiter handling, full decision retention, upstream stage/cycle isolation, restart replay,
single-copy MCP delivery, UI themes/keyboard and unchanged measured end-to-end gates. Keep actual dogfood usage
separate from modeled bytes and disclose failures or non-comparable scenarios.
