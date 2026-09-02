# Q9 — План реализации provider compatibility matrix

**Дата:** 2026-09-02

**Статус:** local implementation and gates complete; macOS/Windows evidence pending

**Спецификация:**
[63-q9-provider-compatibility-matrix-spec.ru.md](63-q9-provider-compatibility-matrix-spec.ru.md)

## 1. Порядок работы

### Q9.1 — Closed compatibility observation

- [x] Добавить closed compatibility/version fields и wire-schema invariants.
- [x] Реализовать deep bounded `--version` probe с exact provider parsers и no-raw result.
- [x] Зафиксировать empty live verified allowlist и Claude admission floor `2.1.214`.
- [x] Запускать auth probe только для exact `VERIFIED` version.

### Q9.2 — Admission и owner visibility

- [x] Сделать `ready` и adapter `start` зависимыми от compatibility без изменения уже running session.
- [x] Вывести normalized version/status в Doctor и RU/EN Project Settings.
- [x] Сохранить Mock guided setup READY и заблокировать Live при отсутствии verified provider.
- [x] Добавить public EN/RU compatibility matrix и safe promotion/update guidance.

### Q9.3 — Verification

- [x] Unit: parse/status matrix, deadline/output/error canaries, auth-after-version и refresh version change.
- [x] Integration/browser: AUTO/explicit fail-closed, API invariants, RU/EN status и Mock fallback.
- [x] Проверить focused format/lint/typecheck/tests, public tree, audit, fault и release package.
- [ ] Получить macOS/Windows synthetic version-probe и clean-package evidence; общий Verify может быть blocked только
      protected landing.

## 2. Module seam

`apps/daemon/src/provider-compatibility.ts` владеет provider-specific version argv, bounded process observation,
exact parsing и immutable matrix policy. Он возвращает только `{ compatibility, version }`. Provider registry
комбинирует этот результат с installed/auth state; contracts владеют wire invariant; CLI/UI только отображают closed
projection.

## 3. Promotion boundary

Q9 intentionally начинает с пустого live `VERIFIED` allowlist. Добавление строки требует отдельного reviewed evidence
slice по §6 спецификации и не может быть результатом package update, успешного `--version` или provider prose.

Local evidence: [Q9-PROVIDER-COMPATIBILITY-EVIDENCE.md](../evidence/phase-8/Q9-PROVIDER-COMPATIBILITY-EVIDENCE.md).
