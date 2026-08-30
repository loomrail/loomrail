# D3 — план реализации публичного лендинга

**Статус:** completed

**Дата:** 2026-08-30

**Спецификация:** [`21-d3-landing-spec.ru.md`](21-d3-landing-spec.ru.md)

## Шаг 1. Зафиксировать публичный контракт

- повторно сверить позиционирование с текущими официальными страницами AO, Mission Control и amux;
- зафиксировать audience, copy, IA, визуальную систему и честные ограничения;
- обновить Hallmark preflight/rotation metadata.

**Gate:** ни один публичный claim не выходит за текущий checkpoint README.

## Шаг 2. Собрать независимый static workspace

- создать `apps/landing` на Vite + strict TypeScript;
- подключить self-hosted Space Grotesk, Inter и JetBrains Mono;
- реализовать Narrative Workflow, оба реальных Workbench screenshot и install path;
- добавить theme toggle, copy command и доступную command palette;
- покрыть copy/theme/palette и отсутствие внешних ресурсов unit-тестами.

**Gate:** `pnpm --filter @loomrail/landing build`, typecheck и tests зелёные.

## Шаг 3. Добавить publication boundary

- добавить GitHub Pages workflow с pinned action revisions и минимальными permissions;
- зафиксировать static-site delta в threat model;
- подключить landing browser globals в ESLint без ослабления общих правил.

**Gate:** локальный production artifact не содержит секретов, telemetry или внешних resource dependencies.

## Шаг 4. Провести UI quality gate

- выполнить Hallmark slop-test и pre-emit critique;
- проверить desktop и 320/375/414/768, light/dark, keyboard, reduced motion;
- проверить отсутствие horizontal overflow, читаемость и image loading semantics;
- сохранить временные screenshots только вне Git.

**Gate:** нет critical/major visual, accessibility или interaction defects.

## Шаг 5. Выпустить

- запустить `pnpm verify` и релевантный browser smoke;
- обновить status/checkpoint и README;
- сделать один Conventional Commit, push в `main`;
- включить GitHub Pages через workflow, дождаться deploy и проверить публичный URL.

**Gate:** `main` синхронизирован, CI/Pages зелёные, live URL возвращает актуальную страницу.

## Результат

- публичная страница: <https://loomrail.github.io/loomrail/>;
- static workspace: `apps/landing`;
- publication workflow: `.github/workflows/pages.yml`;
- Pages build/deploy: <https://github.com/loomrail/loomrail/actions/runs/33305350772>;
- локально пройдены `pnpm verify`, production browser smoke, light/dark и 320/375/414/768/1280/1440/1920 px;
- live smoke подтвердил отсутствие внешних resource requests, console errors и failed responses, а также работу
  command palette, theme toggle и copy state.
