# Provider CLI compatibility: первичное исследование

**Дата среза:** 2026-09-02

**Область:** официальные OpenAI Codex CLI и Anthropic Claude Code CLI, необходимые Loomrail для managed live runs.
Исследование не запускало provider session, не выполняло login и не расходовало provider quota. Источники — только
официальная документация, официальные repositories/releases и опубликованные package metadata владельца CLI.

## Короткий вывод

Оба provider CLI официально поддерживают неинтерактивный JSONL-вывод и JSON Schema для **финального результата**.
Ни OpenAI, ни Anthropic в просмотренных first-party материалах не обещают, что весь streaming envelope этих CLI —
versioned stable protocol с backward-compatibility policy. `--output-schema` и `--json-schema` не меняют этого: они
ограничивают финальный model result, а не форму, порядок или исчерпывающий набор промежуточных событий.

Следствие для Loomrail: provider version нельзя считать совместимой только потому, что executable существует,
authentication готова и flags принимаются. Публичная support matrix должна перечислять точные проверенные
`provider + CLI version + OS/architecture + invocation contract`; всё более новое сначала получает статус
`UNVERIFIED`, а всё неизвестное или неразбираемое fail closed для managed live runs. Mock, diagnostics и ручное
обновление provider CLI при этом остаются доступны.

На дату среза последние опубликованные upstream releases:

