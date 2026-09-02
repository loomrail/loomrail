# Q6 — План реализации release integrity и supply-chain policy

**Дата:** 2026-09-02

**Статус:** implementation complete locally; clean macOS/Windows CI receipt evidence pending

**Спецификация:**
[57-q6-release-integrity-and-supply-chain-spec.ru.md](57-q6-release-integrity-and-supply-chain-spec.ru.md)

## 1. Порядок работы

### Q6.1 — Deep integrity module

- [x] Добавить standard-library module с closed receipt schema, safe package path policy и digest verification.
- [x] Покрыть valid receipt, unsafe/duplicate/unknown metadata, tarball tamper и installed-file tamper.
- [x] Перевести pack на `npm pack --json`, exact metadata validation и receipt generation.
- [x] Проверять receipt до clean install и exact installed package files после install.

### Q6.2 — Supply-chain enforcement

- [x] Явно включить strict release age, missing-time refusal, no-downgrade trust, untrusted lockfile recheck,
      exotic-transitive block и strict dependency build-script review.
- [x] Доказать, что frozen install и production audit проходят с текущим lock graph без broad exception.
- [x] Добавить integrity unit gate в обычный repository test path и clean receipt requirement в CI release lane.

### Q6.3 — Policy, threat model and operations

- [x] Добавить EN/RU supply-chain policy с dependency triage, exact exception и trusted-publish contract.
- [x] Обновить release и EN/RU operations guide: receipt vs provenance, post-publish verification, update/rollback.
- [x] Добавить T41 release substitution/false-provenance delta и domain vocabulary.
- [x] Обновить Master Plan, decomposition и Phase 8 evidence без claim о completed registry provenance.

## 2. Verification gate

- [x] Integrity unit tests зелёные и mutation-negative cases доказаны.
- [x] `pnpm install --frozen-lockfile` проходит с усиленной supply-chain policy.
- [x] Focused non-landing lint/typecheck и production audit зелёные.
- [x] `pnpm pack:release && pnpm test:release` выдаёт и проверяет clean/dirty receipt локально.
- [x] `pnpm test:fault-injection` остаётся зелёным.
- [ ] macOS/Windows CI release receipt + clean-install gate зелёный; общий verify может оставаться blocked только
      protected landing.

## 3. Release boundary

Q6 может закрыть dependency/supply-chain policy и локальную/CI integrity часть package provenance. Registry
provenance остаётся открытым до явно разрешённой публикации через настроенный npm trusted publisher. Этот план не
авторизует publish, tag, GitHub Release, dist-tag mutation или изменение `apps/landing/**`.
