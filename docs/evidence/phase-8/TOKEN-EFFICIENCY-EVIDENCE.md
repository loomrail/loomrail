# Token-efficiency evidence

**Date:** 2026-09-12

**Source baseline:** `12bb55548c9fb550cdf0db1bbf7b177abd1822be`

**Branch:** `codex/token-efficiency`

## Measured before

The original public `loomrail@0.1.1` Recurkit ledger was opened read-only. Only aggregate numerical metadata was
read for this investigation: usage, context recipe section byte counts, workspace operation counts and output bytes.
No provider transcript, raw provider payload, credential, environment value or authentication record was copied.
The results exactly match the supplied baseline: 12 reports, 3,738,745 raw total, 3,715,210 input, 23,535 output,
3,127,296 cached input and 611,449 uncached input plus output.

[Per-stage baseline and tool counts](TOKEN-EFFICIENCY-BASELINE.json) distinguish actual usage from byte estimates.
Initial context recipes total only 26,598 estimated tokens, about 0.71% of raw provider usage. Actual provider input
includes provider-owned instructions and work within each CLI session; it cannot be inferred from pack size alone.
Repeated tool turns and retries are the dominant amplification mechanism consistent with the ledger. Exact
per-turn attribution is unavailable because production deliberately retains no raw transcript.

Concrete opportunities confirmed in source and metadata:

- every workspace result was serialized into both text content and structuredContent;
- 81 file reads and 57 directory listings repeated repository inspection across stages and attempts;
- IMPLEMENT returned 223,944 bytes from 16 recipe calls, while READ_ONLY REVIEW/QA attempted unavailable recipes;
- each stage loaded only its own checkpoint, losing structured Discovery/Plan handoff;
- audit activity occupied 22,828 bytes across the packs and appeared early in several role-specific prefixes;
- operational retries and real failures in the baseline remain part of usage, including exhausted provider allowance,
  a real High finding, unavailable verification services and an unavailable Browser QA target.

## Implemented controls

Workspace MCP now sends one complete text JSON result. Typed outcomes, whole-file digest, range/truncation metadata,
CAS, per-call audit and recovery are unchanged. No effect is memoized or converted into a synthetic success.

PLAN receives a successful DISCOVERY checkpoint; IMPLEMENT receives a successful PLAN checkpoint from the same
PipelineRun. Both remain untrusted structured artifacts with durable provenance, separate from the current attempt's
checkpoint. REVIEW receives no author checkpoint. Optional ACTIVITY is excluded with `STAGE_PROJECTION` provenance;
required activity in a custom template is preserved.

Per-stage initial-pack ceilings are 8k / 12k / 16k / 24k / 16k / 20k estimated tokens for Discovery through Acceptance.
The provider window and durable backoff may lower those ceilings. Required bytes never get clipped to fit. A source
count overflow now creates a durable owner gate before dispatch instead of silently dropping old Decisions. Restart
preserves both this gate and smaller retry budgets.

A stable shared policy prefix plus stage-specific guidance asks for targeted file ranges, reuse of recorded facts
and no unavailable recipe calls. It does not waive Project verification or Browser QA. Existing immutable role and
pipeline token envelopes remain POST_SESSION; the current local CLI session can overshoot before reporting usage.
The launch form states this limitation and the risk of expensive tool turns/retries. Session views show input,
output, cached input and uncached input plus output; unavailable cache attribution stays unknown.

## Deterministic benchmark

Run `pnpm benchmark:tokens` with the baseline commit available locally. The script loads the exact old renderer and
assembler through `git show`, records their SHA-256 hashes, and compares both on identical stage fixtures and six
identical bounded tool results per workspace-enabled stage; Acceptance has no tools on either side. It makes no provider call. Repeated runs produced identical JSON bytes.

[Benchmark output](TOKEN-EFFICIENCY-BENCHMARK.json): initial packs 32,632 → 18,337 UTF-8 bytes (43.81% smaller);
full Loomrail prompts 35,314 → 26,788 bytes (24.14% smaller); modeled cumulative tool-history input
1,066,963 → 599,992 bytes (43.77% smaller). Both sides receive the same tool-call
schedule; no savings from assumed fewer calls or successful cache hits are inserted into the model.

The comparison includes the new common policy and stage guidance in full. These are **bytes, not actual provider
tokens**. Provider-owned prefixes, tool definitions/call arguments, actual tool scheduling, model output and
cache hits are excluded. The CLI may normalize MCP content before model input; removing duplicate wire fields
is not proof that both copies previously reached the model. The benchmark therefore does not establish the requested >=50% uncached / >=40% raw
provider-token targets. It also is not measured Review, QA or Acceptance success evidence.

## One bounded production dogfood

One independent small documentation fixture ran through the installed, authenticated Codex CLI
`0.154.0-alpha.6.2` and the production provider registry. It is deliberately **not** an identical Recurkit replay.
The task requested one document under 30 lines about an existing local health endpoint. The fixture provided four
real, owner-adopted Project verification recipes and six configured Browser QA executions across desktop/light/en
and mobile/dark/ru. Configured checks are not reported as executed checks.

The unchanged limits were 600,000 pipeline tokens, 150,000 per AgentRun and a 20-minute harness deadline. Only one
PipelineRun and one budget revision exist. Discovery first returned an unanswerable `placeholder` NEEDS_HUMAN
request. One normal durable answer restated the already-approved requirements; the same pipeline continued, and
both Discovery sessions remain in the usage ledger. No stage was manually marked successful.

