# Q20.1 — Локальные Codex/Claude runtime: implementation plan

**Статус:** implementation and automated verification complete; private workflow and Windows live evidence pending

1. Зафиксировать local-subscription-only boundary в Product Decisions, ADR, Master Plan и Threat Model. **Done.**
2. Расширить daemon-owned MCP gateway прямым session binding к provider-neutral workspace executor без нового
   provider-visible authority. **Done.**
3. Вернуть Codex/Claude process adapters, убрать API credentials/HTTPS transport и добавить fail-closed runtime
   compatibility admission. **Done.**
4. Запускать provider в scratch-only режиме с отключёнными ambient settings и built-in tools; передавать только
   session-scoped Loomrail MCP connector и stage result schema. **Done.**
5. Честно разрешить `POST_SESSION` local runtimes в scheduler/domain и обновить budget/blocked UI copy. **Done.**
6. Добавить unit/integration/E2E для argv, auth/version states, real proxy-to-executor tools, prohibited operations,
   cancellation/recovery и absence-of-secrets. **Done.**
7. Требовать в domain successful same-session audited write/delete перед live IMPLEMENT completion. **Done.**
8. Выполнить полный `pnpm verify`, release build/package checks и owner-approved local dogfood только на совместимых
   установленных runtimes. **Done for automated gates and focused macOS Codex/Claude IMPLEMENT+QA; full private
   workflow and Windows live evidence remain pending.**
