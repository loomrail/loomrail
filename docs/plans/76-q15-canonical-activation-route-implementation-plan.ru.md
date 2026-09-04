# Q15 — План реализации canonical activation route

**Дата:** 2026-09-04

**Статус:** non-landing implementation и macOS/Windows CI complete; protected landing pending

**Спецификация:**
[75-q15-canonical-activation-route-spec.ru.md](75-q15-canonical-activation-route-spec.ru.md)

## 1. Порядок работы

### Q15.1 — Deep contract и drift gate

- [x] Добавить strict `GuidedActivationContract` и один JSON source для install, Q10 Task и Mock run policy.
- [x] Добавить standard-library verifier exact marked docs/Q10 recipe и malicious contract mutations.
- [x] Подключить named Q15 gate к macOS/Windows CI до repository-wide lint.

### Q15.2 — CLI entry

- [x] Добавить `loomrail try [--no-open] [--port N]` поверх Q8 Mock preflight и обычного launcher lifecycle.
- [x] Сформировать `/try#bootstrap=...` без утечки token и без изменения `setup` semantics.
- [x] Проверить parser/help, blocked/ready paths и packaged clean-install invocation.

### Q15.3 — Durable guided mission

- [x] Добавить `/try` route и компактную progress surface без второй state machine.
- [x] Переиспользовать fixture registration, Project preference, WorkItem, workflow, Attention и Task Cockpit.
- [x] Создавать exact demo Task одним stable idempotent command id и восстанавливать её после reload/restart.
- [x] Добавить EN/RU, keyboard, light/dark, narrow viewport и zero-quota Browser QA.

### Q15.4 — Protected consumer и exit

- [ ] В отдельной authorized landing-сессии подключить `apps/landing/**` к canonical install/version contract и закрыть
      три существующих lint finding; текущий срез эти файлы не меняет.
- [x] Получить clean macOS/Windows source/browser/package evidence; Windows live-provider capture не относится к Q15.
- [x] Обновить release/evidence/master plan локальными результатами.
- [x] Пройти independent Standards/Spec review.
- [x] Зафиксировать cross-platform CI evidence.

## 2. Module seam

`@loomrail/contracts` экспортирует один validated contract. CLI отвечает только за preflight/start wiring, web — за
проекцию и owner actions, daemon/domain/persistence продолжают владеть состоянием и transitions. Repository verifier
сравнивает human-readable static consumers с тем же JSON, не создавая второй список команд.

## 3. Authority boundary

`try` — явный daemon/browser launch, но не install/login/workflow command. Каждый последующий mutation остаётся
отдельным owner action через существующий authenticated local interface. Protected landing, npm registry и Windows
live providers находятся за отдельными gates.
