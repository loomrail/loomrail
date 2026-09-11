# Platform-scoped Stable — implementation plan

**Дата:** 2026-09-11

**Статус:** active

**Спека:** [`120-platform-scoped-stable-release-spec.ru.md`](120-platform-scoped-stable-release-spec.ru.md)

1. Зафиксировать PD-033, ADR-0032, Release Support Target vocabulary и T85.
2. Red/green: расширить strict release manifest exact `stableReleaseTarget` и разрешить `STABLE + MACOS_ARM64` только
   при девяти required gates, не изменяя Windows row status.
3. Выбрать exact `0.1.0`, синхронизировать package/public docs/landing без Windows/Linux claim.
4. Выполнить focused/full local gates, commit/push и exact-source macOS/Windows CI + Pages.
5. Выполнить protected Stable staging, отдельное owner 2FA approval, registry/provenance/signature/clean-install smoke.
6. Опубликовать exact tag/GitHub release, записать sanitized evidence и вернуть чистый `main == origin/main`.

## Exit

- [ ] `STABLE + MACOS_ARM64` gate passed 9/9; Windows rows честно `PENDING`;
- [ ] `0.1.0` source/browser/package gates зелёные на macOS/Windows;
- [ ] npm `latest` указывает на verified `0.1.0`, `next` сохраняет опубликованную Beta;
- [ ] GitHub release и Pages опубликованы из exact source;
- [ ] Windows/Linux limitation видна публично и runtime fail closed;
- [ ] worktree чистый, `main == origin/main`, открытых PR нет.
