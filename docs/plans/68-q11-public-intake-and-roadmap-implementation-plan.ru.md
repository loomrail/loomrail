# Q11 — План реализации public intake and roadmap

**Дата:** 2026-09-03

**Статус:** complete; local, live GitHub UI и macOS/Windows gates recorded

**Спецификация:** [67-q11-public-intake-and-roadmap-spec.ru.md](67-q11-public-intake-and-roadmap-spec.ru.md)

## 1. Порядок работы

### Q11.1 — Structured issue intake

- [x] Добавить bounded bug issue form без automatic repository authority.
- [x] Добавить acceptance-oriented product proposal form.
- [x] Закрыть blank public issue и направить vulnerability reports в private advisory.

### Q11.2 — Honest public roadmap

- [x] Добавить root roadmap с Now/Next/Later и explicit non-promises.
- [x] Связать README, docs index, CONTRIBUTING и SECURITY routes.
- [x] Зафиксировать distinction public summary vs normative product decisions/master plan.

### Q11.3 — Verification

- [x] Добавить closed standard-library verifier и mutation tests.
- [x] Добавить named macOS/Windows CI gate до общего lint.
- [x] Обновить T45 и Phase 8 evidence/status.
- [x] Получить local и cross-platform evidence; общий Verify blocked только protected landing.

## 2. Module seam

Community files остаются repository metadata. `scripts/verify-community-files.mjs` владеет только source-tree
policy; он не является YAML renderer, GitHub client или product runtime module. Prettier проверяет YAML parseability,
а verifier — Loomrail-specific closed contract.

## 3. Release boundary

Q11 закрывает один public-readiness deliverable. Он не разрешает stable claim или npm publish: opt-in telemetry,
security review, exact live row, private dogfood, trusted provenance и полный release gate остаются отдельными.
