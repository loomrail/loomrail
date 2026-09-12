# Q20.2 — Stable gates для local subscription CLI: implementation plan

**Статус:** complete for `MACOS_ARM64` Stable; full compatibility index remains 9/11 by design

1. Зафиксировать schema-v3 seam и retired hard-token meaning в ADR-0016/PD-019/Threat Model. **Done.**
2. Заменить exact gate key/path в глубоком release-gate module без изменения остальных десяти gates. **Done.**
3. Обновить manifest pending reasons и документацию release/supply-chain/Q13/Master Plan/Q18. **Done.**
4. Добавить sanitized Q20 working-tree evidence без raw provider payload, credentials и personal paths. **Done.**
5. Проверить schema-v2/retired-key rejection, исходный exact 8/11 summary, а после accepted private Epic — exact
   9/11 summary; full `pnpm verify`, E2E и release package. **Done.**
6. Продвигать только gates с fixed-commit evidence; private dogfood продвинут после immutable evidence commit, обе
   Windows local-CLI строки оставлены `PENDING`. **Done.**

Разрешение владельца на commit/push и fast-forward в `main` получено 2026-09-08. npm publish не разрешён.
