# Q20.6 — Bounded exact-fragment edit: dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Архитектурная граница:** совместимое расширение ADR-0014 и PD-018; provider adapters по-прежнему владеют native
tool-call payload, а daemon-owned executor — единственная filesystem authority.

## Причина

Private Recurkit Epic дошёл до реального correction loop: Claude Code нашёл drift между новой миграцией и большим
`schema.prisma`, а Codex не смог безопасно отправить весь файл через whole-file `WRITE_FILE`. Риск не принимается и
review не обходится.

## Контракт

`EDIT_FILE(path, expectedSha256, oldText, newText)` разрешён только IMPLEMENT/READ_WRITE. Executor сам читает один
existing regular UTF-8 file, проверяет whole-file CAS digest, требует ровно одно вхождение непустого `oldText`,
ограничивает fragments и итоговый размер, затем делает тот же atomic same-directory replace, что `WRITE_FILE`.
Provider не передаёт offset, patch path, shell, command или произвольную программу. Audit хранит operation/path,
policy/input/output digests и размер, но не fragments.

## План и gates

1. RED: large Unicode/space path success; ambiguous, stale, secret, symlink, traversal and READ_ONLY refusal. **Done.**
2. Contracts/executor/MCP/adapters/domain completion proof and SQLite migration. **Done.**
3. Restart/replay, malformed/oversized payload and simulated Windows-policy verification. **Done.**
4. Rebuild daemon, recover the interrupted Recurkit pipeline and require independent review to close the original
   HIGH finding. **Done; downstream owner-gate routing defect is tracked in plan 102.**
5. Full `pnpm verify`, E2E, release package and sanitized private-dogfood evidence. **Pending.**

## Non-goals

Unified diff parsing, regex replacement, arbitrary offsets, recursive edits, shell/Git/deploy authority, QA writes,
provider-owned approval or automatic replay after an uncertain outcome.
