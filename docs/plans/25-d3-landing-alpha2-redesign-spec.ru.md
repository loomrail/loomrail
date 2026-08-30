# D3 / alpha.2 — спецификация полного redesign лендинга

**Статус:** выполнено

## Outcome

Публичная страница Loomrail объясняет продукт на уровне сильных developer-tool лендингов, но остаётся точной текущему
scope: local-first control plane, durable workflow state, human authority и публичный pre-alpha.

## Product truth

- Основное определение: **The local control plane for accountable AI software teams.**
- Provider output — вход; Loomrail владеет workflow state, gates, permissions, budgets и acceptance.
- Первый безопасный маршрут использует deterministic mock и не запускает Codex/Claude Code.
- Done требует owner Decision.
- Нет автоматических commit, push, merge или deploy.
- Текущая дистрибуция — npm; macOS и Windows blocking, Linux best effort.

## Информационная архитектура

1. Marquee hero с одним определением продукта.
2. Install plate: полный project-local маршрут, требования и ссылки на quick start/source.
3. Ownership ledger: Brief, Human Request, Evidence, Decision.
4. Настоящий Workbench с аннотациями.
5. Детерминированный control loop и Git/security boundary.
6. «Available today / Not claimed in alpha.2».
7. Отдельный docs-index.
8. Dense colophon с версией и честными product flags.

## Design direction

- Editorial Grid: Archivo, открытая 12-column rail-сетка, cool paper/ink, один ultramarine signal.
- Ноль decorative cards, gradients, glass, shadows и fake browser chrome.
- Light/dark — равные acceptance targets, несмотря на light-first характер Grid.
- RU/EN используют один DOM и одинаковую полноту обещаний.
- Motion ограничен одной загрузочной анимацией hero и feedback копирования; reduced-motion обязателен.

## Acceptance

- На 1280×800 целиком виден hero statement; CTA к установке остаётся в nav.
- 320, 375, 414, 768, 1280 и 1920 px не имеют horizontal overflow.
- Clickable labels не переносятся, focus видим, targets на touch не меньше 44 px.
- Обе темы и оба языка просмотрены в браузере.
- Landing tests, typecheck и production build проходят.
- Research note содержит прямые ссылки на официальные референсы.
- Страница и документация называют `0.1.0-alpha.2` перед выпуском этой версии.
