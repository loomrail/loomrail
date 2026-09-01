# C1 MCP connections — implementation plan

**Дата:** 2026-08-31
**Спецификация:** [`33-c1-mcp-connections-spec.ru.md`](33-c1-mcp-connections-spec.ru.md)

## 1. Contracts и domain

- [x] Добавить закрытые schemas для Proposal candidate/preview, Profile Revision, Consent, Capability Snapshot, Grant,
      Session Snapshot и Tool Call Record.
- [x] Добавить commands/results/events для confirm, grant, revoke и recovery без raw tool payload.
- [x] Реализовать pure decisions: exact digest match, expiry, immutable revision, allowed/forbidden transitions,
      optimistic Project version и idempotency.
- [x] Добавить C1 terms в `docs/domain/CONTEXT.md`, PD-010 и ADR-0005.

Gate: domain tests покрывают every allowed/forbidden transition и не содержат I/O.

## 2. Persistence

- [x] Добавить migration 0018 с immutable profile/consent/snapshot tables, grant projection и tool-call lifecycle.
- [x] Все profile/grant mutations пишут state + Event + receipt одной transaction.
- [x] Session start атомарно сохраняет MCP Session Snapshots.
- [x] Reconciliation переводит unfinished tool calls в `UNKNOWN_OUTCOME` до нового dispatch.
- [x] Restart/replay/idempotency/version-conflict tests используют temp DB и non-ASCII paths.

Gate: SQLite не хранит challenge, raw input/output, env values или credentials.

## 3. Deep gateway module

- [x] Создать `packages/mcp-gateway` с маленьким interface: `probe(revision)`, `open(sessionSnapshot)`,
      `revoke(grantId)`, `close(sessionId)`.
- [x] Спрятать SDK negotiation, stdio process, bounds, proxy tokens, JSON-RPC filtering и cleanup внутри module.
- [x] Production adapter запускает real child; tests используют отдельные fake modern и legacy stdio servers.
- [x] Добавить TERM/grace/KILL process-tree shutdown и parent-death recovery без shell interpolation: POSIX process
      group и Windows `taskkill /T`.
- [x] Добавить durable mode-`0600` process registry и startup reconciliation для случая, когда вместе с daemon умер
      supervisor, а server tree пережил оба процесса; reused pid fail-safe проверяется отдельно.
- [x] Закрепить Windows CI evidence для `taskkill /T`: exact executable/argv и graceful/forced branches покрыты
      platform-adapter unit tests, POSIX process group — real-process tests локально, а workflow содержит отдельный
      Windows MCP process-tree step. Реальный Windows job, полный `verify`, audit, browser smoke и clean install
      прошли в [run 33502010465](https://github.com/loomrail/loomrail/actions/runs/33502010465).

Gate: deletion test возвращает всю MCP complexity в daemon/adapters; gateway interface остаётся provider-neutral.

## 4. Provider adapters

- [x] Расширить `ProviderInvocation` обязательным `mcpConnections` (пустой массив означает none).
- [x] Codex: генерировать только closed `mcp_servers.loomrail_<id>.command|args|enabled_tools` assignments поверх
      `--ignore-user-config`.
- [x] Claude: generated temp JSON только с proxy connections + `--mcp-config` + `--strict-mcp-config`; удалять файл в
      `finally`.
- [x] Оставить permission-bypass/arbitrary config guards закрытыми; разрешить только exact C1 spellings/values.
- [x] Test canaries: ambient config не подключается, real executable/argv не попадает provider, ungranted tools hidden.

Gate: recordings остаются зелёными; adapters не импортируют persistence/daemon.

## 5. Daemon orchestration

- [x] Добавить in-memory expiring ProposalChallengeStore с injected clock/id generator.
- [x] Реализовать protected project routes и typed errors.
- [x] Перед ProviderSession start resolve consented enabled revisions и создать gateway connectors.
- [x] Сохранить session snapshots до запуска provider; на failure закрыть gateway и оставить durable diagnosis.
- [x] Revoke немедленно обновляет gateway policy; worker captures exact session snapshot как provider adapter.
- [x] Логи содержат только ids/digests/counts и redacted typed outcomes.

Gate: browser/API никогда не передаёт spawn payload в probe/session start.

## 6. Settings

- [x] Добавить Project MCP Profiles ниже AI provider, без vanity cards.
- [x] Двухшаговый exact-command flow с явным risk copy и one-time challenge.
- [x] Разнести declared/discovered/granted tools; новые discovered tools не выделять как granted.
- [x] Probe/grant/revoke/loading/error states на RU/EN, keyboard и light/dark.
- [x] Показывать, что change влияет на новые sessions, а revoke блокирует новые calls active gateway.

Gate: UI не имеет поля env/secret/URL/cwd/shell и не может probe без consented revision id.

## 7. Verification

- [x] Contracts/domain/persistence/gateway/provider/daemon/web focused suites.
- [x] Security tests: challenge replay, CSRF/Origin, digest mismatch, `npx`/shell denial, path escape, stdout flood,
      ambient config isolation, grant bypass, revoke race, orphan process, unknown outcome/no retry.
- [x] Browser E2E: propose → exact consent → real probe → grant → restart persistence → revoke; daemon integration
      отдельно проверяет exact ProviderSession snapshot и real proxy call.
- [x] Manual browser QA RU/EN, light/dark, keyboard and narrow viewport.
- [x] `pnpm verify`, 42-test E2E, production audit, clean tarball install и `git diff --check` зелёные; landing source
      не менялся в рамках C1.
- [x] Platform process-tree seam покрыт 5 unit tests; gateway suite — 25/25. Публичный gateway interface не получил
      platform flags или process primitives.
- [x] Release bundle включает gateway runtime dependencies и отдельные `proxy.js`/`supervisor.js`; clean-install
      tarball test запускает оба entrypoint вне monorepo перед проверкой daemon/Workbench.
