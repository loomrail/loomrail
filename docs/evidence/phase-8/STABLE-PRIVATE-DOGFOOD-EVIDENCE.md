# Stable private dogfood evidence — Recurkit Epic

**Status:** PASSED on macOS; Windows local-CLI compatibility remains a separate stable gate

**Observed:** 2026-09-10

**Target:** private Recurkit working tree

**Providers:** authenticated local Codex CLI and Claude Code CLI sessions only

## Result

The owner-approved private Recurkit Epic completed with three durable child WorkItems. Every child reached
`DONE` with an owner-accepted Acceptance Package. The first child has a persisted `BLOCKS` dependency on the
second child, so this evidence exercises Loomrail's domain-owned dependency graph rather than representing an
ordered checklist inside one Task.

| WorkItem                                        | PipelineRun                                        | Acceptance Package                                       | Result              |
| ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- | ------------------- |
| `workItem-1a574478-c97f-490d-b81c-628daf38882a` | `pipelineRun-2493302c-2c64-4b15-b558-9163e97c6533` | `acceptancePackage-5c8d88db-93ac-45da-b36e-9ef07138a5b1` | `DONE` / `ACCEPTED` |
| `workItem-7ffacc7d-65c0-4379-9797-09118d73f200` | `pipelineRun-124f72d0-9237-4143-b51b-eff6ed5bfae6` | `acceptancePackage-93803e10-020d-4cec-ba88-6685ffdd2e5f` | `DONE` / `ACCEPTED` |
| `workItem-752d8e07-4151-423c-b346-b0a788d24506` | `pipelineRun-d7f85f89-a82a-43b1-8cdb-8764afabd3b7` | `acceptancePackage-e0a1df7d-6d88-46e1-b65a-adba52c8e21a` | `DONE` / `ACCEPTED` |

Cancelled setup and overlap-diagnostic attempts remain cancelled audit history. They are not counted as passing
WorkItems or verification evidence.

## Final clean WorkItem

The final child used Codex for Discovery, Plan, Implement, QA synthesis and Acceptance preparation, and Claude Code
for independent Review. Loomrail, not either provider, owned workflow transitions, the immutable Project
Verification Plan, budgets, workspace authority, measured Browser QA and the owner's Acceptance decision.

- Project Verification Plan `verificationPlan-b15bbb34-ba3d-46c2-8710-4f7b388d5497`, revision 6, contained four
  required owner-approved recipes.
- The first run, `verificationRun-dfa734d8-d75a-431a-b145-fd62a1bd9396`, failed the required E2E recipe. Loomrail
  did not reinterpret it as success; the workflow entered correction.
- After correction, independent run `verificationRun-778b0208-9d81-432a-b5da-fdf986269755` passed lint, build,
  tests and E2E with exit code 0 on tree `bacb8eeb8a76234ed88195d6a1747af93dc77329`.
- The initial Browser QA attempt reported `TARGET_UNHEALTHY`. After the explicitly approved local target was started,
  `qaRun-dae4ee94-aad2-4774-8dc0-fe172f268b6b` passed on the same tree.
- Browser QA measured three password-reset scenarios in desktop/light/Russian and mobile/dark/Russian environments,
  retained six screenshots and two traces, and had no remaining observation or open High/Blocker defect.
- Acceptance was prepared only after Project verification and Browser QA agreed on the current tree. The owner then
  accepted it, completing the PipelineRun.

## Runtime, authority and recovery observations

- Both providers ran through their already authenticated local CLI sessions. No OpenAI or Anthropic API key,
  direct API transport, paid API call, login mutation or synthetic provider success was used.
- Workspace mutations were available only during authorized IMPLEMENT calls. QA provider access remained read-only;
  approved command execution belonged to the daemon-owned Verification Plan and Browser QA driver.
- The clean final run ended with zero `STARTED` workspace calls, zero running provider sessions, zero cross-session
  overlap and zero cross-stage overlap.
- A daemon restart during the Epic recovered durable cancelled state without replaying an uncertain mutation. The
  later clean run did not inherit background calls from cancelled attempts.
- Final-WorkItem provider accounting recorded 3,286,705 tokens across seven Codex reports and 841,720 tokens across
  two Claude reports. The owner-approved final policy allowed 6,000,000 tokens per PipelineRun and 1,500,000 per
  AgentRun after two explicit budget revisions; Loomrail did not infer allowance or silently widen the policy.
- No Recurkit commit, push, deployment, live SMTP delivery or external email was performed.

## Export and privacy check

A read-only acceptance/audit export contained 107,324 bytes. Its SHA-256 was
`63ecee7ef56071b5b7817725b6a74acae412aa391c1803bdea5b2417b48e8459`.

The retained export was scanned for provider credential names and credential-like prefixes, authenticated
session/CSRF values, and the owner's absolute local path. The match count was zero. This committed report contains
only bounded identifiers, counts and digests; it excludes credentials, `.env` content, raw provider payloads,
command output, private source text, screenshots, traces, runtime database bytes and personal paths.

## Gate interpretation

This closes the `privateDogfood` product gate for the macOS private Beta milestone. It does not close either Windows
local-CLI compatibility row, authorize a stable release, publish npm artifacts, or claim that Recurkit external
delivery/deployment was tested.

The Loomrail candidate carrying the resulting fixes passed full `pnpm verify`, the complete fault-injection and
crash-recovery gate, provider compatibility, guided activation, 62/62 product E2E, release packaging and
receipt-checked clean installation on macOS. The package privacy scan found no symlink, `.env`, personal path or
credential-like value. These source checks do not substitute for the two pending Windows live-provider rows.
