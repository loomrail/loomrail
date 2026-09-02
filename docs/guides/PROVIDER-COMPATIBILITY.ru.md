# Совместимость provider CLI

> Публичная pre-alpha · [English version](PROVIDER-COMPATIBILITY.md)

Loomrail считает provider CLI готовым, только когда совпали три независимых наблюдения: executable существует,
точная версия имеет проверенную строку compatibility matrix, а provider-owned authentication status успешен. Сама
установка или авторизация не доказывает совместимость.

## Текущая матрица

Candidate `0.1.0-alpha.5` начинает без проверенной live-provider строки. Это намеренно: ни один provider не обещает
versioned backward-compatible schema всего JSONL event stream, а существующие recordings не доказывают одинаковый
invocation на macOS и Windows.

| Provider    | Версия   | Evidence                                                              | Допуск managed live |
| ----------- | -------- | --------------------------------------------------------------------- | ------------------- |
| Mock        | built-in | Детерминированные local, macOS и Windows gates                        | `BUILT_IN` — готов  |
| Codex       | 0.144.1  | Настоящие успешные recordings на macOS arm64; MCP path не проверен    | `UNVERIFIED` — блок |
| Claude Code | 2.1.114  | Настоящий unauthenticated stream; successful result создан из fixture | `TOO_OLD` — блок    |
| Codex       | 0.152.1  | Текущий upstream candidate; Loomrail adapter run не выполнялся        | `UNVERIFIED` — блок |
| Claude Code | 2.1.258  | Текущий upstream candidate; Loomrail adapter run не выполнялся        | `UNVERIFIED` — блок |

Upstream versions — релизы на дату research-среза 2026-09-02, а не рекомендация установить или понизить версию.
First-party источники и точные границы утверждений находятся в
[primary research](../product/PROVIDER-COMPATIBILITY-PRIMARY-RESEARCH-2026-09.md).

До promotion live row используйте Mock walkthrough. AUTO остаётся на явно обозначенном Mock fallback. Явный выбор
Codex или Claude Code остаётся видимым, но новый provider process не запускается; Loomrail не подменяет его другим
provider и не выдаёт Mock-работу за live.

## Локальный статус

Выполните:

```bash
npx loomrail doctor
```

Либо откройте **Настройки → ИИ-провайдер** и нажмите **Проверить снова**. Loomrail показывает только нормализованную
версию и одно closed state:

- `VERIFIED` — существует exact matrix row; после этого можно проверить authentication;
- `UNVERIFIED` — версия распознана, но exact cross-platform row отсутствует;
- `TOO_OLD` — версия ниже documented admission floor;
- `VERSION_UNREADABLE` или `UNLAUNCHABLE` — bounded observation не установил identity;
- `MISSING` — executable не найден;
- `BUILT_IN` — только Mock.

Version probe запускает fixed argv `codex --version` или `claude --version` без shell. Deadline — три секунды, stdout
ограничен 96 bytes, stderr игнорируется; executable path, raw output, account и exception text не возвращаются. Auth
status не запускается до `VERIFIED`.

## Почему нет semver range

Оба CLI документируют JSONL и schema-constrained final output. JSON Schema относится к финальному model result, а не
ко всему stream envelope. Ни один provider не описывает backward-compatibility policy для всех промежуточных events.
Claude Code также документирует schema и stdout-drain fixes внутри одной линии `2.1.x`. Поэтому Loomrail не выводит
совместимость из `>=`, `^`, нового patch или `latest`.

Claude Code ниже `2.1.214` не может стать новой matrix row. Этот floor только отсекает заведомо более слабое
поведение; он не делает `2.1.214` или новую версию проверенной. Для Codex inferred floor/range отсутствует.

## Promotion версии

Live version становится `VERIFIED` только reviewed-изменением Loomrail с exact CLI version, OS/architecture, install
kind, invocation-contract revision, sanitized real-CLI success/failure/workspace/MCP streams, negative parser corpus
и одинаковым macOS/Windows evidence. Provider update не меняет matrix автоматически.

Capture таких streams запускает настоящую provider-работу и может расходовать quota, поэтому требует отдельного
разрешения владельца. Loomrail не запускает installer, updater, login или downgrade. Управляйте CLI по официальной
документации provider и используйте Mock, пока установленная версия не получит `VERIFIED`.
