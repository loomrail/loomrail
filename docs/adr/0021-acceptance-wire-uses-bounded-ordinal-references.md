# ADR-0021: Acceptance provider wire uses bounded ordinal references

**Status:** Accepted

**Date:** 2026-09-09

## Context

Private Recurkit dogfood reached the Acceptance Manager after passing independent Review, Project verification and
measured Browser QA. Codex refused the generated strict output schema before starting the turn because one current
Review check contained quoted source text. Loomrail had embedded exact repository/provider-derived criterion and
check strings as JSON Schema enum literals. Those strings are already untrusted input and valid domain text, but
provider structured-output implementations accept a narrower schema dialect and may reject particular literal
contents. A rejected schema left the honest run waiting for owner attention and produced no AcceptancePackage.

Removing the closed vocabulary from validation would make the run start, but would weaken ADR-0017: a provider could
again invent or rename an evidence check. Escaping or rewriting the literal would also break exact domain binding.

## Decision

The provider-neutral Acceptance wire contract refers to the ordered current vocabulary by zero-based integer
indices. The schema contains only bounded integers and provider-authored explanatory fields; it never embeds the
criterion or evidence strings as `enum` or `const` values.

The invocation prompt renders one bounded, ordered reference table for acceptance criteria, Review checks and
measured QA checks. The text remains explicitly untrusted context, not instructions. Each claim must use its
criterion's exact position, and every reference is bounded by the corresponding list length.

After runtime schema validation, `provider-core` resolves the indices against the immutable
`ProviderAcceptanceInput` used to build that same schema and prompt. Only then does it construct the existing
`AcceptanceCriterionClaim` with exact strings. The domain continues to verify ordered total criterion coverage and
membership in the current Review/QA artifacts before any AcceptancePackage state change.

This is a wire representation only. Persisted contracts, evidence vocabulary, final owner authority and provider
selection do not change. Both Codex and Claude Code use the same provider-neutral representation; their native schema
transport remains inside their adapters.

## Consequences

- Arbitrary valid criterion/check text cannot make a provider-native strict schema invalid.
- The provider still cannot invent a criterion or evidence check; out-of-range, duplicate or reordered criterion
  references fail closed before the domain command.
- Raw schema failures remain typed operational attention and never become a synthetic Acceptance pass.
- Prompts contain the already-authorized bounded evidence text but schemas, logs and persistence gain no raw provider
  payload or credential data.
- Historical string-valued Acceptance results remain decodable only through the existing non-indexed compatibility
  path when no current Acceptance input is supplied; new production invocations always use indices.

## Required verification

- JSON Schema generated from hostile but bounded text contains no criterion/check literals;
- quotes, backslashes, Unicode and control-like text round-trip through index resolution to exact domain claims;
- out-of-range, duplicate and reordered references are rejected;
- Codex and Claude adapter tests both exercise the same indexed Acceptance schema and decoder;
- a real local Codex Acceptance Manager resumes the failed durable attempt and opens only the normal owner gate.
