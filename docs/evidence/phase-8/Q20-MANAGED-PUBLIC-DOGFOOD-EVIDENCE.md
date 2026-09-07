# Q20 managed public local-subscription dogfood evidence

**Date:** 2026-09-08 (Europe/Moscow)

**Status:** completed production rehearsal; owner Acceptance remains intentionally pending

## Scope and authority

This evidence covers one full public-fixture Task through the production local-subscription route. The run used the
built-in `fixtures/projects/web-app-a` Recipe 1, `Add explicit task-status filters`, with its published brief and
three acceptance criteria unchanged. Loomrail materialized the fixture into a temporary WorkItem workspace whose
path contained both a space and Unicode characters.

The run started from repository commit `8c07da687c2e71163afc7134c1071102fdba3e50`. It did not read a private
repository and did not copy Loomrail source or its working-tree changes into the fixture.

The owner approved use of the already installed, already authenticated local CLIs. No login, installation, update,
purchase, provider account mutation, direct provider HTTP request or API billing credential was used.

## Runtime identity

| Property                    | Observed value                         |
| --------------------------- | -------------------------------------- |
| Platform                    | macOS (`darwin`, `arm64`)              |
| Node used by the run        | `24.19.0`                              |
| Codex CLI                   | `0.153.4`                              |
| Claude Code CLI             | `2.1.260`                              |
| Provider authentication     | existing provider-owned local sessions |
| `OPENAI_API_KEY` present    | no                                     |
| `ANTHROPIC_API_KEY` present | no                                     |
| Provider usage accounting   | `POST_SESSION`, actual terminal usage  |

The local runtimes reached Loomrail only through the one-use loopback MCP proxy and the provider-neutral bounded
workspace executor. Production adapters handled their native argv, stream and tool-call formats internally.

## Workflow result

Production `AUTO` selection assigned authoring to Codex and independent Review to Claude Code:

| Stage      | Authority and observed result                                                                 |
| ---------- | --------------------------------------------------------------------------------------------- |
| DISCOVERY  | Codex inspected the public fixture; one typed owner question was resolved; stage succeeded    |
| PLAN       | Codex produced the bounded implementation plan; stage succeeded                               |
| IMPLEMENT  | Codex changed four fixture files and ran only the exact approved `package-test` recipe        |
| REVIEW     | Claude requested one Medium correction; Codex corrected it; Claude's second review passed     |
| QA         | daemon-owned verification and Browser QA passed; Codex received read-only synthesis authority |
| ACCEPTANCE | Codex built the package; PipelineRun and package are `WAITING_HUMAN` / `PENDING`              |

The owner did not accept, return or reject the package during this rehearsal. That decision remains outside model
authority.

Provider terminal reports recorded actual usage once per session: 12 reports, 1,813,503 input tokens, 27,177 output
tokens and 1,840,680 total tokens. Codex accounted for 1,668,909 total tokens and Claude Code for 171,771. The
3,000,000 PipelineRun budget remained authoritative; no in-flight token ceiling is claimed.

## Workspace and review evidence

The final public-fixture implementation tree was `7e0c7d4d93a3e07072682f4d710506a58ebbf67e`. Its bounded uncommitted diff
contained only:

- `src/server.mjs`;
- `src/tasks.mjs`;
- `test/server.test.mjs`;
- `test/tasks.test.mjs`.

The diff was 129 insertions and 9 deletions. `git diff --check` passed. A direct fixture run passed all 11 Node tests.

Claude Code's first cross-provider report reviewed tree `6edf9b264745e87a91285e2a778518a0ccdb174c` and requested changes for one
Medium finding: an unguarded URL parse could terminate the sample server for a malformed request target. Codex added
the guard and regression test. The finding is durably `RESOLVED`; Claude's second cross-provider report passed the
final tree with no findings.

## Verification and Browser QA

Q17 Project Verification ran the owner-approved `package-test` recipe (`npm test`) on the final tree. The required
check exited `0`; VerificationRun 1 is `PASSED` with terminal reason `ALL_REQUIRED_PASSED`.

The first Browser QA reservation ended with typed `TARGET_UNHEALTHY` because the explicitly configured loopback
sample server was not running. Loomrail did not fabricate evidence or reinterpret this as success. After the owner
started that server from the actual WorkItem workspace, a new run passed the same final tree:

| Target             | Theme | Assertions | Result |
| ------------------ | ----- | ---------- | ------ |
| `desktop-light-en` | light | 7          | passed |
| `mobile-dark-en`   | dark  | 7          | passed |

