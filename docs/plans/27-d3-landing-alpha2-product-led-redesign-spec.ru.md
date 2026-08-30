# D3 / alpha.2 — спецификация product-led redesign лендинга

**Статус:** выполнено

## Outcome

Лендинг Loomrail выглядит как современный developer product, быстро показывает настоящий Workbench и ведёт к
безопасному локальному запуску. Страница не изображает Loomrail каталогом компонентов, облачным сервисом или
полноценным агентным runtime: текущая публичная alpha остаётся local-first и mock-first.

## Аудитория и первый сценарий

- Основная аудитория — разработчик или технический founder, уже использующий Codex или Claude Code.
- За первый viewport пользователь понимает три вещи: агент может работать, решение остаётся за владельцем, Loomrail
  можно безопасно запустить вне репозитория.
- Главное действие — `Run locally`; исходники и документация остаются доступными, но вторичными.

## Информационная архитектура

1. Компактная floating pill navigation с Product, Install и Docs.
2. Split hero: короткий тезис, настоящий Workbench и полный безопасный маршрут запуска.
3. Большая интерактивная product wall с тремя фокусами на реальном screenshot.
4. Детерминированная цепочка Brief → Agent work → Evidence → Owner decision.
5. Контрастная install surface с требованиями runtime, платформ, сети и первого запуска.
6. Честная граница Available / Not claimed.
7. Задачный docs-index и тихий mast footer.

## Design direction

- Product-led atmospheric technical: холодный graphite, один electric-indigo signal, Geist + JetBrains Mono.
- Основной референс по энергии и масштабу доказательства — 21st.dev; дополнительные оси — shadcn/ui, React Bits и v0.
- Главный visual proof — настоящий Loomrail Workbench без fake browser/terminal chrome.
- Ритм намеренно неодинаковый: плотный hero, крупная сцена, воздух, короткие ruled sections.
- Никаких invented metrics, testimonials, logo wall, decorative gradients, glassmorphism или vanity cards.
- Light и dark используют один DOM и равноправные semantic token systems.

## Установка и документация

- Hero и install section показывают четыре безопасных команды полностью, без горизонтальной прокрутки на mobile.
- Copy action копирует точную последовательность создания отдельного каталога, установки `loomrail@next` и запуска.
- Docs-index ведёт к Quick start, Owner guide, full-route example, Security model и Architecture.
- RU/EN меняют copy, metadata, aria-labels, alt text и ссылку на локализованный Quick start.

## Acceptance

- 320, 375, 414, 768, 1280 и 1920 px не имеют horizontal overflow.
- На desktop 1280×720 безопасный маршрут остаётся внутри первого viewport.
- Clickable labels не переносятся, touch targets не меньше 44×44 px, visible focus работает с клавиатуры.
- Обе темы и оба языка просмотрены в браузере; product-view и copy feedback проверены.
- Landing tests, typecheck, production build и корневой `pnpm verify` проходят.
- Social preview и Hallmark fingerprint соответствуют новой визуальной системе.
