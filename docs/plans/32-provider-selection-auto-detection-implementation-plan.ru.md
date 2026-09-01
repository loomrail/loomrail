# План реализации Provider Selection

**Основание:** [`31-provider-selection-auto-detection-spec.ru.md`](31-provider-selection-auto-detection-spec.ru.md)

1. Добавить contracts для `ProviderPreference`, availability/status response, versioned command/result и Project Event.
2. Добавить deterministic domain decision выбора preference и проверки no-op/version conflict.
3. Миграцией добавить `projects.provider_preference` с default `AUTO` и расширить closed `events.type`.
4. Сохранить Project, Event и command receipt одной транзакцией; покрыть replay/restart/conflict.
5. Превратить daemon provider selection в registry с bounded auth probes и immutable availability snapshot.
6. Научить worker выбирать adapter per Project и abort-ить live session через захваченный экземпляр.
7. Добавить authenticated project selection/refresh routes и сохранить старую capabilities route как совместимую
   проекцию effective selection.
8. Добавить Project Settings selector, availability/recovery copy RU/EN и query invalidation.
9. Проверить domain, persistence, daemon integration, E2E, keyboard, light/dark и security canary; затем перейти к C1.
