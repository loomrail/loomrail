# Q20.2 — Stable gates для local subscription CLI: implementation plan

**Статус:** in progress

1. Зафиксировать schema-v3 seam и retired hard-token meaning в ADR-0016/PD-019/Threat Model. **Done.**
2. Заменить один exact gate key/path в глубоком release-gate module без изменения остальных десяти gates.
   **In progress.**
3. Обновить manifest pending reasons и документацию release/supply-chain/Q13/Master Plan/Q18. **Pending.**
4. Добавить sanitized Q20 working-tree evidence без raw provider payload, credentials и personal paths. **Pending.**
5. Проверить schema-v2/retired-key rejection, exact current summary, full `pnpm verify`, E2E и release package.
   **Pending.**
6. Не повышать ни один gate до `PASSED`, не commit/push/stage/publish без отдельного решения владельца. **Pending.**
