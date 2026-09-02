# Q9 — Provider compatibility matrix

**Дата:** 2026-09-02

**Статус:** synthetic admission implementation and macOS/Windows evidence complete; live row promotion pending

**Предшественники:** A2, Provider Selection, Q4, Q8

**Нормативные решения:** AD-004, AD-005, SD-001, SD-003, T16–T18, T26, T40, T42

**Primary research:**
[PROVIDER-COMPATIBILITY-PRIMARY-RESEARCH-2026-09.md](../product/PROVIDER-COMPATIBILITY-PRIMARY-RESEARCH-2026-09.md)

## 1. Outcome

Loomrail перестаёт считать любой найденный и авторизованный provider CLI готовым к managed run. Перед новой live
session registry выполняет bounded version observation и допускает dispatch только для exact version, имеющей
проверенную matrix row. AUTO игнорирует unverified CLI; explicit preference остаётся выбранным, но fail closed до
spawn. Mock, diagnostics и остальные локальные функции продолжают работать.

Q9 не запускает provider session и не обещает поддержку текущего upstream release. Он создаёт проверяемый admission
contract, owner-visible status и lifecycle, через который будущая версия становится поддерживаемой только после
recording/replay и macOS/Windows evidence.

## 2. Термины и authority

**Provider Compatibility Observation** — краткоживущий результат fixed `--version` probe для одного executable. Это
не provider capability declaration, не auth state, не installation receipt и не доказательство того, что binary не
заменили после проверки.

**Provider Compatibility Matrix Row** — reviewable запись exact provider CLI version и exact Loomrail invocation
contract, подтверждённая sanitized real-CLI recordings, parser/negative corpus и одинаковым macOS/Windows gate.
Широкие semver ranges, `latest` и успешный exit `--version` не являются строкой матрицы.

**Compatibility status** — закрытое состояние:

- `BUILT_IN` — только Mock;
- `MISSING` — executable не найден;
- `UNLAUNCHABLE` — version process не удалось безопасно завершить;
- `VERSION_UNREADABLE` — bounded output/exit не соответствует exact parser;
- `TOO_OLD` — версия ниже documented admission floor;
- `VERIFIED` — exact version присутствует в cross-platform matrix;
- `UNVERIFIED` — версия распознана, но exact matrix row отсутствует.

Только `BUILT_IN` и `VERIFIED` совместимы с `ready=true`. Compatibility не меняет уже запущенную ProviderSession и
не получает authority над Project preference, provider install/login/update или workflow state.

## 3. Version observation

Registry проверяет только установленный live CLI:

- Codex: `codex --version`;
- Claude Code: `claude --version`.

Процесс запускается argv-массивом с `shell:false`, закрытым stdin, отброшенным stderr, отдельным минимальным env,
трёхсекундным deadline и пределом stdout 96 bytes. При overflow child останавливается. Parser принимает только exact
product-owned формы `codex-cli <semver>` и `<semver> (Claude Code)`, возвращает нормализованную version не длиннее 48
символов и никогда не возвращает raw output, executable path или exception.

Auth status вызывается только после `VERIFIED`, потому что иной CLI всё равно не может стать ready. Version refresh
остаётся read-only и не вызывает login, installer, updater, package manager, provider request или quota.

## 4. Initial matrix

В Q9 initial matrix нет live `VERIFIED` row:

| Provider    | Version  | Evidence                                                       | Admission    |
| ----------- | -------- | -------------------------------------------------------------- | ------------ |
| Mock        | built-in | deterministic local + macOS/Windows release/browser gates      | `BUILT_IN`   |
| Codex       | 0.144.1  | real successful recordings, только macOS arm64; MCP не доказан | `UNVERIFIED` |
| Claude Code | 2.1.114  | real unauthenticated stream; successful result derived         | `TOO_OLD`    |
| Codex       | 0.152.1  | current upstream candidate; adapter run не выполнялся          | `UNVERIFIED` |
| Claude Code | 2.1.258  | current upstream candidate; adapter run не выполнялся          | `UNVERIFIED` |

Claude Code ниже `2.1.214` получает `TOO_OLD` из-за first-party documented schema/stdout fixes. Для Codex research не
даёт безопасного floor: любая распознанная version без exact row остаётся `UNVERIFIED`.

Отсутствие live row — явный release gap, а не скрытый fallback. Для его закрытия владелец отдельно авторизует
quota-bearing capture на exact CLI version; CI без credentials не изображает real-provider evidence.

## 5. Availability, CLI и UI

`ProviderAvailability` добавляет нормализованные `version` и `compatibility`. Для live provider:

```text
ready = installed && compatibility == VERIFIED && authentication == AUTHENTICATED
```

- AUTO выбирает только `ready` provider и иначе явно использует Mock;
- explicit live preference остаётся effective, но adapter `start=false` до `VERIFIED` и auth readiness;
- `doctor` показывает только normalized version/status и остаётся WARN, если live compatibility нет;
- guided Live setup блокируется через существующий `ready` contract; Mock setup не блокируется отсутствием live row;
- Settings отличает missing, unverified/too-old/unreadable и auth-required, не советует автоматический downgrade;
- refresh повторяет bounded version/auth observations, но не меняет preference и не прерывает live session.

## 6. Matrix promotion lifecycle

Exact live version может стать `VERIFIED` только одним reviewed change, который:

1. фиксирует provider/version, OS/architecture, install kind и invocation-contract revision;
2. добавляет sanitized real-CLI success/failure/workspace/MCP recordings без personal paths/secrets;
3. прогоняет bounded stream parser и negative corpus, включая unknown/malformed/oversize/conflicting terminal events;
4. повторно валидирует final domain result Loomrail schema независимо от provider exit code;
5. получает одинаковое macOS и Windows evidence либо явно не заявляет обе платформы;
6. обновляет public EN/RU matrix и threat-model evidence.

Новая upstream release не меняет matrix автоматически. Loomrail не устанавливает, не обновляет и не понижает
provider CLI.

## 7. Security delta

T43: poisoned PATH executable может напечатать secret/path или бесконечный stdout; future CLI может сохранить exit
0, но изменить terminal event semantics. Rated High, потому что false-compatible status разрешил бы процесс с
repository/quota authority.

Контроли: version-before-auth; fixed argv/no shell/minimal env; bounded stdout/deadline; exact parser; no raw output;
exact allowlist; `ready` invariant; no auto-update/downgrade; independent runtime validation provider envelope и
final domain result; owner-visible fail-closed status.

## 8. Acceptance criteria

1. Missing/unlaunchable/unreadable/too-old/unverified live CLI никогда не имеет `ready=true` и не запускается.
2. Mock всегда `BUILT_IN`, ready и не вызывает version/auth process.
3. AUTO игнорирует неподтверждённый live CLI; explicit preference не подменяется другим provider или Mock success.
4. Version probe ограничивает argv/env/time/output и не раскрывает raw/path/error canaries.
5. Doctor JSON/human и Settings RU/EN показывают closed compatibility; guided Mock остаётся READY, Live — BLOCKED.
6. Refresh может увидеть version change, не сохраняя output и не меняя preference/session.
7. Unit/integration/browser/package gates проходят локально; macOS/Windows synthetic probe/parity gate обязателен.
8. Q9 не меняет `apps/landing/**`, не запускает provider session/login/update и не публикует npm package.

## 9. Non-goals

- authenticated real-provider capture без отдельного owner approval;
- semver range promise или automatic matrix promotion;
- provider install/update/downgrade/login;
- model compatibility или provider account/quota validation;
- durable reinterpretation уже записанных ProviderSessions;
- desktop packaging, telemetry или npm publication.