Discovery, Plan, Implement and independent Review completed. Review's terminal usage reached **151,891**, exceeding
its 150,000 envelope by 1,891 tokens. The next stage entered **HARD_PAUSED** before Project verification or Browser QA
dispatch. This demonstrates the documented POST_SESSION limitation and fail-closed boundary, not full delivery.
Acceptance was not created. Restart preserved the same status, attempt count and all five usage reports, with no
new provider session or side-effect replay. The daemon and fixture server were then closed; the budget was not raised.

[Actual sanitized dogfood ledger](TOKEN-EFFICIENCY-DOGFOOD.json):

| Stage      | Before raw | Observed after raw | Before cached | Observed after cached | Before uncached + output | Observed after uncached + output |
| ---------- | ---------: | -----------------: | ------------: | --------------------: | -----------------------: | -------------------------------: |
| Discovery  |    414,210 |            139,493 |       348,160 |               104,448 |                   66,050 |                           35,045 |
| Plan       |    359,186 |             13,747 |       318,720 |                     0 |                   40,466 |                           13,747 |
| Implement  |  1,642,472 |            117,924 |     1,339,904 |                83,456 |                  302,568 |                           34,468 |
| Review     |    988,436 |            151,891 |       854,272 |               117,632 |                  134,164 |                           34,259 |
| QA         |    320,028 |            Not run |       266,240 |               Not run |                   53,788 |                          Not run |
| Acceptance |     14,413 |            Not run |             0 |               Not run |                   14,413 |                          Not run |

The observed incomplete run totals **423,055 raw**, **419,501 input**, **3,554 output**, **305,536 cached input** and
**117,519 uncached input plus output**. The table is descriptive, not a controlled before/after experiment: the
project, task, number of attempts and completion differ. Subtracting those totals from the public baseline would
count omitted work as savings. **Actual raw, cached and uncached savings remain unmeasured; neither requested
provider-token reduction target is demonstrated.**

The run also shows why pack-only optimization is insufficient: its initial packs total 6,042 estimated tokens,
while five reports total 423,055 raw tokens. It used 16 file reads, four successful directory listings, one denied
listing and one successful write; zero recipe calls. Compact handoffs reduce repeated inspection but do not
eliminate provider-owned instructions or accumulated input inside a CLI session.

## Local verification

- Full `pnpm verify`: passed (format, public readiness, lint, typecheck and all package tests).
- Product `pnpm test:e2e`: 65/65 passed. After the last UI change, the two relevant E2E tests passed again,
  including light/dark, keyboard/focus, cached/uncached display, launch warning and the complete six-stage flow.
  The final attempt-nesting E2E rerun passed 2/2 after adding unavailable-cache coverage (totals retained,
  cache/uncached shown as unknown). Its first new fixture used null where the input contract requires omission;
  the fixture was corrected without changing production validation.
- Focused context assembly: 35/35; session integration: 28/28; session worker: 19/19. These cover exact required
  bytes, hostile checkpoint quoting, no author handoff to Review, durable source overflow without dispatch,
  real-window stage-cap backoff and upstream handoff across restart.
- Full `pnpm test:fault-injection`: passed in the final serial run, including 283 daemon tests and the crash drill.
  Earlier concurrent runs encountered an existing
  one-second Browser QA navigation deadline; no Browser QA assertion or timeout was weakened. The isolated Browser
  QA suite passed 37/37, and the independent crash drill passed with one interrupted run, no replay and one durable report.
- Benchmark output was byte-identical on two consecutive runs; its script passed ESLint. Formatting,
  whitespace, evidence arithmetic and sanitized-documentation checks passed.

Local verification used macOS Apple Silicon. Windows/Linux live-provider promotion is outside this change. Test
fixtures exercising provider-shaped responses remain test-only; they are not the production dogfood or its evidence.

## Forecast and residual limits

Exact future input/output/cache usage cannot be predicted from the local CLI's terminal-only usage contract.
Loomrail reports its deterministic initial-pack byte estimate and actual terminal usage separately; a configured
ceiling is not presented as a cost forecast. Calibration of a useful statistical per-stage forecast, a controlled
same-project provider comparison, and provider-side attribution of repeated prefixes remain future work.

Hash-only deltas and native session resume were rejected: ephemeral CLI sessions have no guaranteed shared memory,
and a provider cache is not authority. New sessions still need self-contained Decisions and policy. Reusing file
results across sessions would additionally require durable content validation and invalidation; this change does
not pretend that an unchanged path proves unchanged content. Full measured evidence and open findings remain
available, even when further prose compaction could save tokens. Large required inputs may hit the new stage
ceiling earlier; they pause rather than lose material needed for Review or acceptance.

Further work should measure privacy-safe per-turn counters where a supported CLI contract allows it, calibrate
forecast intervals on comparable completed runs, and evaluate content-validated file deltas. Provider-owned
instruction/schema overhead and tool-history accumulation require separate attribution; deleting Loomrail prompt
bytes alone cannot guarantee an end-to-end token target.

No new database migration is needed. New omission vocabulary is additive for this build; rollback uses a stopped
backup, not a promise that older binaries can interpret newer context recipes. No npm version, GitHub Release,
merge, provider install/update/login, direct provider API or separate API billing is part of this branch.
