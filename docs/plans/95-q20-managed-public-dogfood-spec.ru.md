# Q20.3 — Managed public dogfood через local subscription CLI: спецификация

**Статус:** approved

**Основание:** PD-019, ADR-0014–0016, Q17, Threat Model T35

## Outcome

Один полный публичный fixture workflow доказывает production-маршрут Loomrail через локально установленные и
авторизованные Codex CLI и Claude Code CLI. Rehearsal не использует provider API keys, direct HTTP API, test doubles,
synthetic success или скрытый fallback и не читает private repository.

## Фиксированный scope

- source — встроенный `fixtures/projects/web-app-a`;
- Task — Recipe 1 `Add explicit task-status filters` без изменения title, brief и acceptance criteria;
- workspace — materialized Loomrail demo repository в отдельном `LOOMRAIL_DATA_DIR` с пробелом и Unicode в пути;
- provider selection — production `AUTO`: Codex выполняет authoring stages, независимый Review маршрутизируется в
  Claude Code через domain-owned `avoidProvider`;
- verification recipe — только owner-approved `npm test`, предложенный Q17 scanner из `package.json`;
- Browser QA — production Playwright runner против явно одобренного loopback target; QA provider получает только
  read-only workspace tools;
- recovery — один контролируемый restart daemon после durable provider result и до следующей разрешённой стадии;
- завершение — provider-built Acceptance Package остаётся `PENDING`, пока владелец отдельно не выберет disposition.

Public fixture и временный data directory не должны содержать repository Loomrail, его незакоммиченные изменения,
личные пути или private data. Sample server и Loomrail bind только к loopback. Никакие install, update, login, remote,
push или account mutation не входят в rehearsal.

## Доказательства

Sanitized evidence фиксирует:

- exact platform/architecture и версии обоих CLI;
- provider/stage assignment и факт cross-provider Review;
- Git before/after identity и ограниченный diff публичного fixture;
- workspace-tool audit: фактическая IMPLEMENT mutation и отсутствие mutation в QA;
- результат approved `npm test` и measured Browser QA;
- restart/recovery, итоговое workflow state и token accounting mode `POST_SESSION`;
- отсутствие `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, raw provider payloads, bootstrap/session/CSRF values, `.env`
  содержимого и абсолютных personal paths.

Evidence не объявляет Windows compatibility, private 2–3 Task DAG или stable release.

## Acceptance

- Task проходит DISCOVERY → PLAN → IMPLEMENT → independent REVIEW → measured QA → Acceptance Package на production
  local CLI adapters;
- IMPLEMENT содержит минимум один успешный `WRITE_FILE` или `DELETE_FILE` audit event в том же domain-owned
  Project/WorkItem/StageAttempt; continuation session не обязана повторять mutation, но другой attempt не считается;
- QA не содержит разрешённой или выполненной mutation;
- approved recipe и Browser QA проходят на одном current implementation tree;
- контролируемый restart не дублирует provider/tool execution и workflow продолжает работу;
- provider failure, approval/blocked/failure states остаются typed и видимыми, если rehearsal их встретит;
- provider видит точные ID разрешённых verification recipes в bounded tool schema, но execution authority по-прежнему
  выдаётся только executor после повторной проверки активного Plan;
- budget/restart после уже успешного Browser QA не запускает браузер повторно: используется только exact durable
  evidence того же tree и correction lineage;
- полный `pnpm verify`, product E2E, landing E2E и release-package verification проходят после evidence/doc updates;
- gate остаётся `PENDING`, пока evidence bytes не commit/digest/ancestry-bound; 2026-09-08 владелец отдельно разрешил
  commit, push и интеграцию в `main`, но это разрешение не заменяет проверку exact evidence commit.