- OpenAI Codex CLI [`0.152.1`](https://github.com/openai/codex/releases/tag/rust-v0.152.1), опубликован 2026-09-01;
- Anthropic Claude Code [`2.1.258`](https://github.com/anthropics/claude-code/releases/tag/v2.1.258), опубликован
  2026-09-01.

Это **upstream current candidates**, а не автоматически доказанные Loomrail-supported versions.

## Матрица документированных фактов

| Область                                  | OpenAI Codex CLI                                                                                                                                                                                           | Anthropic Claude Code CLI                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recommended install                      | Standalone: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` для macOS/Linux; `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` для Windows                | Native: `curl -fsSL https://claude.ai/install.sh \| bash` для macOS/Linux/WSL; `irm https://claude.ai/install.ps1 \| iex` для PowerShell; отдельный `.cmd` installer для CMD                                                       |
| Другие install paths                     | `npm install -g @openai/codex`; `brew install --cask codex`; platform binary из GitHub Release                                                                                                             | Homebrew, WinGet, apt/dnf/apk; npm остаётся доступен, но native install рекомендован                                                                                                                                               |
| Update                                   | Повтор standalone installer; `npm install -g @openai/codex`; `brew upgrade --cask codex`. Текущий official source также содержит `codex update`, который выбирает действие по распознанному install method | Native install auto-updates; ручной `claude update`; для внешнего manager — соответствующий `brew upgrade ...`, `winget upgrade Anthropic.ClaudeCode`, apt/dnf/apk command; npm: `npm install -g @anthropic-ai/claude-code@latest` |
| Version report                           | `codex --version` (`-V` создаётся тем же CLI parser); официальный Windows installer сам проверяет установленный binary этим вызовом                                                                        | `claude --version`; документированный пример формы: `2.1.211 (Claude Code)`. `claude doctor` даёт более широкий read-only install/config report                                                                                    |
| Основной non-interactive stream          | `codex exec --json`: stdout становится JSONL                                                                                                                                                               | `claude -p --output-format stream-json`: stdout становится newline-delimited JSON; для partial token events нужны `--verbose --include-partial-messages`                                                                           |
| Финальный schema contract                | `--output-schema <FILE>` задаёт JSON Schema финального response                                                                                                                                            | `--json-schema '<JSON>'` задаёт JSON Schema финального `structured_output`; документация показывает его с `--output-format json`                                                                                                   |
| Stable versioned stream schema promised? | **Нет найденного обещания.** Документированы event/item kinds и Rust-типы текущего release, но stream не несёт protocol/schema version и нет compatibility policy                                          | **Нет найденного обещания.** Документированы сообщения, отдельные поля и version thresholds; optional `system/init.capabilities` предназначен для feature detection, но не версионирует весь stream                                |

### Источники команд

OpenAI [Codex CLI quickstart](https://learn.chatgpt.com/docs/codex/cli) перечисляет standalone, Windows, npm и
Homebrew install/update commands. Официальный
[`MultitoolCli`](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/cli/src/main.rs#L104-L119) включает
generated version flag, а тот же source объявляет
[`codex update`](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/cli/src/main.rs#L173-L177) и закрывает
его ошибкой, когда install method нельзя безопасно определить
([implementation](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/cli/src/main.rs#L886-L901)).
Windows installer после установки вызывает
[`codex --version`](https://github.com/openai/codex/blob/rust-v0.152.1/scripts/install/install.ps1#L406-L420).

Anthropic [Advanced setup](https://code.claude.com/docs/en/setup) является единым источником system requirements,
native/Homebrew/WinGet/Linux/npm install, `claude --version`, auto-update и ручного `claude update`. Для npm
документация требует именно `npm install -g @anthropic-ai/claude-code@latest` и предупреждает, что `npm update -g`
может оставить старую версию из-за исходного semver range.

## Platforms и runtime requirements

### OpenAI Codex CLI — документировано

Официальный repository для release `0.152.1` перечисляет
[macOS 12+, Ubuntu 20.04+/Debian 10+ и Windows 11 через WSL2](https://github.com/openai/codex/blob/rust-v0.152.1/docs/install.md#system-requirements),
4 GB RAM minimum и optional Git 2.23+. Одновременно более новая public CLI page предлагает официальный native
Windows installer, а текущая [Windows documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox)
описывает native CLI и Windows sandbox. Это first-party несогласованность между repository requirements и текущей
product documentation, а не основание самостоятельно расширять поддержку Loomrail.

Standalone binary не требует Node.js. Для npm artifact `@openai/codex@0.152.1` опубликованное package metadata
задаёт [`node >=16`](https://registry.npmjs.org/@openai%2fcodex/0.152.1). Loomrail всё равно имеет собственный более
строгий Node runtime gate; provider CLI runtime нельзя подменять runtime-ом Loomrail.

### Anthropic Claude Code — документировано

Текущий [system requirements](https://code.claude.com/docs/en/setup#system-requirements):

- macOS 13.0+;
- Windows 10 1809+ или Windows Server 2019+;
- Ubuntu 20.04+, Debian 10+, Alpine Linux 3.19+;
- x64 или ARM64, 4 GB+ RAM, network и поддерживаемый shell.

[Native Windows и WSL описаны раздельно](https://code.claude.com/docs/en/setup#set-up-on-windows): native Windows
поддерживается, но provider sandboxing там не поддерживается; WSL2 поддерживает sandboxing. Git for Windows optional
и нужен для Bash tool, иначе используется PowerShell tool.

Native binary не использует Node.js. Только npm install path начиная с v2.1.198 требует
[Node.js 22+](https://code.claude.com/docs/en/setup#install-with-npm); документация отдельно говорит, что npm package
скачивает тот же native binary и установленный `claude` сам Node не запускает.

## Что именно обещает JSON Schema

### Codex: `codex exec --json --output-schema`

**Документированный факт.** `--json` делает stdout JSONL и документирует top-level виды `thread.started`,
`turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`, а также несколько item kinds
([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable)).
`--output-schema` просит финальный response соответствовать пользовательской JSON Schema и предназначен для
стабильных **пользовательских полей финального результата**
([structured output](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema)).

**Граница обещания.** В official source текущего release top-level stream — tagged Rust enum
[`ThreadEvent`](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/exec/src/exec_events.rs#L8-L37), а
structured final answer остаётся строкой `AgentMessage.text`
([`ThreadItemDetails::AgentMessage`](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/exec/src/exec_events.rs#L104-L118)).
В этом envelope нет `schema_version`/`protocol_version`. CLI flag всё ещё принимает alias
[`--experimental-json`](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/exec/src/cli.rs#L58-L65).
Просмотренные docs/source не задают backward-compatibility window, migration rules или formal JSON Schema для всей
последовательности событий.

**Вывод, не upstream promise.** Комбинация пригодна для bounded adapter, но `--output-schema` нельзя считать
гарантией стабильности `thread.*`/`turn.*`/`item.*`. Loomrail должен отдельно валидировать и stream envelope, и
JSON внутри финального agent message.

### Claude: `claude -p --output-format stream-json --json-schema`

**Документированный факт.** CLI reference объявляет и `stream-json`, и
[`--json-schema`](https://code.claude.com/docs/en/cli-reference#cli-flags). Headless guide называет `stream-json`
newline-delimited JSON и говорит, что последняя строка — `result` message
([stream responses](https://code.claude.com/docs/en/headless#stream-responses)). Для structured CLI output этот же
guide показывает `--json-schema` вместе с **`--output-format json`**, где validated value находится в
`structured_output`
([get structured output](https://code.claude.com/docs/en/headless#get-structured-output)).

Официальная Agent SDK документация уточняет общую семантику: structured JSON появляется только в финальном
[`ResultMessage.structured_output`, не в streaming deltas](https://code.claude.com/docs/en/agent-sdk/streaming-output#known-limitations).
Следовательно, даже когда CLI принимает `stream-json + --json-schema`, пользовательская schema относится к финальному
`structured_output`, а не ко всем JSONL events.

**Прямые признаки эволюционирующего контракта в official docs:** invalid `--json-schema` до v2.1.205 молча
игнорировалась; с v2.1.205 это startup error
([headless structured output](https://code.claude.com/docs/en/headless#get-structured-output)). До v2.1.214 процесс
мог завершить ожидание медленного stdout consumer примерно через две секунды и обрезать конец большого response;
текущий cap — 30 секунд
([stream responses](https://code.claude.com/docs/en/headless#stream-responses)). Новые stream fields/events также
имеют точные minimum-version notes. Например, `system/init.capabilities` доступен с v2.1.205, и Anthropic рекомендует
feature-detect значения, игнорируя неизвестные, вместо сравнения version strings
([session metadata](https://code.claude.com/docs/en/headless#read-session-metadata)).

**Граница обещания.** First-party docs описывают полезные части event shapes и SDK types, но не объявляют весь CLI
JSONL stream единым versioned stable protocol и не дают общей backward-compatibility policy. `capabilities` покрывает
отдельные поведения, а не является schema version.

**Вывод, не upstream promise.** Для нового conservative baseline версия Claude Code ниже `2.1.214` не подходит:
официально зафиксированы более слабая invalid-schema семантика до `2.1.205` и риск неполного pipe drain до `2.1.214`.
Даже `>=2.1.214` не образует автоматически совместимый semver range — каждая публично поддерживаемая версия должна
быть проверена exact adapter argv и fixtures.

## Рекомендуемая conservative support policy для Loomrail

Ниже — инженерный вывод Loomrail, а не обещание OpenAI или Anthropic.

### 1. Закрытые compatibility states

Version probe должен возвращать один из закрытых результатов:

```text
MISSING | UNLAUNCHABLE | VERSION_UNREADABLE | TOO_OLD | VERIFIED | UNVERIFIED
```

- `VERIFIED` разрешает managed live run только для exact matrix row.
- `UNVERIFIED`, `TOO_OLD` и `VERSION_UNREADABLE` блокируют новый managed live run с безопасным next action;
  уже записанные sessions не переобозначаются задним числом.
- Mock, `doctor`, data lifecycle и browser-only UI продолжают работать.
- Probe запускает только `codex --version` / `claude --version`: argv array, no shell, bounded output/time, без login,
  session или provider request. Raw stderr, executable path и exception text не становятся public report.

### 2. Exact rows вместо широкого semver promise

Одна строка support matrix должна включать минимум:

```text
provider
cliVersion
os
architecture
installationKind
invocationContractVersion
sanitizedFixtureDigest
verifiedAt
verificationResult
```

`0.x` Codex и быстро меняющаяся Claude line не должны получать `^`, `>=` или «latest supported» только на основании
успешного version parse. Для blocking macOS/Windows support одна версия становится `VERIFIED` только после одинаковых
contract/replay gates на обеих ОС. Удобная операционная цель — одна preferred exact version и, при необходимости,
одна предыдущая exact version на provider; неограниченный historical range создаёт неподдерживаемое тестовое бремя.

Current upstream `0.152.1` и `2.1.258` следует сначала поместить в matrix как `UNVERIFIED`, затем повысить
только после отдельного evidence run. Для Claude разумный нижний admission floor для новых строк — `2.1.214`;
для Codex официальный материал не даёт сопоставимого безопасного floor, поэтому нужен только exact allowlist.

### 3. Два независимых слоя runtime validation

1. **Provider stream envelope:** каждая строка — valid bounded JSON object; adapter распознаёт только закрытый набор
   authority-bearing событий. Additive незнакомое informational event можно ограниченно пропустить и записать
   redacted drift marker. Неизвестная terminal semantics, malformed line, missing terminal event или conflicting
   completion переводит ProviderSession в typed failure/interruption и не двигает workflow.
2. **Final domain result:** значение из Codex `agent_message.text` или Claude `result.structured_output` повторно
   валидируется Loomrail schema. Provider exit code 0, `turn.completed`/`result.success` или upstream validation сами
   по себе не дают workflow authority.

### 4. Fixtures и upgrade lifecycle

- Хранить отдельные sanitized recordings для exact provider version и exact argv, не «универсальную» hand-written
  fixture.
- Negative corpus обязан покрывать unknown additive event, changed/missing required field, oversize line/count,
  duplicate/conflicting terminal, successful exit without structured result и schema-invalid final value.
- Provider release не обновляет support matrix автоматически. Сначала docs/changelog review, затем fixture capture,
  parser tests, macOS/Windows gate и только потом новая matrix revision.
- Loomrail не выполняет upstream installer, `codex update`, `claude update`, package-manager command, login или
  downgrade. UI/CLI только показывает version status и официальный owner-run command для обнаруженного install kind.
- Exact provider version и matrix revision записываются на ProviderSession/AgentRun evidence, но executable path,
  account identity и raw provider output не попадают в primary UI или обычный audit.

## Что этим исследованием не доказано

- Не доказано, что current Loomrail adapters совместимы с Codex `0.152.1` или Claude Code `2.1.258`: provider run не
  выполнялся.
- Не доказана идентичность stream behavior на macOS и Windows.
- Не доказано, что любая future patch/minor version сохраняет event shape.
- Не доказано, что `claude --output-format stream-json --json-schema` во всех поддерживаемых версиях полностью
  эквивалентен Agent SDK structured-output path; public CLI guide рекомендует `--output-format json` для schema
  example.
- Не доказано, что native Windows provider sandbox заменяет Loomrail permission/workspace boundary. У Claude native
  Windows sandboxing официально отсутствует; provider sandbox в любом случае не является authority Loomrail.

Эти пункты должны оставаться explicit verification work, а не превращаться в assumptions support matrix.
