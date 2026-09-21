# Готовность репозитория и следующий patch release

**Дата:** 2026-09-19

**Статус:** 0.1.3 опубликован 2026-09-20 после exact-source CI, protected staging и отдельного owner WebAuthn;
публичная установка, подписи, происхождение, обновление и восстановление проверены.

Итог: [Stable 0.1.3 release evidence](../evidence/phase-8/STABLE-0.1.3-RELEASE-EVIDENCE.md).
Наблюдения локальной подготовки ниже сохранены как история, а не текущий publication status.

## Scope

Синхронизировать checkout с main, исправить воспроизводимый provider-selection gate, актуализировать публичный
roadmap и подготовить patch `0.1.3`. Старый `0.1.2` — отдельный staged artifact, не текущие исходники и не
опубликованная версия. Явное разрешение владельца на commit/push, настройки GitHub и выпуск получено 2026-09-19;
оно не отменяет проверки и отдельное npm 2FA.

Code-blind orchestrator пока исследуется отдельно: этот patch не добавляет новый workflow, модель, provider API
или квотный запуск. Источники и предлагаемый evaluation contract — в
[исследовании](../research/code-blind-orchestrator-primary-sources.ru.md).

## Дефект и проверка

На `bfa6e7577982a42e39475d9c344874a28825b261` два startup integration tests зависели от реальных CLI хоста.
Детерминированные наблюдения отдельно подтвердили: AUTO корректно выбирает ready Claude, но неизвестный
`LOOMRAIL_PROVIDER` тоже мог выбрать ready adapter с `start: true`, вопреки предупреждению daemon и ADR-0015.

Исправление сохраняет реальные runtime availability facts, но неизвестный override возвращает только blocked
Codex projection и `start: false` для существующего domain dispatch gate. Нет нового fallback, изменения
permissions, миграции или расширения support matrix. T26 получает regression coverage.

Матрица: ни одного ready CLI; один Codex; один Claude; оба; явный unavailable Codex; unknown override при каждом
состоянии readiness; все шесть stages; Project preference и avoid-provider не обходят блокировку.
Тестовые probes и adapters не запускают реальные provider sessions и не зависят от авторизации разработчика.

## Exit gates

- Focused daemon/domain regressions, затем полный `pnpm verify`.
- Production dependency audit, fault recovery, product E2E, package build/clean install.
- Отдельно различать локальные проверки и exact-source macOS/Windows CI.
- Stable target остаётся `MACOS_ARM64`; Windows/Linux live execution не допущен.
- Новая установленная версия CLI не наследует старое compatibility evidence.
- Только после разрешения: clean commit, GitHub CI, protected stage-only release, отдельное npm 2FA,
  registry integrity/install check и GitHub Release. Никакого обхода approval gate.

## Recovery

Provider fix не меняет schema. В общий кандидат входят ранее слитые activity changes и migration 0062;
обновление/откат сохраняют stopped whole-directory backup contract. Исторические release receipts и evidence
не переписываются. Orchestrator исследование не становится production authority.

## Зафиксированные наблюдения

- Checkout fast-forwarded до `bfa6e7577982a42e39475d9c344874a28825b261`, до работы clean. Шесть jobs
  [main CI 34991978682](https://github.com/loomrail/loomrail/actions/runs/34991978682) прошли для этого SHA,
  а не для ещё незафиксированных изменений этого плана.
- Исходный startup suite: 6 passed / 2 failed. После изоляции runtime probes: 12 passed / 2 failed;
  два failure отдельно воспроизводят unknown override при ready Claude и при двух ready CLI.
  После production fix и расширения матрицы: startup/settings 19/19 passed; все шесть stages заблокированы
  через реальный `decideDispatchStage` при unknown override.
- Production dependency audit: no known vulnerabilities. Protected landing E2E: 7/7, включая locales,
  light/dark, keyboard skip target и узкие viewports; landing source не менялся.
- Product E2E: 67/67 passed, включая сохранение IMPLEMENT activity после перехода на REVIEW.
- Первый общий verify прошёл все 366 daemon tests, но остановился на CLI version regression после bump:
  manifest `0.1.3`, внутренний constant `0.1.2`. Constant исправлен, focused version test зелёный; общий verify
  повторно прошёл полностью: formatting, public readiness, build, lint, typecheck и все package tests, включая
  366 daemon и 33 CLI tests. Clean-install gate усилен authenticated runtime-version check: старый bundle честно failed,
  после пересборки `0.1.3` полный clean-install gate passed, consumer audit — 0 vulnerabilities.
- Отдельный `verify-crash-recovery.mjs` passed: один interrupted run, no replay, один durable report.
  Отдельный полный `pnpm test:fault-injection` после зелёного общего verify тоже passed: все восемь package suites,
  повторные 366 daemon tests и process crash drill.
- Tarball и receipt локального кандидата сформированы из DIRTY checkout. Это проверка установки, не clean
  release receipt или registry provenance; после commit нужен новый exact-source artifact и CI.
- Read-only readiness на проверяемом macOS arm64: Claude Code `2.1.260` — VERIFIED / AUTHENTICATED / ready;
  Codex `0.155.0-alpha.9` — UNVERIFIED / not ready. Auth Codex не проверяется до admission; UNKNOWN не означает
  отсутствие login. Новая версия не допущена и live qualification не запускалась без отдельного бюджета.
- Public npm на момент проверки: `latest = 0.1.1`, `next = 0.1.0-beta.1`. Новый кандидат пока не staged/published.
- Read-only `npm whoami` вернул E401: текущая локальная npm-auth сессия недействительна. Это не мешает публичной
  установке или отдельному GitHub OIDC staging, но owner approval старого/нового stage требует действующего входа
  и отдельного npm 2FA. Login, account settings, approve/reject и publication в этой локальной подготовке не выполнялись.
- GitHub repository description/homepage пусты, main branch protection отсутствует; protected `npm-release`
  environment — отдельный существующий publication gate. Изменения настроек GitHub ещё не выполнены.

Наблюдения выше относятся к завершению локальной подготовки до разрешения на выпуск. После разрешения начат
owner npm web login; commits, push, GitHub settings, staging и публикация ещё предстоят.
Исторические Stable 9/9 не заменяют новые exact-source проверки; два Windows live-provider gates остаются PENDING.
Прежний локальный artifact `0.1.2` сохранён отдельно вне Git до пересборки нового кандидата.
