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
- [x] Закрыть BrowserDriver async errors exported error type и closed code contract.
- [x] Проверить SquadAssignment revision claim и явно оставить post-start composition editing вне stable scope.
- [x] Устранить review-round authority gaps: read-only/offline Browser QA, capability-filtered MCP revisions,
      untrusted evidence framing и fixed code→message BrowserDriver normalization.
- [x] Ограничить patch stdout до накопления в памяти и закрыть public async review/recovery error contracts.
- [x] Уточнить stable role-playbook scope: built-in profile refinement реализован, project-authored editor/import — нет.
- [x] Включить exact active Project Constitution в REVIEW context с versioned provenance и owner-policy framing.
- [x] Ограничить status/numstat до накопления и парсинга и свести review diff contract/limits к одному public type.
- [x] Запретить recovery проходить через symlinked `qa`/run roots и повторно проверить identity перед mutation.
- [x] Закрыть runtime BrowserDriver code allowlist и typed CLI setup question failures.
- [x] Синхронизировать architecture/threat claims с фактическими QA permissions и live runtime.
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
