# Q5 — План реализации crash/fault-injection gate

**Дата:** 2026-09-02

**Статус:** complete; named gate verified on macOS and Windows; repository verify blocked only by protected landing lint

**Спецификация:**
[55-q5-crash-and-fault-injection-gate-spec.ru.md](55-q5-crash-and-fault-injection-gate-spec.ru.md)

## 1. Порядок работы

### Q5.1 — Process-boundary drill

- [x] Добавить test-only blocking Mock daemon fixture без production failpoint.
- [x] Пройти real HTTP bootstrap/CSRF/commands до durable ProviderSession start.
- [x] Убить exact child через `SIGKILL`, перезапустить на той же DB и проверить interruption/recovery.
- [x] Повторным restart доказать exactly-once report и отсутствие automatic provider replay.

### Q5.2 — Named matrix

- [x] Добавить cross-platform Node orchestrator без shell strings.
- [x] Включить persistence/provider/MCP/scaffold/Browser QA/daemon suites и black-box drill.
- [x] Добавить root `test:fault-injection` и отдельный CI step до общего verify.

### Q5.3 — Evidence and authority docs

- [x] Записать fault matrix и exact claims в architecture/threat/release docs.
- [x] Обновить Master Plan, decomposition и domain vocabulary без claim об automatic resume.

## 2. Verification gate

- [x] Новый black-box drill зелёный локально и не оставляет child/temp artifacts.
- [x] Named fault gate зелёный последовательно.
- [x] Existing full typecheck/unit, production audit и release tarball остаются зелёными.
- [x] macOS/Windows CI named gate; общий verify blocked только protected landing.

Локальное evidence: [Q5-CRASH-FAULT-INJECTION-EVIDENCE.md](../evidence/phase-8/Q5-CRASH-FAULT-INJECTION-EVIDENCE.md).
Первый Q5 CI run обнаружил missing Chromium prerequisite в новом Verify step; CI теперь устанавливает Chromium перед
матрицей, не ослабляя browser-qa suite и не превращая отсутствие executable в recovery evidence.
Replacement [GitHub Actions run 33658781891](https://github.com/loomrail/loomrail/actions/runs/33658781891)
подтвердил named crash/fault gate, production audit, clean-install tarball и browser smoke на macOS и Windows. Оба
repository-wide Verify дошли до lint и остановились только на защищённых `apps/landing/src/main.ts:630,631,634`.

## 3. Release boundary

Q5 закрывает Phase 8 full crash/fault-injection deliverable и усиливает restart evidence, но не выполняет private
dogfood acceptance contract сам по себе. Telemetry/crash upload, automatic retry и npm publish не добавляются.
