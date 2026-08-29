# D2 — Воспроизводимый live-маршрут: план реализации

**Спецификация:** [`19-d2-full-route-example-spec.ru.md`](19-d2-full-route-example-spec.ru.md)

**Статус:** завершено; настоящий Codex route достиг pending owner Acceptance; изменения не закоммичены

## Ограничения

- Не запускать настоящий Codex/Claude без явного разрешения владельца: это расход внешней квоты.
- Не ослаблять human-only acceptance и typed Review/QA evidence ради зелёного demo.
- Не редактировать старые migrations; provider CHECK расширяется новой migration.
- Не сохранять raw provider stream, credentials, bootstrap values или абсолютные персональные пути.
- Не добавлять shell runner, BrowserDriver, Git commit/push/merge или Claude write access.
- Не коммитить и не push-ить без прямого запроса владельца.

## Задача 1: закрытый provider id и stage-result contract

**Изменить:** `packages/contracts/src/workflow.ts`, `packages/provider-core/src/index.ts`

**Создать:** `packages/provider-core/src/stage-result.ts`, unit tests

- [x] Перенести единый `ProviderId` enum в contracts и переэкспортировать из provider-core.
- [x] Определить строгие stage-specific output schemas и общий decoder.
- [x] Разрешить `NEEDS_HUMAN` на agent stages, typed evidence на Review/QA и только
      `READY_FOR_ACCEPTANCE` на Acceptance.
- [x] Проверить неверный kind, неизвестные поля и свободный prose мутациями/negative tests.
- [x] Проверить совместимость всех шести generated schemas с ограничениями Structured Outputs: object root,
      required fields, nested `anyOf`, `additionalProperties: false`, без `oneOf`.

## Задача 2: live adapters

**Изменить:** `packages/provider-codex/src/index.ts`, `packages/provider-claude-code/src/index.ts` и их тесты.

- [x] Передавать в CLI JSON Schema текущей стадии.
- [x] Декодировать final envelope через общий contract и публиковать checkpoint только когда он есть.
- [x] Сохранить Codex last-wins + terminal-turn + clean-exit gate.
- [x] Убрать Claude prose fallback: invalid terminal structured result fail-closed.
- [x] Не менять capability claims и permission flags.

## Задача 3: атрибуция evidence и acceptance invariant

**Изменить:** contracts command, daemon session loop, domain decision/tests.

- [x] Передавать daemon-owned `capabilities().provider` в каждую новую `APPLY_PROVIDER_OUTCOME` command.
- [x] Записывать provider id на EvidenceArtifact; историческое отсутствие command field читать как MOCK.
- [x] Запретить `COMPLETED` на Acceptance отдельным domain guard.
- [x] Убрать mock-only prose из AcceptancePackage/HumanRequest.

## Задача 4: migration

**Создать:** `packages/persistence-sqlite/migrations/0014_live_evidence_provider.sql`

**Изменить:** migration registry и persistence integration tests.

- [x] Сохранить существующие evidence rows и append-only triggers/index.
- [x] Разрешить ровно `MOCK | CODEX | CLAUDE_CODE`.
- [x] Проверить upgrade с v13, reopen и отказ неизвестному provider.

## Задача 5: воспроизводимый fixture и integration route

**Создать:** `docs/examples/full-route/**`; дополнить daemon integration tests.

- [x] Добавить маленький synthetic repository без вложенного `.git` и без dependencies/network.
- [x] Описать копирование во временный путь, `git init`, регистрацию, brief и acceptance criteria.
- [x] Live-shaped adapter проходит все стадии, оставляет изменение, оба evidence и pending owner request.
- [x] Зафиксировать ожидаемые Decisions/Changes/evidence без raw transcript.

## Задача 6: верификация и настоящий запуск

- [x] Узкие tests contracts/provider-core/adapters/domain/persistence/daemon.
- [x] `pnpm verify` и `git diff --check`.
- [x] Browser-regression затронутого task route: 36 Playwright tests с одним worker.
- [x] Проверить локальные Markdown-ссылки и public-tree safety.
- [x] Попросить явное разрешение на один настоящий Codex route.
- [x] После разрешения выполнить маршрут, санитизировать отчёт и сверить durable workflow state.

## Задача 7: детерминированная граница повторного HumanRequest

**Решение:** [`ADR-0004`](../adr/0004-one-owner-gate-per-stage-attempt.md)

- [x] Воспроизвести второй `NEEDS_HUMAN` красным provider-core test.
- [x] Выводить policy из durable HumanRequests StageAttempt, а не из `RESUME` или текста context pack.
- [x] Передавать `humanRequests: ALLOWED | DISALLOWED` в ProviderInvocation.
- [x] Убирать ветку из Codex/Claude schemas и повторно применять policy в decoder.
- [x] После реального PLAN process-confirmation перенести использованный gate через автоматически следующие
      first-attempt стадии; явный retry получает один новый gate.
- [x] Проверить live-shaped route: первая Discovery session получает `ALLOWED`, все следующие first-attempt sessions
      после Decision — `DISALLOWED`.
- [x] Повторить один свежий настоящий Codex route до pending owner acceptance.

Коммит возможен только после прямого запроса владельца. Предлагаемая граница одного коммита:

```text
feat(d2): prove the live route through owner acceptance
```
