# Лендинг: оркестрация и стартовые проекты

**Дата:** 2026-09-19

**Статус:** implemented and locally verified; owner одобрил commit/push/publication и CI fix.

## Scope

Owner запросил улучшить существующий лендинг и показать оркестрацию и бойлерплейты. Сохраняются Vite,
RU/EN, semantic tokens, light/dark, канонический install contract и существующие маршруты документации.
Первый экран объясняет роли человека, локальных CLI и детерминированного workflow через интерактивную схему.
Новый блок различает собственный repository, единственный builtin `typescript-node@1` и demo workspace.

## Truth and safety

- PD-013 / ADR-0007: только один встроенный scaffold; preview и owner confirmation, без install/commit/push.
- PD-033 / ADR-0032: live support только macOS Apple Silicon; Windows/Linux не заявляются.
- Текущая оркестрация — шесть domain-owned stages, independent Review, measured QA и HUMAN Acceptance.
- Code-blind Astra/Fable manager остаётся исследованием; никаких обещаний его наличия или измеренной экономии.
- Local state не означает offline inference: providers работают через их официальные CLI.
- Нет нового runtime capability, сторонних ресурсов, аналитики, dependencies или ослабления CSP.
  Existing T34 scaffold и T85 support boundaries не меняются; отдельный threat delta не требуется.
- Прежний npm source `49d9dbd` не прошёл все blocking CI gates (Windows job timeout).
  Owner одобрил публикацию лендинга и исправление CI для завершения релиза. Новый source 0.1.3
  будет выбран после merge и успешного main CI; старый staging request подлежит отмене.

## Verification

- Static content / bilingual claims / keyboard disclosure tests и canonical activation checks.
- Browser review RU/EN, light/dark, 320/375/414/768 и desktop; 200% zoom, reduced motion, copy success/failure.
- `pnpm verify` перед передачей; публикация лендинга отдельно от npm через существующий Pages workflow.

### Проверено 2026-09-19

- Landing unit: 12/12; activation contract: 7/7; landing browser: 9/9.
- В браузере: RU/EN × light/dark, ширины 320/375/414/768, keyboard disclosure/focus/skip link,
  reduced motion и увеличение базового текста до 200%. Горизонтального overflow нет.
- Визуально просмотрены desktop и mobile production build, включая длинный русский текст.
  На 1280×800 основной CTA находится в первом экране; видимого текста меньше 12px нет.
- Проверка вычисленных цветов видимого текста в стабильных light/dark состояниях: WCAG AA contrast.
- `pnpm verify` завершился успешно: форматирование, public readiness, полная сборка, lint,
  typecheck и полный набор тестов workspace. Повторный landing browser gate: 9/9.
- Для browser tests добавлен проверяемый `LOOMRAIL_LANDING_TEST_PORT` (default 4177), чтобы не
  останавливать посторонний локальный сервер при совпадении порта; проверки выполнены на 4187.
- Не добавлены dependencies, внешние шрифты/CDN или аналитика; production CSP сохранён.
- Отдельный release blocker: main CI run `35442835671`, `Verify (windows-latest)` остановлен
  по лимиту 40 минут (GitHub annotation), остальные пять jobs успешны. npm staging environment
  не одобрен; это не ошибка лендинга и не основание обходить blocking release gate.

## Design

Сохраняется Loomrail palette, Geist и JetBrains Mono. Map / Diagram composition, N1b navigation и Ft5 footer;
native details вместо имитации live telemetry, простые списки вместо равномерной стены карточек.
Без вымышленных метрик, отзывов, записей продукта и library boilerplate marketplace.
