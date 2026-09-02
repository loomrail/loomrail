# Q10 — Bundled sample repositories, workflow recipes and roles

**Дата:** 2026-09-02

**Статус:** implemented locally; macOS/Windows evidence pending

**Предшественники:** D2, B1–B5, A3, R1, Q6, Q8

**Нормативные решения:** PD-002, PD-003, PD-005, PD-007, AD-004, SD-001, T06, T13, T32

## 1. Outcome

Два встроенных demo Project перестают быть пустыми Phase 0 placeholders и становятся небольшими, исполняемыми,
dependency-free sample repositories. Каждый sample содержит проверяемый baseline и несколько готовых Task recipes,
которые проходят через уже существующий deterministic workflow и его versioned roles. Публичный EN/RU catalog
объясняет, что именно демонстрирует каждый маршрут и где остаётся owner authority.

Q10 не добавляет второй workflow engine, custom role editor или автоматический запуск sample application. Он делает
существующие repository/workflow/role primitives воспроизводимыми и честно документированными, не расширяя их
authority.

## 2. Sample repository contract

Allowlisted `web-app-a` и `api-service-b` остаются единственными fixture IDs. После materialisation каждый является
обычным отдельным Git repository с первым commit и содержит:

- `package.json` с `private: true`, ESM и единственным обязательным verification command `node --test`;
- небольшой baseline только на Node.js standard library, без install step, network dependency, build tool и
  lifecycle scripts;
- `src/` и `test/` с хотя бы одним проходящим тестом;
- `SAMPLE-WORKFLOWS.md` с exact title, brief и acceptance criteria для двух bounded tasks;
- существующий strict `loomrail-fixture.json` только с identity полями.

Шаблон не содержит `.git`, symbolic links, credentials, absolute paths, generated assets или executable hooks.
Loomrail копирует файлы и создаёт repository как раньше, но никогда сам не запускает sample command. Команда запуска
остаётся owner/provider action в отдельном materialised repository или worktree.

## 3. Samples

### `web-app-a`

Минимальный server-rendered task list на loopback-capable Node HTTP server. Baseline отделяет pure rendering/model от
process entrypoint, чтобы тесты не открывали порт. Recipes:

1. добавить фильтр completed/open с сохранением текущего поведения;
2. добавить доступное empty-state сообщение и focused tests.

Browser QA не получает скрытый application launcher. Исторический built-in Mock QA по-прежнему проверяет только
публичную readiness surface Loomrail; для измерения самого sample owner явно запускает его и коммитит обычный
`.loomrail/browser-qa.json` по публичному гайду.

### `api-service-b`

Минимальный in-memory issue service с pure request handler contract. Recipes:

1. добавить severity filter без изменения default response;
2. валидировать create payload и возвращать typed HTTP-style error result.

Тесты не слушают порт и не делают outbound network calls.

## 4. Workflow and role catalog

Публичный catalog фиксирует единственный shipped delivery workflow:

```text
Discovery → Plan → Implement → Review → QA → Acceptance
```

Это versioned `mock-delivery-v1` revision 4, несмотря на историческое имя: Mock и live adapters исполняют одну
domain-owned последовательность. Catalog не обещает runtime workflow selection.

Stage assignment использует существующие versioned profiles Product Analyst, Software Architect, Developer, Code
Reviewer и Browser QA. Lead PM и Acceptance Manager входят в built-in profile catalog, но текущий standard squad их
не dispatch-ит; Acceptance Package собирает deterministic domain path, а owner остаётся единственным субъектом final
Accept/Return/Reject. Sample recipes не подменяют profiles provider prompts и не меняют их budgets/capabilities.

## 5. Verification

Один standard-library verifier:

1. находит exact два allowlisted sample directories;
2. валидирует closed identity и sample metadata, portable relative paths и отсутствие unexpected symlink;
3. проверяет private dependency-free manifest без lifecycle/network/install commands;
4. запускает `node --test` в каждом source template;
5. проверяет те же файлы и тесты в staged/installed release tree.

CI запускает named sample gate отдельно на macOS и Windows до repository-wide lint, чтобы protected landing failure не
скрывал evidence. Clean-install release gate повторяет проверку из package tarball.

## 6. Security delta

Sample source — provider-readable repository input и потенциальный supply-chain vector. Q10 сохраняет T06/T13/T32
controls и добавляет fail-closed проверку: exact catalog, regular files/directories only, no links, no dependencies,
no lifecycle scripts, bounded files, no secret/path canaries и no implicit execution. Release receipt продолжает
хешировать каждый packed sample file.

## 7. Acceptance criteria

1. Оба built-in Project материализуются как отдельные Git repositories и проходят `node --test` без установки.
2. Каждый repository содержит два exact workflow recipes с observable acceptance criteria.
3. EN/RU catalog описывает shipped workflow revision, stage-role mapping и owner Acceptance boundary.
4. Source и clean-package sample verifier зелёный на macOS и Windows.
5. Existing registration idempotency, symlink refusal, project isolation и Mock full route не регрессируют.
6. Q10 не меняет `apps/landing/**`, provider compatibility, workflow state schema или npm publication state.

## 8. Non-goals

- custom workflow/role CRUD или marketplace;
- automatic sample server/process management;
- automatic Browser QA target discovery;
- dependency installation или external network fixtures;
- real-provider execution, dogfood claim, registry publish/provenance;
- замена отдельного D2 quota-bearing full-route example.
