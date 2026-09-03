# Q13 — Final security and reliability review implementation plan

**Статус:** active

**Спецификация:** [71-q13-final-security-reliability-review-spec.ru.md](71-q13-final-security-reliability-review-spec.ru.md)

## Срезы

- [x] Закрыть context delimiter collision и доказать untrusted-source тестом.
- [x] Вывести CLI Doctor runtime floor из package manifest.
- [x] Перенести provider diagnostics в adapters.
- [x] Применить built-in role playbooks к ContextPackRecipe с exact provenance.
- [x] Сохранить immutable AgentRun effective policy и применить capability/workspace/network/MCP/session gates.
- [x] Довести durable live-provider usage: atomic ledger/hard pause, Claude cache normalization, owner-visible
      attribution, restart/idempotency/append-only и abort tests.
- [x] Добавить bounded actual-diff summary в REVIEW context и проверить отсутствие path/content overflow.
- [ ] Закрыть BrowserDriver async errors typed result/error contract.
- [ ] Проверить SquadAssignment revision claim и устранить реализацию либо документационный overclaim.
- [ ] Выполнить финальный Standards/Spec review и закрыть все P0/P1.
- [ ] Прогнать full non-landing source gates, fault injection, audit, clean package и browser matrix.
- [ ] Запушить Q13, дождаться macOS/Windows CI и записать evidence.
- [ ] Провести оставшиеся owner-authorized private dogfood/live-provider/landing/provenance gates.
- [ ] Только после всех gates подготовить отдельное решение о stable tag/publish.

## Ограничения

- не менять и не форматировать `apps/landing/**`;
- не добавлять remote/cloud/desktop capabilities;
- не сохранять raw provider output или credentials;
- не публиковать npm package, tag или dist-tag до завершения всего stable exit contract.
