# C3 Context7 preset — implementation plan

**Дата:** 2026-08-31
**Спецификация:** [`35-c3-context7-preset-spec.ru.md`](35-c3-context7-preset-spec.ru.md)

## 1. Distribution

- [x] Добавить exact `@upstash/context7-mcp` production dependency.
- [x] Включить transitive dependency в generated release manifest через daemon workspace package.
- [x] Проверить Context7 package в clean-install release test.

## 2. Server-owned preset

- [x] Реализовать internal resolver bundled entrypoint без PATH/npx/download.
- [x] Добавить closed Context7 proposal request schema и authenticated endpoint без spawn fields.
- [x] Переиспользовать C1 canonical digest, one-shot Consent и immutable revision.
- [x] Добавить unit/integration и real capability probe tests.

## 3. Settings

- [x] Добавить Context7 preset выше manual MCP form.
- [x] RU/EN copy: no install, external egress, no secrets/proprietary code, affects new sessions.
- [x] Keyboard/light/dark/browser coverage без изменений landing.

## 4. Security и release gate

- [x] Обновить threat model для bundled supply chain и outbound query disclosure.
- [x] Прогнать focused suites, non-landing lint/typecheck, 40-test E2E, production audit и clean tarball install.
- [ ] Закрыть C3 только после реального Windows CI вместе с оставшимся C1 gate.

Локальный итог: contracts 109/109, gateway 24/24, daemon 166/166, web 63/63, Playwright 40/40;
`pnpm audit --prod --audit-level high` не нашёл известных уязвимостей. Landing source не изменялся.
