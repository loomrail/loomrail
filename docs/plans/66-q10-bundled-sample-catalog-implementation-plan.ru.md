# Q10 — План реализации bundled sample catalog

**Дата:** 2026-09-02

**Статус:** local implementation and gates complete; macOS/Windows evidence pending

**Спецификация:**
[65-q10-bundled-sample-catalog-spec.ru.md](65-q10-bundled-sample-catalog-spec.ru.md)

## 1. Порядок работы

### Q10.1 — Executable sample repositories

- [x] Заменить placeholder contents `web-app-a` на dependency-free tested web sample.
- [x] Заменить placeholder contents `api-service-b` на dependency-free tested API sample.
- [x] Добавить по два exact Task recipes с brief и acceptance criteria.
- [x] Сохранить fixture identity, isolated materialisation и no-implicit-execution boundary.

### Q10.2 — Public catalog

- [x] Добавить EN/RU guide по sample repositories, canonical workflow revision и built-in role mapping.
- [x] Связать catalog с README, Getting Started, Browser QA guide и D2 full-route example.
- [x] Зафиксировать различие sample recipe, Mock demo и отдельно авторизуемого live-provider dogfood.

### Q10.3 — Verification

- [x] Добавить standard-library source/package verifier с closed catalog и no-dependency/no-link policy.
- [x] Запускать named sample gate на macOS/Windows до repository-wide lint и из clean-install tarball.
- [x] Прогнать focused tests, full build/typecheck, non-landing lint, public tree, audit, fault/browser/release gates.
- [ ] Получить macOS/Windows sample/package evidence; общий Verify может быть blocked только protected landing.

## 2. Module seam

Sample source остаётся data в `fixtures/projects`; daemon materialiser отвечает только за safe copy + Git init.
`scripts/verify-samples.mjs` владеет release-time catalog policy и исполнением baseline tests. Domain roles и workflow
остаются единственным runtime authority; public guide только объясняет их и не создаёт параллельный config format.

## 3. Release boundary

Q10 закрывает Phase 8 deliverable `sample repositories/workflows/roles`, когда source и packaged catalog проходят на
обеих ОС. Это не закрывает live compatibility row, private dogfood, telemetry, public issue/roadmap, security review,
trusted registry provenance или stable publish gate.

Local evidence: [Q10-BUNDLED-SAMPLE-CATALOG-EVIDENCE.md](../evidence/phase-8/Q10-BUNDLED-SAMPLE-CATALOG-EVIDENCE.md).
