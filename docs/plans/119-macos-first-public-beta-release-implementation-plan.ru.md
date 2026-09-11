# Public Beta — macOS-first implementation plan

**Дата:** 2026-09-11

**Статус:** completed

**Спека:** [`118-macos-first-public-beta-release-spec.ru.md`](118-macos-first-public-beta-release-spec.ru.md)

1. Зафиксировать PD-032, ADR-0031, Release Channel vocabulary, T84 и Master Plan boundary.
2. Red/green: расширить release manifest до separate exact Beta/Stable selections и добавить 9/9 Beta verifier, не
   меняя 11/11 Stable semantics.
3. Red/green: расширить typed stage intent закрытым `BETA | STABLE`, fixed confirmation и fixed `next | latest`.
4. Обновить один trusted stage workflow без caller-supplied tag, token secret или direct publish.
5. Выбрать `0.1.0-beta.1`, обновить public EN/RU docs, landing и release notes с `darwin/arm64` boundary.
6. Выполнить local focused/full gates, commit/push и получить exact macOS/Windows CI + Pages evidence.
7. Зафиксировать immutable Beta evidence/digest, повторить exact-HEAD CI и создать main-only reviewed
   `npm-release` Environment.
8. Настроить exact npm trusted publisher, stage candidate, пройти owner 2FA approval и проверить registry,
   provenance/signatures, clean install/start, Pages и GitHub prerelease.

## Exit

- [x] Beta 9/9, Stable честно 9/11;
- [x] `0.1.0-beta.1` source/browser/package gates зелёные на macOS/Windows;
- [x] npm `next` указывает на verified `0.1.0-beta.1`, `latest` не изменён;
- [x] GitHub prerelease и Pages опубликованы из exact source;
- [x] Windows/Linux live-provider limitation видна публично;
- [x] после evidence commit worktree чистый, `main == origin/main`, открытых PR нет.
