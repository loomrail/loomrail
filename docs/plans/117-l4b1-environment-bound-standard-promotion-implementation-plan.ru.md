# L4b1 — план реализации environment-bound STANDARD promotion

**Дата:** 2026-09-11
**Статус:** complete; local and macOS/Windows verification green; live dispatch not performed
**Спека:** [`116-l4b1-environment-bound-standard-promotion-spec.ru.md`](116-l4b1-environment-bound-standard-promotion-spec.ru.md)

1. Зафиксировать PD-031, ADR-0030, ubiquitous language, L-track/master-plan/roadmap и T82–T83 до расширения deploy
   authority.
2. Red: contracts/domain tests для v2 target, Release Evidence Digest identity и Preview-before-Production matrix.
3. Green: closed v1/v2 contracts и deterministic domain decisions без infrastructure imports.
4. Red/green: migration 0061, legacy reads, indexed qualifying Preview lookup, atomic command/Event/receipt writes.
5. Red/green: сохранить глубокий `DeploymentDriver`, вывести environment-specific workflow только внутри GitHub
   adapter и повторно валидировать exact target перед dispatch.
6. Red/green: authenticated HTTP preview/adopt и UI states для Preview/Production без executable inputs.
7. Добавить integration/E2E, restart/idempotency/conflict, Unicode/space/macOS/Windows и secret-leak coverage.
8. Выполнить focused tests, `pnpm verify`, E2E, release pack/install и macOS/Windows CI.
9. Live dispatch не выполнять без eligible Release и отдельного подтверждения exact target.

## Exit L4b1

- [x] v2 Preview и Production используют разные фиксированные workflows;
- [x] Production требует exact successful v2 Preview evidence digest;
- [x] legacy v1 history читается, но не повышает authority;
- [x] два owner confirmations, one-shot/idempotency/restart/UNKNOWN сохранены;
- [x] providers, HTTP и repository text не выбирают executable/path/input;
- [x] macOS/Windows automation green; live dispatch либо exact approved, либо честно blocked;
- [x] HOTFIX/waiver/rollback/probe остаются unavailable.

Локальные `pnpm verify`, 65 E2E, fault-injection и release pack/install завершены успешно. Exact commits `ef0a13a`
и `82e5743` прошли все шесть jobs в
[CI run 34601586505](https://github.com/loomrail/loomrail/actions/runs/34601586505). Live GitHub Actions dispatch в
этом срезе не выполнялся: Recurkit остаётся неeligible, а другой exact target владелец отдельно не подтверждал.
