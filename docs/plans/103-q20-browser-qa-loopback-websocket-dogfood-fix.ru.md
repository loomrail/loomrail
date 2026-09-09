# Q20.8 — Browser QA loopback WebSocket compatibility: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Архитектурная граница:** Browser QA остаётся read-only daemon-owned evaluator. Локальная compatibility-настройка
Chromium не является разрешением на сеть: до первой target navigation драйвер отдельно перехватывает HTTP и
WebSocket, разрешает только exact loopback origin, отбрасывает все client frames и ограничивает server frames.

## Причина

Private Recurkit dogfood прошёл Project verification и independent review, но повторный Browser QA на здоровом
Next.js development target завершился `TIMEOUT`. HTTP interception через `route.fetch/fulfill` активировал Chromium
Local Network Access check для HMR WebSocket. Статическая разметка была видна, но hydration не прикрепила обработчики:
первый CLICK формально находил кнопку, а следующий locator ожидал несуществующее состояние до timeout.

## Реализация и проверки

1. Зафиксировать boundary в ADR-0020, Product Decisions и T69.
2. Добавить catch-all WebSocket policy до target navigation и узкий Chromium compatibility flag.
3. Разрешать только exact same-origin loopback handshake; не пересылать page-to-server frames.
4. Ограничить sockets, server messages, размер одного сообщения и aggregate bytes; fail closed без evidence.
5. После bounded `load` дать already-loaded framework короткое interaction-settle окно внутри navigation deadline;
   не ждать бесконечного `networkidle` у polling/dev runtimes.
6. Интеграционно доказать hydrated same-origin flow, отсутствие client-frame delivery, limits и off-origin refusal.
7. Повторить Recurkit Browser QA, provider QA synthesis и Acceptance на точном verified/reviewed tree.
8. Выполнить полный `pnpm verify`, E2E и release-package verification перед handoff.

## Non-goals

Authenticated browser sessions, произвольные WebSocket protocols, bidirectional application sockets, provider-owned
QA verdict, обход exact-origin policy, synthetic pass или ослабление response/evidence limits.
