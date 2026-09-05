# Q13 — Final security and reliability review implementation plan

**Статус:** implementation и Q13 macOS/Windows gates complete; external stable gates pending

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
- [x] Привязать exact Project Constitution к immutable AgentRun snapshot и доказать неизменность context после
      активации следующей версии.
- [x] Применить immutable model tier через schema-validated provider mapping и явный CLI `--model`.
- [x] Запретить публичному review-diff API расширять intrinsic limits, ограничить recovery scan и проверить полную
      managed Browser QA directory chain.
- [x] Распространить managed-root checks на retention и fail-closed прервать legacy session без AgentRun authority.
- [x] Привязать provider-executed Acceptance Manager к immutable AgentRun, usage/model/budget/capability snapshot и
      оставить `Accept | Return | Reject` отдельным owner-only gate.
- [x] Атомарно перепроверять RUNNING StageAttempt и AgentRun в `START_PROVIDER_SESSION`; stale daemon read не может
      создать nullable session. При owner cancel сначала durable-фиксировать validated cancellation без release live
      authority, затем отзывать pre-spawn signal, ждать остановки process и через `END_PROVIDER_SESSION` transaction
      закрывать session/run/lease; Soft Pause сохраняет текущий turn. Legacy squad upgrade допускает только exact
      revision 1.
- [x] Выполнить финальный Standards/Spec review и закрыть все P0/P1.
- [x] Прогнать full non-landing source gates, fault injection, audit, clean package и browser matrix.
- [x] Запушить Q13, дождаться macOS/Windows CI и записать evidence.
- [ ] Провести private dogfood на явно выбранном владельцем private full-stack repository и сохранить evidence.
- [ ] После отдельного разрешения на quota-bearing runs добавить exact live-provider row с macOS/Windows evidence.
- [ ] Дождаться зелёного protected landing gate от отдельной landing-сессии, не меняя и не исключая её source.
- [ ] Настроить owner-authorized trusted publisher и доказать registry provenance в самом publish workflow.
      Repository-side manual stage-only workflow и fail-closed intent/CI/version gate подготовлены; protected
      `npm-release` environment, npm stage-only trust, фактический staging, отдельный 2FA approval и post-publish
      provenance evidence остаются owner-authorized внешними действиями.
- [ ] Только после всех gates подготовить отдельное решение о stable tag/publish.

## Ограничения

- не менять и не форматировать `apps/landing/**`;
- не добавлять remote/cloud/desktop capabilities;
- не сохранять raw provider output или credentials;
- не публиковать npm package, tag или dist-tag до завершения всего stable exit contract.
