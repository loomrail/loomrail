# L4b1 — environment-bound STANDARD promotion

**Дата:** 2026-09-11
**Статус:** утверждено к реализации
**Основание:** PD-031, ADR-0030, L-track D4/D5/D7/D9, T82–T83

## 1. Outcome

Authenticated owner может подготовить и дважды подтвердить одну Preview либо Production STANDARD попытку через
existing GitHub Actions workflow. Loomrail однозначно связывает Environment kind с фиксированным workflow, а
Production разрешает только после успешного Preview того же evidence-снимка. Provider не получает deploy tool;
секреты и операционные команды остаются в repository-owned workflow.

## 2. Deep interface

Внешний seam остаётся одним `DeploymentDriver`:

```ts
preflight({ repositoryPath, releaseTree, environmentKind, signal });
dispatch({ repositoryPath, releaseTree, target, signal });
observe({ target, runId, signal });
```

`preflight` возвращает только закрытый v2 target. Adapter сам выбирает workflow path по `environmentKind`, строит
exact argv и повторно проверяет repository/branch/commit/workflow непосредственно перед dispatch. Ни HTTP, ни domain,
ни provider-specific adapter не знают GitHub argv.

## 3. Release Evidence Digest

Digest вычисляется над canonical JSON с полями `schemaVersion`, `projectId`, `sourceTree`, `source`,
`selectedWorkItems`, `gates`, `requiredGateCount`, `passedRequiredGateCount`. Environment, Release id/content hash,
createdAt и UI labels исключены. Две Release с разными окружениями эквивалентны для promotion только при одинаковом
digest; каждая отдельно обязана быть current и полностью passed в момент adoption.

## 4. Eligibility

- PREVIEW/STANDARD: current Release, все required gates `PASSED`, v2 Preview workflow preflight `READY`.
- PRODUCTION/STANDARD: те же условия плюс один ранее `SUCCEEDED` v2 Preview Deployment того же Project и digest.
- failed, unknown, running, foreign, legacy v1 или другой digest не удовлетворяет promotion.
- изменение Environment/Release/Plan/target после preview/approval даёт typed conflict/stale refusal.
- один Approval разрешает одну попытку; неоднозначный dispatch остаётся `UNKNOWN`, retry отсутствует.

## 5. Compatibility и persistence

Migration 0061 расширяет immutable Deployment Plan revision до `1 | 2` и добавляет nullable indexed promotion
identity к Deployment rows. Existing v1 JSON/Events/Approvals не переписываются. New plans/deployments всегда v2;
v1 можно читать и наблюдать по сохранённому run id, но нельзя использовать для production eligibility.

## 6. HTTP и UI

Preview response показывает Environment kind и exact workflow. Для Production без подходящего Preview возвращается
`PREVIEW_PROMOTION_REQUIRED` с обычным объяснением и следующим безопасным действием. Два подтверждения явно называют
Preview либо Production и короткую SHA. `UNKNOWN` запрещает повтор. HOTFIX/waiver/rollback/probe остаются видимыми
как недоступные. Keyboard focus, RU/EN, light/dark и narrow viewport входят в acceptance.

## 7. Security и verification

- contract/domain: v1 read compatibility; v2 mapping; every allowed/forbidden promotion; actor/version/digest checks;
- persistence: migration from v60, indexed exact qualifier, transaction rollback, idempotency, restart;
- adapter: exact Preview/Production path, top-level trigger, traversal/symlink, dirty/unpublished source, output bounds;
- HTTP: session/Origin/CSRF, stale/cross-project input, no path/input/secret fields;
- UI/E2E: blocked → two confirmations → running/success/failure/unknown for both kinds;
- canaries: `.env`, tokens, raw GitHub/provider payloads and absolute macOS/Windows paths never persist or render;
- portable paths with spaces and Unicode plus macOS/Windows CI.

## 8. Non-goals

HOTFIX, Gate Waiver, rollback execution, Post-Deploy Probe, automatic polling/retry, arbitrary workflow/input, SSH/VPS,
provider deployment tools, commit/push/tag/merge and live dispatch without a separate exact owner confirmation.
