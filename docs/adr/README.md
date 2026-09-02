# Architecture decision records

ADR фиксирует одно архитектурное решение, контекст, последствия и условия пересмотра. Accepted ADR не редактируется
так, будто прежнего решения не существовало: существенное изменение оформляется новым ADR со ссылкой на superseded
record.

## Index

| ADR                                              | Status                | Decision                                            |
| ------------------------------------------------ | --------------------- | --------------------------------------------------- |
| [0001](0001-typescript-monorepo-baseline.md)     | Accepted              | TypeScript monorepo and runtime baseline            |
| [0002](0002-sqlite-state-and-audit.md)           | Accepted with CI gate | Relational SQLite state plus append-only audit      |
| [0003](0003-loopback-session-security.md)        | Accepted              | Loopback-only daemon and one-time browser bootstrap |
| [0004](0004-one-owner-gate-per-stage-attempt.md) | Accepted              | One provider owner gate until explicit retry        |
| [0005](0005-daemon-owned-mcp-gateway.md)         | Accepted with CI gate | Daemon-owned MCP process, policy and audit seam     |
| [0006](0006-read-only-tool-plugin-sdk.md)        | Accepted with CI gate | Read-only MCP tool Plugin SDK v1                    |
| [0007](0007-marker-bound-project-scaffolding.md) | Accepted              | Marker-bound durable Project scaffolding            |
| [0008](0008-separate-qa-correction-runs.md)      | Accepted              | QA correction identity separate from review rounds  |
