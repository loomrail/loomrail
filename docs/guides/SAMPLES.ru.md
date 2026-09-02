# Встроенные примеры и поставляемый workflow

> Публичная pre-alpha · [English version](SAMPLES.md) · [Быстрый старт](GETTING-STARTED.ru.md)

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
Встроенный Mock walkthrough по-прежнему измеряет readiness endpoint самого Loomrail, поэтому для первой проверки не
нужен второй server. Чтобы измерить sample application, запустите его и добавьте явный `.loomrail/browser-qa.json` по
[гайду Browser QA](BROWSER-QA.ru.md).

## Один поставляемый delivery workflow

Все recipes используют один domain-owned workflow, `mock-delivery-v1` revision 4:

```text
Discovery → Plan → Implement → Review → QA → Acceptance
```

Исторический ID не означает, что у live providers другой workflow. Mock, Codex и Claude Code adapters передают
результат в один deterministic state machine. Текущая pre-alpha не предлагает выбор workflow или custom templates.

## Каталог встроенных ролей

Standard squad назначает один versioned profile каждой стадии с provider run:

| Стадия    | Назначенная встроенная роль |
| --------- | --------------------------- |
| Discovery | Product Analyst             |
| Plan      | Software Architect          |
| Implement | Developer                   |
| Review    | Code Reviewer               |
| QA        | Browser QA                  |

Lead PM и Acceptance Manager также входят в versioned built-in catalog, но текущий standard squad их не dispatch-ит.
Criterion-bound Acceptance Package Loomrail детерминированно собирает из актуальных Review и QA evidence. Только
владелец может принять, вернуть или отклонить его.

Recipe не может изменить capabilities роли, budget, выбор provider, Project Constitution или approval gates. Это
остаётся состоянием Loomrail и решениями владельца, а не скрытыми инструкциями sample text.

## Выберите подходящий маршрут

- Используйте **Mock** и любой sample, чтобы без provider quota изучить durable requests, budgets, evidence, recovery
  после restart и acceptance. Mock не меняет source примера.
- Переходите к [примеру полного маршрута](../examples/full-route/README.md) только после допуска exact live provider
  version. Он запускает настоящий CLI, расходует quota и демонстрирует реальное изменение репозитория.
- Зелёный baseline sample — release evidence встроенного шаблона. Это не private dogfood evidence и не подтверждение
  совместимости unverified provider.

Release gate запускает тесты каждого sample из source и повторно из чистого npm tarball на macOS и Windows. Он также
отклоняет unreviewed files, dependencies, lifecycle scripts, symbolic links и изменённую catalog identity.
