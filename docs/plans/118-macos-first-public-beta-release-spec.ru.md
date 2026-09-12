# Public Beta — macOS-first trusted release spec

**Дата:** 2026-09-11

**Статус:** implemented; Public Beta published as `0.1.0-beta.1`

**Решение:** PD-032 / ADR-0031

## Цель

Опубликовать первый честный Public Beta для доказанной `darwin/arm64` local-CLI границы, не выдавая synthetic Windows
CI за живую совместимость Codex/Claude и не ослабляя будущий Stable release.

## Release contract

`Release Channel` — closed union `BETA | STABLE`.

| Channel  | Version             | npm tag  | Evidence gate                                                        |
| -------- | ------------------- | -------- | -------------------------------------------------------------------- |
| `BETA`   | `0.1.0-beta.N`      | `next`   | девять non-Windows rows; Windows rows остаются честно видимыми       |
| `STABLE` | plain stable semver | `latest` | все одиннадцать rows, включая Codex/Claude live execution на Windows |

Оба канала требуют exact package/main SHA/confirmation, unused registry version, шесть зелёных macOS/Windows CI jobs,
protected main-only `npm-release` Environment, OIDC trusted publisher, stage-only publish и отдельное npm 2FA
approval. Caller не передаёт dist-tag, publish argv или executable.

## Beta boundary

- live provider support заявляется только для exact verified Codex/Claude versions на `darwin/arm64`;
- Windows/Linux installation может пройти, но unverified live provider dispatch обязан fail closed;
- публичные README, landing, guides, compatibility matrix и release notes называют эту границу одинаково;
- Mock, direct APIs, token-based local publish, hidden fallback и synthetic pass запрещены;
- `latest` не изменяется;
- historical pre-alpha остаётся доступна по exact version, а `next` переходит на Beta только после registry
  verification.

## Verification

1. Parser отклоняет unknown channel, неправильную version shape, SHA/ref/package drift и неточное confirmation.
2. Beta verifier требует exact selected Beta version и все девять allowed gates; Windows pending не считается pass.
3. Stable verifier продолжает требовать exact selected Stable version и 11/11.
4. Workflow содержит только два fixed stage commands: Beta → `next`, Stable → `latest`; raw `npm publish`, token secret
   и caller-supplied tag отсутствуют.
5. Source, Browser smoke, release tarball/clean install, fault recovery, public-tree and privacy gates проходят.
6. После staging владелец проверяет candidate/receipt, выполняет npm 2FA approval, затем проверяются registry bytes,
   provenance/signatures, clean install/start и публичный Pages surface.

## Не входит

- Windows live-provider claim;
- Stable/`latest` publication;
- desktop installer, auto-update или remote runtime;
- live Recurkit deploy, SMTP или платный provider API.