The durable bundle therefore contains two target executions, 14 assertions, no defects and verdict `PASSED`.

## Executor audit and restart behavior

IMPLEMENT recorded 9 successful `WRITE_FILE` calls, 19 reads, 11 directory lists and 7 successful runs of the exact
approved recipe. The completion gate used the successful mutation audit from the same Project, WorkItem and domain
StageAttempt; it did not trust provider prose or require a duplicate write after a HumanRequest continuation.

QA recorded 4 reads and 3 directory lists. It recorded no write or delete call. A provider-requested recipe in QA was
refused with typed `NETWORK_POLICY_UNAVAILABLE`; the earlier daemon-owned Project Verification result remained the
only command evidence. Review likewise had read-only authority; two recipe attempts were denied with the same typed
code.

The daemon was deliberately restarted on the same durable data after provider boundaries and the workflow continued
without state editing. The final database contains 10 completed and 2 interrupted provider sessions, zero
`STARTED` workspace calls and zero duplicated `(ProviderSession, providerCallKey)` pairs. No active StageAttempt was
orphaned at the selected restart boundary, so no synthetic `RecoveryReport` was created. Unknown effects were not
replayed.

## Defects found by the rehearsal

The production run exposed four Loomrail integration defects, all fixed with regression coverage before this
evidence was recorded:

1. The provider-visible recipe tool schema did not enumerate the exact IDs captured by executor policy. It now uses
   that bounded enum without exposing argv, labels or environment.
2. The directory-list tool did not tell providers that `.` is the portable workspace-root spelling. Its description
   now states that contract.
3. A Resume after passing Browser QA and then pausing on budget could reserve a new QA attempt and try to reopen
   completed correction state. Exact passing evidence is now reused only for the same attempt, tree, plan/target and
   correction lineage.
4. IMPLEMENT completion originally looked only at the final ProviderSession, so a valid mutation before a resolved
   HumanRequest could be ignored. The deterministic gate now owns the correct Project/WorkItem/StageAttempt boundary;
   another work item, attempt or correction still cannot satisfy it.

During diagnosis the live workflow encountered the fourth gate defect twice and hard-paused honestly. It advanced
only after the implementation and persistence query were corrected, rebuilt and the owner chose the normal retry
path. No database mutation, test double, hidden fallback or synthetic success was used.

## Privacy review and limits

The saved evidence contains no provider transcript or raw payload, bootstrap/session/CSRF value, file contents,
command output, `.env` value, credential, provider account identifier, private-repository data or absolute personal
path. Durable workspace audit rows contain only scoped IDs, safe relative targets, digests, sizes and typed statuses.

This macOS public-fixture result does not prove Windows local-CLI compatibility, a private 2–3 Task dogfood Epic,
protected landing evidence or registry provenance. Those stable gates remain independent and `PENDING`.

## Repository verification

The final working tree used Node `24.19.0` and pnpm `11.21.0`:

- `pnpm verify` passed formatting, public-tree/toolchain/activation checks, lint, strict typecheck and every package
  test; the largest relevant counts were domain 303, persistence 157, daemon 251, Codex adapter 47, Claude adapter
  12, MCP gateway 27 and workspace executor 4;
- the complete product Playwright suite passed 60/60;
- the protected landing Playwright suite passed 7/7, including light/dark, keyboard entry and 320/375/414/768-pixel
  overflow checks;
- `pnpm pack:release` built `loomrail-0.1.0-alpha.5.tgz`;
- `pnpm test:release` installed that archive into a clean temporary environment with 0 reported vulnerabilities and
  passed samples, setup, local CLI diagnostics, receipt, installed-file and log-lifecycle checks.

The six open dependency-update PRs were reproduced in this tree: Fastify `5.12.3`, Zod `4.5.4`,
`@types/react-dom` `19.2.7`, `eslint-plugin-react-refresh` `0.5.6`, `actions/deploy-pages` `5.0.1` and
`actions/upload-artifact` `7.0.1`. The first combined verification exposed that an empty approved-recipe set was
published as an invalid empty JSON Schema enum under Zod `4.5.4`. Loomrail now omits `loomrail_run_recipe` when there
is no exact approved ID, and a real-proxy empty-plan regression plus the original daemon restart scenario pass.

The stable manifest must remain `PENDING` until these evidence bytes are bound to an exact reviewed commit, SHA-256
digest and main-branch ancestry.
