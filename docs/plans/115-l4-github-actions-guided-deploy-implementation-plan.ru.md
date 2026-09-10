# L4a — план реализации GitHub Actions Guided Deploy

**Дата:** 2026-09-10
**Статус:** Complete on macOS; eligible live dispatch and Windows verification pending
**Спека:** [`114-l4-github-actions-guided-deploy-spec.ru.md`](114-l4-github-actions-guided-deploy-spec.ru.md)

## Последовательность

1. Зафиксировать PD-030, ADR-0029, L-track/master-plan/roadmap и T79–T81 до выдачи deploy authority.
2. Красным domain test зафиксировать HUMAN-only adoption/approval, exact digest, gate/freshness/preview blocks,
   одноразовость и все разрешённые/запрещённые переходы.
3. Добавить bounded runtime contracts без provider payloads и arbitrary argv.
4. Красным adapter test зафиксировать canonical repository, clean exact tree, named published branch, fixed regular
   workflow с явным `workflow_dispatch`, GitHub remote parsing, strict run URL/JSON parsing,
   deadline/cancel/output semantics и redaction.
5. Реализовать один provider-neutral `DeploymentDriver` и production GitHub Actions adapter.
6. Миграцией `0060` добавить immutable Plans/Approvals, versioned Deployments и append-only Events. Проверить
   transaction rollback, idempotency, restart и immutable approval.
7. Добавить authenticated API и простой Launch UI с состояниями blocked/approval/running/failure/unknown.
8. Добавить integration/E2E на macOS и portable Windows fixtures; live dispatch не выполнять без отдельного
   подтверждения exact Release/Environment/commit.
9. Выполнить focused tests, полный `pnpm verify`, browser E2E, release pack/install и зафиксировать sanitized
   dogfood evidence.

## Exit L4a

- [x] exact clean published PREVIEW Release можно dispatch один раз после двух HUMAN confirmations;
- [x] typed observation связывает exact GitHub run с commit и переводит состояние без анализа error strings;
- [x] ambiguous outcome/restart дают `UNKNOWN` без повторного side effect;
- [x] raw CLI/GitHub/provider data и secrets не сохраняются;
- [x] production/hotfix/rollback не притворяются реализованными;
- [x] macOS verification green; Windows остаётся blocking, пока нет live platform evidence.

## Результат

L4a реализован вертикально: closed contracts и deterministic domain, provider-neutral `DeploymentDriver`, один
production adapter для фиксированного GitHub Actions workflow, migration 0060, transactional commands/audit,
restart-safe runner, authenticated API и двухшаговый Launch UI. Provider adapters не получили deploy authority,
GitHub CLI использует только собственную локальную авторизацию, а ambiguous dispatch остаётся `UNKNOWN` без replay.

Release-кандидат прошёл `pnpm verify` (37 Node checks и 1,819 Vitest tests), 65 Playwright E2E и receipt-backed
release pack/clean-install. Production-shaped Recurkit dogfood на согласованной копии durable state подтвердил
migration 59→60 и существующие четыре полных owner-accepted PipelineRuns. Guided Deploy честно остановился на
`0/24` release gates; отдельный adapter preflight вернул `SOURCE_DIRTY`. GitHub Actions run не запускался, потому
что нет eligible Preview Release и отдельного подтверждения его exact target.

Sanitized evidence: [`L4-GUIDED-DEPLOY-RECURKIT.md`](../evidence/phase-8/L4-GUIDED-DEPLOY-RECURKIT.md).
Windows остаётся blocking platform gate; Production, hotfix и rollback по-прежнему недоступны.
