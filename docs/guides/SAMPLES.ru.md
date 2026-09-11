# Встроенные примеры и поставляемый workflow

> Stable для macOS Apple Silicon · [English version](SAMPLES.md) · [Быстрый старт](GETTING-STARTED.ru.md)

Loomrail включает два маленьких шаблона репозитория. При регистрации Loomrail копирует проверенные regular files в
свой data directory, создаёт отдельный локальный Git repository и записывает его как Project. Loomrail не запускает
пример, не устанавливает зависимости, не создаёт remote и ничего не push-ит.

Оба примера используют только standard library Node.js. Откройте путь материализованного репозитория из
**Настройки → Проекты** и проверьте неизменённый baseline:

```bash
npm test
```

Команда `npm install` не нужна.

## Каталог репозиториев

| Встроенный Project | Baseline                                             | Готовые Task recipes                           |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| Web application    | Server-rendered список задач и явный loopback server | Фильтры статуса; доступный empty state         |
| API service        | Чистый in-memory HTTP-style обработчик issue         | Фильтр severity; валидированное создание issue |

В каждом материализованном репозитории есть `SAMPLE-WORKFLOWS.md`. Без изменений перенесите title, brief и acceptance
criteria одного recipe в новую задачу Loomrail. Recipes — ограниченные примеры входа, а не исполняемые scripts и не
дополнительные определения workflow.

Web sample можно явно запустить командой `npm start` на `http://127.0.0.1:4173`. Loomrail сам его не запускает.
Встроенный readiness plan измеряет endpoint самого Loomrail, поэтому для этой проверки не нужен второй server. Чтобы
измерить sample application, запустите его и добавьте явный `.loomrail/browser-qa.json` по
[гайду Browser QA](BROWSER-QA.ru.md).

## Один поставляемый delivery workflow

Все recipes используют один domain-owned workflow revision 4:

```text
Discovery → Plan → Implement → Review → QA → Acceptance
```

Локальные сессии Codex CLI и Claude Code CLI передают результат в один deterministic state machine. Текущий релиз не
предлагает выбор workflow или custom templates.

## Каталог встроенных ролей

Standard squad назначает один versioned profile каждой стадии с provider run:

| Стадия                | Назначенная встроенная роль |
| --------------------- | --------------------------- |
| Discovery             | Product Analyst             |
| Plan                  | Software Architect          |
| Implement             | Developer                   |
| Review                | Code Reviewer               |
| QA                    | Browser QA                  |
| Подготовка Acceptance | Acceptance Manager          |

Lead PM остаётся versioned built-in profile, который линейный squad не dispatch-ит. Acceptance Manager предлагает
criterion-bound package в artifact-only AgentRun, а Loomrail детерминированно связывает его с актуальными Review и QA
evidence. Только владелец может принять, вернуть или отклонить его.

Recipe не может изменить capabilities роли, budget, выбор provider, Project Constitution или approval gates. Это
остаётся состоянием Loomrail и решениями владельца, а не скрытыми инструкциями sample text.

## Выберите подходящий маршрут

- Используйте любой sample с совместимым локальным Codex CLI или Claude Code CLI, чтобы изучить durable requests,
  budgets, evidence, recovery после restart и acceptance. Локальная сессия расходует quota вашей подписки.
- [Пример полного маршрута](../examples/full-route/README.md) описывает end-to-end route. IMPLEMENT и QA выполняются
  только через ограниченные и аудируемые workspace tools Loomrail; прямой shell или permission bypass не выдаётся.
- Зелёный baseline sample — release evidence встроенного шаблона. Это не private dogfood evidence и не подтверждение
  совместимости unverified provider.

Release gate запускает тесты каждого sample из source и повторно из чистого npm tarball на macOS и Windows. Он также
отклоняет unreviewed files, dependencies, lifecycle scripts, symbolic links и изменённую catalog identity.
