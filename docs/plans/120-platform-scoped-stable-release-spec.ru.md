# Platform-scoped Stable — release spec

**Дата:** 2026-09-11

**Статус:** implemented; Stable `0.1.0` published for `MACOS_ARM64`

**Решение:** PD-033 / ADR-0032

## Цель

Выпустить первый Stable `0.1.0` для доказанного `darwin/arm64` local-provider продукта, не выдавая зелёный Windows CI
за живую Windows совместимость и не расширяя runtime admission.

## Контракт

Release eligibility определяется парой `Release Channel + Release Support Target`.

| Channel  | Version        | npm tag  | Support target | Required evidence |
| -------- | -------------- | -------- | -------------- | ----------------- |
| `BETA`   | `0.1.0-beta.N` | `next`   | `MACOS_ARM64`  | 9 macOS/product   |
| `STABLE` | plain semver   | `latest` | `MACOS_ARM64`  | 9 macOS/product   |

Windows rows остаются в manifest как `PENDING`; они не считаются passed и не входят в target первого Stable. Новый
target с Windows не добавляется в этом slice.

## Инварианты

- manifest schema хранит exact `stableReleaseVersion` и `stableReleaseTarget`;
- missing/unknown target, prerelease Stable, version drift и pending required gate блокируются;
- source/browser/clean-install CI остаётся обязательным на macOS и Windows;
- public docs/landing/compatibility называют только macOS Apple Silicon supported target;
- Windows/Linux provider dispatch остаётся fail closed;
- `STABLE` фиксированно публикуется в `latest` только через reviewed main-only OIDC stage и отдельное 2FA approval;
- Beta evidence не переписывается, Windows evidence не синтезируется.

## Проверка

1. Red/green verifier tests для schema/target/gate/version drift и macOS Stable 9/9.
2. Public-readiness tests не позволяют заявить Windows/Linux support.
3. Полный local `pnpm verify`, fault-injection, E2E, pack и clean-install.
4. Exact-source six-job CI и Pages.
5. Protected npm stage/2FA, registry `latest`, provenance/signatures и чистая registry-установка/start.
