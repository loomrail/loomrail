# Post-Stable operational dogfood — спецификация

**Дата:** 2026-09-12

**Статус:** approved

**Основание:** PD-019, PD-021, PD-033; ADR-0015, ADR-0018, ADR-0032; T09, T40–T43, T49, T61–T62, T84–T85

## Цель

Проверить публичный `loomrail@latest` как новый пользователь на чистом macOS Apple Silicon profile, а не только как
локальный source/tarball candidate: установка из registry, setup/doctor, полный local-CLI workflow, restart, сохранение
данных, upgrade, restore-based rollback и раздельный uninstall package/data.

Эта работа не добавляет новую product capability и не меняет архитектурную границу. Поэтому новый PD/ADR не нужен:
источником workflow truth остаётся Loomrail domain, а model transport — только совместимый локально авторизованный
Codex CLI или Claude Code CLI. Exact новая provider version может получить compatibility row только после отдельного
bounded live evidence на том же `(version, platform, architecture)`; semver-наследование запрещено.

## Публичные seams проверки

1. **Registry/package seam:** `npm install --ignore-scripts loomrail@<exact>` и публичные package metadata,
   signatures/provenance.
2. **CLI diagnostics seam:** `setup --mode live --json`, `doctor --json`, `data-path`, start/stop и typed closed
   reports без raw output/path/credential leakage.
3. **Loopback application seam:** readiness endpoint, authenticated Workbench и canonical `/try` route.
4. **Workflow seam:** owner-controlled task creation, budgets, approvals, six stages, measured verification/Browser QA,
   Acceptance и restart recovery через production local CLI adapters.
5. **Lifecycle seam:** whole-directory backup, forward upgrade, restore of the matching pre-upgrade backup and package
   uninstall that leaves owner data untouched.

## In scope

- отдельные temporary roots с пробелами, кириллицей и другим Unicode для install, data и workspace;
- exact public `0.1.0-beta.1 -> 0.1.0` upgrade rehearsal с сохранением durable state, даже если между версиями нет
  новой migration;
- restore-based rollback без открытия уже обновлённой state старым binary;
- package uninstall с доказательством, что Loomrail data остаётся на месте;
- full newcomer fixture workflow через provider, который `doctor` реально допускает;
- точная проверка текущего Codex CLI drift. Новый Codex row допускается только после read-only, bounded workspace/MCP,
  failure и full workflow evidence; до этого AUTO обязан использовать другой ready provider или честно блокироваться;
- restart в середине незавершённого workflow без automatic replay;
- bounded sanitized evidence, не содержащий bootstrap URL, cookies, CSRF, provider payload, transcript, `.env`, token,
  credential или абсолютный personal path.

## Out of scope

- Windows/Linux live-provider promotion;
- direct OpenAI/Anthropic API, API keys, Mock или synthetic success;
- login/update/install provider CLI силами Loomrail;
- автоматический commit, push, merge, deploy или публикация из Loomrail workflow;
- down-migration, online portable export/import, recursive cleanup и удаление внешнего repository;
- новая npm version без отдельного exact release candidate, полного gate и owner-controlled trusted publication.

## Инварианты безопасности

- test harness принимает только exact registry versions и создаёт собственные roots; default user data directory не
  используется;
- каждый destructive cleanup ограничен созданным harness root, сначала проверяет identity и выполняется recoverable
  способом в ручном dogfood;
- bootstrap/session secrets остаются только в памяти процесса и не входят в evidence;
- provider output остаётся недоверенным; completion подтверждается только durable workspace call, verification, QA и
  Acceptance lineage;
- upgrade выполняется только после stopped whole-directory backup; rollback использует восстановленную копию этого
  backup, а не down-migration;
- package uninstall и data removal остаются двумя разными owner actions;
- непроверенная provider version остаётся `UNVERIFIED` и не получает dispatch authority.

## Acceptance

- один повторяемый maintainer gate проверяет registry install, diagnostics, start/stop, state preservation,
  upgrade/restore/uninstall и leak canaries на temporary Unicode/space paths;
- публичный full workflow заканчивается owner `ACCEPTED`, а не provider prose;
- restart не создаёт duplicate call/session и не replay-ит оборванную action;
- текущая compatibility matrix честно отражает фактически установленные версии;
- все найденные defects имеют typed regression test до исправления;
- `pnpm verify`, product E2E, release-package gate и public-registry operational gate зелёные;
- sanitized evidence фиксирует факты и открытые ограничения без изменения `MACOS_ARM64` support target.
