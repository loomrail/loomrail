# Q20.2 — Stable gates для local subscription CLI: спецификация

**Статус:** approved

**Основание:** PD-019, ADR-0015, ADR-0016, Threat Model T35

## Outcome

Машинный stable-release index не содержит требований отменённого API-only направления и не может выдать
`POST_SESSION` runtime за exact hard token cap. При этом staging остаётся fail closed и требует тот же закрытый набор
из одиннадцати независимо проверяемых gates.

## Контракт

- manifest schema — exact version 3;
- `liveProviderHardTokenBudgetEnforcement` заменён на `q20LocalSubscriptionWorkspaceExecution`;
- новый gate указывает только на `Q20-LOCAL-SUBSCRIPTION-WORKSPACE-EXECUTION-EVIDENCE.md`;
- Codex/Claude macOS rows используют тот же exact Q20 evidence source только после commit/digest/ancestry proof;
- managed public rehearsal получает новый evidence file после полного workflow через bounded executor;
- Windows reasons требуют local CLI evidence, не API credentials/capture;
- старый schema v2, retired key, unknown/missing fields, unsafe paths, digest drift и non-ancestor evidence запрещены;
- незакоммиченный результат не может получить `PASSED`.

## Acceptance

- parser и tests требуют exact schema v3/11-key set;
- текущий manifest честно сообщает `2/11`, `releaseVersion = null` и только актуальные pending reasons;
- RELEASE, supply-chain, Q13, Master Plan, threat model и Q18 history согласованы;
- `pnpm release:status`, focused tests и полный `pnpm verify` проходят;
- staging/publish не выполняются.
