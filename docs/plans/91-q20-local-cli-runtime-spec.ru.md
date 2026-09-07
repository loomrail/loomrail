# Q20.1 — Локальные Codex/Claude runtime через подписочную авторизацию: спецификация

**Статус:** implemented; full private workflow and Windows live evidence pending

## Цель

Заменить прямые OpenAI/Anthropic API adapters на официальные локальные Codex CLI и Claude Code CLI, сохранив реальный
IMPLEMENT/QA через bounded workspace executor. Пользователь не передаёт Loomrail API key: CLI сам использует свою
существующую авторизацию.

Архитектурное решение: [ADR-0015](../adr/0015-local-subscription-cli-runtimes.md). Workspace authority:
[ADR-0014](../adr/0014-provider-neutral-workspace-executor.md).

## Пользовательский контракт

1. Установить официальный `codex` и/или `claude`.
2. Один раз выполнить `codex login` или `claude auth login` в официальном CLI.
3. Открыть Loomrail: Setup автоматически показывает `Готов`, `Нужно войти`, `Нужно обновить` или `Не установлен`.
4. При старте workflow Loomrail запускает выбранный CLI. Отдельные `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` и API billing
   не используются.

Loomrail не выполняет login/update за пользователя и не читает токен. AUTO выбирает только установленный,
авторизованный и совместимый runtime; иначе workflow остаётся blocked с точной следующей командой.

## Runtime boundary

- child process: argv array, `shell: false`, минимальный environment, deadline, cancellation и process-tree recovery;
- cwd: новый пустой temporary directory, удаляемый после session;
- repository path не передаётся в `cwd`, `--add-dir`, prompt, MCP config или provider payload;
- user/project settings, rules, hooks, plugins, skills, Chrome/browser и built-in shell/file tools отключены;
- MCP config содержит только session-scoped Loomrail proxy; proxy token одноразовый, не логируется и не сохраняется;
- proxy экспортирует только `loomrail_list_directory`, `loomrail_read_file`, `loomrail_write_file`,
  `loomrail_delete_file`, `loomrail_run_recipe`;
- daemon повторно валидирует operation и вызывает `WorkspaceToolExecutor`; результат bounded/redacted и считается
  недоверенными данными следующего provider turn;
- IMPLEMENT получает READ_WRITE, QA и читающие стадии — READ_ONLY; recipe остаётся owner-approved exact ID.

## Provider-specific requirements

### Codex

- `codex exec --json --ephemeral --ignore-user-config --ignore-rules`;
- scratch `-C`, read-only sandbox, no web search;
- built-in shell/general code-host capability disabled; code mode exposes only explicit `mcp__<session>` namespaces
  as direct tools, and non-interactive approval applies only to their closed enabled-tool lists;
- final response constrained stage-specific JSON Schema; success requires both validated result and terminal
  `turn.completed` with zero exit status.

### Claude Code

- `claude -p --output-format stream-json --verbose`;
- empty setting sources, `--restricted`, strict explicit MCP config, empty built-in tool set plus exact Loomrail MCP
  allowlist, no Chrome/slash commands/session persistence;
- `--safe-mode` is excluded because the compatible CLI disables explicitly supplied custom MCP in that mode;
- final response constrained stage-specific JSON Schema; success requires validated terminal `result` and zero exit.

## Budgets and recovery

- adapters declare `POST_SESSION`, never `HARD`;
- immutable token ledger is checked before session and updated exactly once from terminal actual usage;
- 10-minute deadline, bounded JSONL lines, finite tool-call count and provider turn count are preventive;
- abort kills the process tree and revokes the proxy before workflow recovery;
- provider PID and every workspace tool call remain durable; restart never replays uncertain effects;
- raw stdout/stderr, provider transcript, MCP capability, account identifier, auth output, source/file content and
  command output are not persisted.

## Acceptance

- both production adapters use local CLI only and expose all six stages;
- API keys and direct provider HTTP transports are absent from production provider paths;
- missing login/version/executable produces typed blocked setup state with an actionable message;
- real MCP proxy reaches allowed executor operations; traversal, symlink, secret, write-authority, recipe and network
  refusals remain typed;
- adapter argv proves scratch-only runtime and disables ambient/built-in authority;
- cancellation, deadline, output limits, POST_SESSION budget stop and restart recovery are tested;
- spaces/Unicode and modeled Windows paths remain covered;
- integration/E2E use only test-code CLI doubles; no billable live call is required for `pnpm verify`;
- owner-approved local dogfood records the provider/runtime version and result without credentials or raw payloads.

Focused evidence 2026-09-07: on macOS arm64, Codex CLI `0.153.4` and Claude Code `2.1.260` each completed a real
IMPLEMENT read/write and QA read-only session through the proxy/executor in a temporary workspace with spaces and
Unicode. This does not replace full private-project or Windows acceptance.
