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
- [x] Закрыть C3 после реального Windows CI вместе с C1 gate: Windows `verify`, browser smoke и clean tarball install
      прошли в [run 33502010465](https://github.com/loomrail/loomrail/actions/runs/33502010465).

Итоговый release gate: локальные focused/full suites, Playwright 42/42 и
`pnpm audit --prod --audit-level high` зелёные; macOS и Windows CI прошли. Landing source не изменялся в рамках C3.
