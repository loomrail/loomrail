# D3 — спецификация публичного лендинга

**Статус:** implemented

**Дата:** 2026-08-30

**Зависимости:** D1, D2, опубликованный `loomrail@0.1.0-alpha.1`

## 1. Задача

D3 создаёт одну публичную страницу, которая за один проход отвечает на четыре вопроса: что Loomrail меняет в
работе solo developer, почему это не ещё одна доска агентов, что уже действительно работает и как запустить
первый локальный маршрут. Лендинг не является отдельным источником продуктовой правды: его утверждения выводятся
из README, PD-001–PD-007, пользовательского гайда и воспроизводимого full-route example.

## 2. Аудитория и действие

- первый читатель — опытный solo developer из PD-002, уже использующий Codex или Claude Code;
- PD-007 остаётся поддерживаемой персоной, но не определяет первый экран до появления B5 + B1;
- главное действие — установить явный pre-alpha channel `loomrail@next` и пройти первый локальный маршрут;
- вторичные действия — открыть GitHub, пользовательский гайд и воспроизводимый пример.

## 3. Обещание и граница правды

Hero говорит **“Make agents show their work.”** и сразу содержит канонический descriptor PD-001:
**“The local control plane for accountable AI software teams.”** Обещание раскрывается через четыре свойства,
которыми уже владеет доменная модель Loomrail: определённый WorkItem, типизированное решение человека, evidence и
отдельное событие acceptance.

На странице обязательно видны ограничения pre-alpha:

- runtime локальный и browser-first, обязательного аккаунта и облака нет;
- macOS и Windows — blocking CI, Linux — best effort;
- Codex обслуживает весь маршрут, Claude Code пока только Discovery, Plan и Review;
- Loomrail не делает commit, push, merge или deploy;
- desktop packaging, remote mode и plugins пока не входят в текущий checkpoint.

Нельзя заявлять скорость, автономность, экономию, количество пользователей, design partners или функциональность
после D3.

## 4. Информационная архитектура

Страница использует Narrative Workflow, а не витрину карточек:

1. **Hero:** обещание, descriptor, честный статус, install CTA и настоящий светлый скриншот.
2. **Route:** Define → Decide → Verify → Accept как последовательность, а не список фич.
3. **Workbench proof:** настоящий тёмный скриншот с тремя текстовыми аннотациями — состояние, acceptance criteria,
   append-only activity.
4. **Current boundary:** плотный список «сегодня / не сегодня» без roadmap-обещаний.
5. **Install:** две команды, требования к Node, ссылки на D1 и D2.
6. **Statement footer:** “The agent can propose. Only the owner accepts.”

Навигация: `Route`, `Workbench`, `Limits`, `Install`, плюс рабочая command palette по `Cmd/Ctrl+K`. На узком экране
центральные ссылки скрываются, а palette становится меню.

## 5. Визуальный контракт

- genre: modern-minimal;
- macrostructure: Narrative Workflow;
- theme: Cobalt, с сохранением фирменного indigo и спокойных cool-neutral поверхностей;
- hero enrichment: E3 — один реальный скриншот в тонкой рамке, без browser chrome, наклона и тени;
- nav: N1b canonical SaaS three-section;
- footer: Ft5 Statement;
- один акцентный цвет занимает малую часть поверхности; никаких градиентов, glow, glassmorphism и vanity metrics;
- заголовки Space Grotesk, текст Inter, технические значения JetBrains Mono; все три шрифта self-hosted из build;
- 4px spacing scale, два радиуса, hairline borders, без декоративных теней;
- светлая и тёмная темы имеют одинаковую структуру и статус acceptance.

## 6. Интеракции и доступность

- skip link и семантические landmarks;
- видимый focus ring, клавиатурная навигация и нативный `<dialog>` для palette;
- `Cmd/Ctrl+K` открывает palette, `Escape` закрывает, стрелки меняют активную ссылку, `Enter` переходит;
- copy install command показывает loading, success и error в самом контроле без toast;
- theme toggle сохраняет только локальную настройку темы; без cookie, телеметрии и сетевых запросов;
- `prefers-reduced-motion` выключает вступительное движение;
- изображения содержат `width`, `height`; hero image загружается eagerly, второй скриншот — lazy;
- acceptance включает 320, 375, 414, 768 и desktop, обе темы, zoom/reflow и отсутствие horizontal scroll.

## 7. Техническая граница

Лендинг — отдельный vanilla TypeScript + Vite workspace `apps/landing`. Он не импортирует `apps/web`, daemon или
domain packages и не может менять runtime state. `docs/assets` остаётся единственным источником brand/screenshot
assets и передаётся Vite как public directory. Production build — статические HTML/CSS/JS/font/image files.

Публикация выполняется GitHub Pages workflow с минимальными permissions и pinned actions. Страница не содержит
форм, внешних script/font/analytics ресурсов или секретов. `base: "./"` делает artifact независимым от project-site
prefix.

## 8. Acceptance

D3 завершён, когда:

1. локальный build и тесты landing проходят внутри `pnpm verify`;
2. визуальная QA подтверждает светлую/тёмную темы и перечисленные viewport;
3. клавиатурные сценарии palette, темы и copy работают;
4. artifact не делает внешних resource requests и не содержит telemetry hooks;
5. GitHub Pages workflow зелёный, а публичный URL отдаёт текущую версию страницы;
6. README и decomposition указывают фактический URL и следующий checkpoint B5 + B1.
