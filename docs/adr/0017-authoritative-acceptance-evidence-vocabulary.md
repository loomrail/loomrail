# ADR-0017: Acceptance uses an authoritative measured-evidence vocabulary

**Status:** Accepted

**Date:** 2026-09-08

## Context

Private local-CLI dogfood reached a pending AcceptancePackage whose durable Project verification evidence recorded
all required recipes as passed, while provider-authored release prose said those recipes were unavailable. The same
package bound Project Overview criteria to provider-authored QA check strings even though the measured Browser QA
plan exercised the login route. Every ID/tree/status lineage check passed, but the human-facing explanation could
still rename what the trusted evaluators had actually measured.

Q3 deliberately rejected semantic inference that arbitrary checks prove arbitrary criteria. That remains correct.
The missing control is narrower: a provider must not manufacture the vocabulary presented as measured evidence, and
must receive the trusted evaluator facts needed to prepare an accurate owner summary.

## Decision

Loomrail derives the check vocabulary of every measured QA EvidenceArtifact from the completed QARun plan and
QAEvidenceBundle. One bounded entry represents each executed scenario and includes its stable scenario identity,
title and measured target/assertion counts. Provider-authored QA title and summary remain advisory; provider-authored
`checks` are not persisted as measured checks.

Acceptance package status prose is also domain-owned. Release note, owner verification instructions and known-risk
status are derived from the exact current Review, measured Browser QA and Project verification evidence. Provider
output may explain the implementation and select an exact available Review/QA check for each criterion, but cannot
restate a passing trusted run as missing, denied or failed inside the authoritative package fields.

The Acceptance provider context includes the current measured QA plan/executions and current Project verification
result. These blocks are rendered as bounded untrusted-data descriptions where their repository-authored labels are
involved; IDs, statuses, counts and tree correlation remain daemon-derived facts.

This ADR does not infer semantic relevance between a criterion and a scenario. A visibly irrelevant selected check
remains grounds for the owner to return the package. A future typed criterion-to-evaluator coverage model requires a
separate product decision.

## Consequences

- A passing browser run can no longer be relabelled with checks it did not execute.
- Acceptance packages remain readable and truthful even when provider prose is stale or malicious.
- Existing persisted artifacts and packages remain readable; only newly created measured QA artifacts and packages
  use the authoritative projection.
- Provider stage-result schemas may retain advisory fields for compatibility, but the domain does not grant those
  fields evidence authority.
- The private dogfood run that exposed the mismatch stays `RETURNED`; it is evidence of the defect, not a passing
  stable gate.

## Required verification

- domain transition ignores invented QA checks and persists only deterministic measured scenario checks;
- domain transition ignores contradictory provider release/risk/verification prose in authoritative package fields;
- context assembly exposes measured QA during QA and Acceptance and exposes the current Project verification result;
- restart/idempotency preserves byte-identical derived package fields;
- release summary and UI distinguish provider explanation from trusted evaluator facts and leak no raw output,
  credentials, storage paths or absolute owner paths.
