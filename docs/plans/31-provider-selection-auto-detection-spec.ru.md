# Provider Selection: AUTO и выбор провайдера в Project Settings

**Статус:** утверждено владельцем 31 августа 2026

## 1. Проблема

Живой провайдер сейчас выбирается только переменной `LOOMRAIL_PROVIDER` при запуске daemon. Это делает обычный
локальный сценарий зависимым от дополнительной команды, не показывает состояние авторизации в продукте и закрепляет
один адаптер за всем процессом. Пользователь уже установивший и авторизовавший Codex или Claude Code ожидает, что
Loomrail найдёт его сам, а при наличии выбора даст управлять им в Settings.

## 2. Решение

### D1. Preference принадлежит Project

Каждый Project хранит `ProviderPreference`: `AUTO`, `CODEX`, `CLAUDE_CODE` либо `MOCK`. Новый и существующий Project
получает `AUTO`. Изменение проходит versioned command, сохраняет Project, audit Event и command receipt одной SQLite
транзакцией.

Preference применяется к новой `ProviderSession`. Уже запущенная сессия остаётся у адаптера, записанного в ней при
старте; смена Settings не перенаправляет process, abort или handoff другому адаптеру.

### D2. AUTO проверяет готовность, а не только PATH

При старте daemon и по явному Refresh Loomrail для каждого live provider определяет:

1. найден ли executable;
2. подтверждает ли официальный read-only status command текущую авторизацию.

Codex проверяется `codex login status`, Claude Code — `claude auth status`. Процесс запускается argv-массивом без
shell, с ограниченным временем, закрытым stdin и отброшенными stdout/stderr. Loomrail использует только exit outcome:
вывод, токены, account metadata и provider credentials не читаются, не логируются и не сохраняются.

AUTO выбирает готовый live provider. Если готовы оба, предпочтение получает адаптер с более полным покрытием
WorkflowStage; при равном покрытии порядок стабилен. Если live provider не готов, AUTO остаётся в явно помеченном
Mock demo mode, а Settings показывает `Sign in required` либо `Not installed` и способ исправления.

### D3. Явный выбор не маскируется fallback-ом

Явно выбранный `CODEX` или `CLAUDE_CODE` остаётся effective provider даже когда CLI отсутствует либо не авторизован.
Его `start` capability становится `false`, поэтому существующий domain gate отказывает dispatch до запуска process.
Loomrail не пробует другой live provider и не завершает stage на mock так, будто выбранный агент выполнил работу.

`MOCK` — явный demo mode. AUTO fallback на Mock всегда отмечен source/status в API и UI.

### D4. Environment — только override

`LOOMRAIL_PROVIDER=MOCK|CODEX|CLAUDE_CODE` остаётся startup-only override с приоритетом над Project preference. UI
показывает override и блокирует selector, чтобы Settings не обещал изменение, которое daemon проигнорирует. Неизвестное
значение остаётся видимой ошибкой конфигурации и не превращается в скрытый live запуск.

### D5. Один registry, стабильные adapters

Daemon создаёт по одному экземпляру Mock, Codex и Claude Code adapter. Resolver выбирает адаптер для конкретного
Project непосредственно перед новой dispatch. Экземпляры не пересоздаются: их in-memory session maps нужны для
корректного abort. Worker хранит ссылку на адаптер текущей live session и использует именно её при shutdown.

## 3. HTTP/UI

- `GET /api/v1/projects/:projectId/provider-selection` возвращает durable preference, effective provider, source,
  availability всех адаптеров и capability выбранного адаптера;
- `PUT /api/v1/projects/:projectId/provider-selection` принимает preference и expected Project version;
- `POST /api/v1/projects/:projectId/provider-selection/refresh` повторяет только bounded availability probes;
- все mutation routes требуют session, exact Origin, JSON content type и CSRF;
- Project Settings показывает Auto / Codex / Claude Code / Mock, текущий effective provider и actionable status на
  русском и английском;
- keyboard/focus и light/dark являются частью acceptance.

## 4. Не входит

- установка CLI, browser login automation и хранение provider credentials;
- автоматический permission bypass;
- provider/model selection по отдельной stage или AgentProfile;
- MCP registry и MCP assignments — они строятся следующим C1 slice поверх этого selection contract;
- изменения лендинга.

## 5. Acceptance

1. На машине ровно с одним авторизованным live CLI новый Project в AUTO выбирает его без env-команды.
2. Preference переживает restart и имеет audit Event.
3. Смена preference во время session не ломает abort и не меняет provider уже записанной session.
4. Явно выбранный неготовый provider fail-closed до spawn; другой live provider и mock не запускаются.
5. Probe не сохраняет и не возвращает stdout/stderr/auth metadata.
6. Environment override видим и selector заблокирован.
7. API, Settings RU/EN, keyboard и light/dark покрыты тестами; `apps/landing` не изменён.
