# Q8 — План реализации guided local setup

**Дата:** 2026-09-02

**Статус:** local implementation complete; cross-platform clean-install evidence pending

**Спецификация:** [61-q8-guided-local-setup-spec.ru.md](61-q8-guided-local-setup-spec.ru.md)

## 1. Порядок работы

### Q8.1 — Closed setup module

- [x] Добавить `SetupRoute`, closed readiness checks/actions и deterministic human/JSON render.
- [x] Свернуть существующий Doctor Report без повторения runtime/Git/SQLite/provider probes.
- [x] Проверять Chromium stat-only через installed Playwright runtime без launch/download/path output.
- [x] Добавить exact interactive choice с Mock default и non-TTY fail-closed boundary.

### Q8.2 — CLI и owner guidance

- [x] Добавить parser/help для `setup [--mode mock|live] [--json]` без mixed flags/positionals.
- [x] Подключить exit codes, не создавая data/state/log writer/bootstrap token.
- [x] Обновить EN/RU quick start, operations, user guide и domain vocabulary.
- [x] Добавить T42 threat delta, Master Plan/decomposition/release checkpoint и evidence.

### Q8.3 — Clean-machine gate

- [x] Unit: command matrix, choice bounds, all readiness branches, deterministic render и canary non-disclosure.
- [x] Проверить no-create filesystem behavior и отсутствие browser/agent-session/login/package process launch.
- [x] Добавить packaged `setup --mode mock --json` после explicit Chromium installation в release smoke.
- [x] Запустить local format/non-landing lint/typecheck/tests/fault/release/public/audit gates.
- [ ] Получить macOS/Windows CLI setup и clean-install evidence; общий Verify может оставаться blocked только landing.

## 2. Module seam

`apps/cli/src/setup.ts` имеет один внешний seam: собрать Setup Readiness Report из выбранного route и injected
observations, затем отрендерить его. CLI владеет только argv/TTY/stdout/exit-code wiring. Doctor остаётся владельцем
diagnostic probes; Playwright используется только как источник executable location, без BrowserDriver launch.

## 3. Authority boundary

Setup Route живёт только во время одного CLI invocation. Q8 не создаёт domain command, durable preference, consent,
credential, Project, database или migration и не запускает action из `nextActions`. Все изменения машины остаются
явными командами владельца за пределами setup process; Q4 read-only status probes остаются единственным допустимым
child-process observation.

Local evidence: [Q8-GUIDED-SETUP-EVIDENCE.md](../evidence/phase-8/Q8-GUIDED-SETUP-EVIDENCE.md).
