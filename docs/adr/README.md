# Architecture decision records

ADR фиксирует одно архитектурное решение, контекст, последствия и условия пересмотра. Accepted ADR не редактируется
так, будто прежнего решения не существовало: существенное изменение оформляется новым ADR со ссылкой на superseded
record.

## Index

| ADR                                                                  | Status                | Decision                                             |
| -------------------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| [0001](0001-typescript-monorepo-baseline.md)                         | Accepted              | TypeScript monorepo and runtime baseline             |
| [0002](0002-sqlite-state-and-audit.md)                               | Accepted with CI gate | Relational SQLite state plus append-only audit       |
| [0003](0003-loopback-session-security.md)                            | Accepted              | Loopback-only daemon and one-time browser bootstrap  |
| [0004](0004-one-owner-gate-per-stage-attempt.md)                     | Accepted              | One provider owner gate until explicit retry         |
| [0005](0005-daemon-owned-mcp-gateway.md)                             | Accepted with CI gate | Daemon-owned MCP process, policy and audit seam      |
| [0006](0006-read-only-tool-plugin-sdk.md)                            | Accepted with CI gate | Read-only MCP tool Plugin SDK v1                     |
| [0007](0007-marker-bound-project-scaffolding.md)                     | Accepted              | Marker-bound durable Project scaffolding             |
| [0008](0008-separate-qa-correction-runs.md)                          | Accepted              | QA correction identity separate from review rounds   |
| [0009](0009-previewed-owner-initiated-reporting.md)                  | Accepted              | Previewed owner-initiated public-alpha reports       |
| [0010](0010-session-scoped-provider-usage.md)                        | Accepted              | Session-scoped durable provider usage                |
| [0011](0011-explicit-shared-current-directory-authority.md)          | Accepted              | Explicit shared current-directory authority          |
| [0012](0012-enforceable-provider-token-budgets.md)                   | Superseded by 0013    | Fail closed without a provider-enforced token cap    |
| [0013](0013-real-provider-api-only.md)                               | Superseded by 0015    | Real OpenAI/Anthropic APIs; no active Mock fallback  |
| [0014](0014-provider-neutral-workspace-executor.md)                  | Accepted              | Bounded neutral filesystem and approved-recipe tools |
| [0015](0015-local-subscription-cli-runtimes.md)                      | Accepted              | Local authenticated CLIs; no provider API keys       |
| [0016](0016-local-cli-stable-release-gates.md)                       | Accepted              | Stable gates follow the local CLI product boundary   |
| [0017](0017-authoritative-acceptance-evidence-vocabulary.md)         | Accepted              | Acceptance names only measured evaluator evidence    |
| [0018](0018-provider-runtime-engine-version-admission.md)            | Accepted              | Admission identifies the actual session engine       |
| [0019](0019-domain-owned-work-item-dependency-dag.md)                | Accepted              | WorkItem execution order is a domain-owned DAG       |
| [0020](0020-read-only-loopback-websocket-browser-qa.md)              | Accepted              | Bounded read-only loopback WebSockets for Browser QA |
| [0021](0021-acceptance-wire-uses-bounded-ordinal-references.md)      | Accepted              | Acceptance wire binds evidence through safe indices  |
| [0022](0022-kind-aware-project-verification-deadlines.md)            | Accepted              | E2E proposals receive a bounded longer deadline      |
| [0023](0023-mcp-lease-drains-in-flight-workspace-calls.md)           | Accepted              | Session close drains accepted workspace calls        |
| [0024](0024-local-provider-deadline-covers-one-verification-call.md) | Accepted              | Local session covers one maximum verification call   |
| [0025](0025-handoff-deadline-joins-the-session-task.md)              | Accepted              | Handoff joins session task before successor          |
| [0026](0026-safe-verification-plan-context-projection.md)            | Accepted              | Safe immutable verification-plan context projection  |
| [0027](0027-owner-approved-local-launch-measurements.md)             | Accepted              | Owner-approved local launch measurements             |
| [0028](0028-domain-owned-release-evidence-snapshots.md)              | Accepted              | Immutable domain-owned Release evidence              |
| [0029](0029-owner-approved-github-actions-deployment.md)             | Accepted              | Owner-approved exact GitHub Actions dispatch         |
| [0030](0030-environment-bound-standard-promotion.md)                 | Accepted              | Environment-bound Preview to Production promotion    |
