# Architecture decision records

ADR фиксирует одно архитектурное решение, контекст, последствия и условия пересмотра. Accepted ADR не редактируется
так, будто прежнего решения не существовало: существенное изменение оформляется новым ADR со ссылкой на superseded
record.

## Index

| ADR                                          | Status                | Decision                                            |
| -------------------------------------------- | --------------------- | --------------------------------------------------- |
| [0001](0001-typescript-monorepo-baseline.md) | Accepted              | TypeScript monorepo and runtime baseline            |
| [0002](0002-sqlite-state-and-audit.md)       | Accepted with CI gate | Relational SQLite state plus append-only audit      |
| [0003](0003-loopback-session-security.md)    | Accepted              | Loopback-only daemon and one-time browser bootstrap |
