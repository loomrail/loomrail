# B5 + B1 — онбординг существующего репозитория и пресеты Project Constitution

**Статус:** implemented

**Дата:** 2026-08-30

**Зависимости:** E1, E1.5; нормативные решения RD-001, RD-002, AD-003, PD-007

## 1. Задача

После E1 владелец может зарегистрировать настоящий Git-репозиторий и выполнять в отдельном worktree задачи,
но Loomrail ещё ничего не знает о правилах этого проекта. B5 добавляет безопасный scan → review → approve маршрут,
а B1 даёт сканеру небольшой versioned catalog готовых guardrail-пресетов.

Результат вехи — не «набор советов от модели», а две разные сущности:

- `ConstitutionProposal` — неизменяемый, проверяемый draft, полученный из ограниченного скана и выбранного пресета;
- `ProjectConstitutionVersion` — версия правил, которую владелец явно активировал и которая опубликована в
  `.loomrail/constitution.md`.

Скан и proposal никогда не становятся authority автоматически. Ни provider session, ни текст репозитория, ни
рекомендованный пресет не могут активировать правила вместо владельца.

## 2. Ubiquitous language

- **Repository Scan** — ограниченное наблюдение известных файлов и структуры зарегистрированного репозитория.
  Это данные, а не инструкции и не разрешение выполнить найденную команду.
- **Constitution Preset** — встроенный versioned baseline доверенных Loomrail guardrails. Он не устанавливает
  зависимости и не меняет стек проекта.
- **Constitution Proposal** — immutable draft с section bodies, provenance, warning и точным snapshot скана.
- **Project Constitution Version** — immutable approved rules одной версии Project.
- **Constitution Publication** — durable compare-and-set запись утверждённой версии в
  `.loomrail/constitution.md`; только её успешное завершение делает версию активной.

## 3. Принятые решения

### D1 — Scanner наблюдает, domain решает

Filesystem scanner живёт за одним глубоким модулем и возвращает runtime-validated `RepositoryScan`. Чистая функция
строит proposal из scan + preset. Доменная команда отдельно проверяет project/version/status и только после owner
approval создаёт publication. Код сканера не импортирует persistence и не может менять Project.

### D2 — Allowlist вместо обхода репозитория

Scanner не читает source tree рекурсивно. Он рассматривает только:

- `AGENTS.md`, `CLAUDE.md`, `README*`, существующий `.loomrail/constitution.md`;
- package/workspace manifests и признаки package manager (`package.json`, `pnpm-workspace.yaml`, lockfile name);
- известные TypeScript, lint, format и test config filenames;
- имена workflow в `.github/workflows/`;
- Markdown в `docs/architecture/`, `docs/adr/` и `docs/decisions/` глубиной не более двух каталогов.

Границы: не более 128 кандидатов, 512 KiB на один читаемый файл и 2 MiB суммарно. Symlink-файл не читается;
symlink-каталог не обходится; canonical root повторно проверяется как top-level зарегистрированного Git repository.
Секретные `.env*`, исходники, содержимое lockfile и произвольный executable config не читаются. Никакая найденная
команда не исполняется.

Обрезка, malformed manifest, symlink и unreadable file становятся typed warnings. «Ничего не найдено» отличается
от «не смогли прочитать».

### D3 — Preset catalog маленький, встроенный и versioned

В B1 входят три пресета:

1. `repository-baseline@1` — language-agnostic ownership, security, review и verification guardrails;
2. `typescript-node@1` — baseline плюс strict TypeScript/module/test expectations;
3. `typescript-pnpm-workspace@1` — TypeScript preset плюс workspace boundaries и root-command discipline.

Самый специфичный применимый preset рекомендуется детерминированно. Владелец может выбрать другой до скана.
Новый preset или новая версия — изменение catalog data и контрактных тестов, не скрытая смена уже утверждённой
Constitution. B1 не выбирает hosting/database/billing stack и не scaffolds файлы — это B4.

### D4 — Proposal объясняет каждый вывод

Каждая из семи секций MASTER-PLAN §8.1 присутствует всегда:

1. Product Context;
2. Architecture;
3. Code Standards;
4. Agent Policies;
5. Definition of Done;
6. Role Playbooks;
7. Learned Conventions.

Section хранит Markdown body и `sources`: trusted preset rule, repository path или scanner observation. Репозиторий
не цитируется как authority: найденные `AGENTS.md`/`CLAUDE.md` становятся ссылками для review, а не автоматически
активированными policy. Commands берутся только из строковых `package.json.scripts`, показываются как untrusted
discovered commands и не запускаются.

### D5 — Approval публикуется через durable follow-up

Owner command `REQUEST_PROJECT_CONSTITUTION_ADOPTION` в одной SQLite transaction:

1. проверяет `expectedProjectVersion`, proposal status/version и digest его scan;
2. создаёт immutable `ProjectConstitutionVersion` в `PUBLISHING`;
3. создаёт `ConstitutionPublication` в `PENDING` с expected digest текущего target file;
4. пишет audit Event и command receipt.

После commit daemon выполняет publication. Успешная atomic replace приводит к system command
`COMPLETE_PROJECT_CONSTITUTION_PUBLICATION`, которая в одной transaction переводит новую версию в `ACTIVE`, прежнюю
в `SUPERSEDED`, proposal в `ADOPTED`, publication в `APPLIED` и пишет Event. Crash между файловой записью и второй
командой безопасен: повторная запись того же content digest идемпотентна, а pending publication поднимается при
restart.

Ошибка публикации фиксируется typed состоянием `FAILED` и Event; owner может retry. Активная предыдущая версия при
этом не меняется.

### D6 — Existing file заменяется только compare-and-set

Scan фиксирует `null` либо SHA-256 существующего `.loomrail/constitution.md`. Publication записывает файл только
если target всё ещё имеет этот digest. Появление, удаление или изменение файла после review даёт
`CONSTITUTION_TARGET_CHANGED`; содержимое не перезаписывается. UI явно различает create и replace.

Parent `.loomrail/` не может быть symlink за пределы repository. Запись идёт во временный файл в том же каталоге,
затем atomic rename. Никаких других файлов и Git операций publication не выполняет.

### D7 — SQLite хранит operational truth, repo file — portable projection

Активная версия, proposal, publication status и audit живут в SQLite. `.loomrail/constitution.md` — Git-friendly
проекция точной активной версии. Run snapshot integration остаётся отдельной будущей работой: B5+B1 не меняет
context assembly существующих PipelineRun и не обещает policy precedence editor раньше полного Constitution phase.

## 4. Контракты и HTTP

- `GET /api/v1/constitution-presets` — versioned catalog без repository data;
- `GET /api/v1/projects/:projectId/constitution` — active version, latest proposal и publication state;
- `POST /api/v1/projects/:projectId/constitution/scan` — owner mutation с `commandId`, optional `presetId`;
- `POST /api/v1/projects/:projectId/constitution/adopt` — owner mutation с proposal/version/project optimistic guards;
- `POST /api/v1/projects/:projectId/constitution/publication/retry` — owner retry только для `FAILED` publication.

Все mutation routes используют существующие session/Origin/CSRF/content-type gates. Responses проходят Zod.
Repository path не приходит от клиента: daemon читает его из Project, поэтому route не расширяет filesystem scope.

## 5. UI

Settings → Projects показывает для выбранного Project раздел **Project Constitution**:

- active version или честное «ещё не активирована»;
- Auto-detect и три preset choices;
- `Scan repository`;
- review семи sections, provenance и warnings;
- `Approve and create` либо `Approve and replace`;
- `Retry publication` при failed state.

Клавиатура и visible focus обязательны. Warning и status имеют текст, не только цвет. Light/dark — равные acceptance
targets. Raw JSON и полный текст импортированных instruction files в основном опыте не показываются.

## 6. Security delta

Новая угроза T24: malicious repository пытается заставить scanner выйти из root, исчерпать память, выполнить config
или незаметно заменить approved target. Controls: canonical repository check, allowlist, symlink refusal, byte/file
bounds, data-only parsing, no execution, compare-and-set digest, atomic same-directory rename, owner approval,
authenticated mutations. Critical/High verification входит в эту веху.

## 7. Non-goals

- LLM extraction, grill-вопросы и automatic learned-convention promotion;
- full Constitution editor и conflict-resolution HumanRequest;
- run-time policy precedence/snapshot integration;
- scanning source files, dependencies or `.env` values;
- установка пакетов, изменение stack, scaffolding, shell/test execution;
- automatic first dry run, B2/B3 checks, B4 new-project flow;
- Git add/commit/push для `.loomrail/constitution.md`.

## 8. Acceptance

B5+B1 завершены, когда:

1. generic, TypeScript и pnpm workspace fixtures получают детерминированный рекомендуемый preset и proposal;
2. symlink escape, oversized/malformed input и `.env` canary не читаются и не попадают в state/log/error;
3. scan, adoption, complete/fail/retry commands идемпотентны и reject stale/forbidden transitions;
4. state + Event + publication follow-up атомарны; reopen поднимает pending publication;
5. target changed after scan is preserved and produces typed failed state;
6. approved version оказывается ровно в `.loomrail/constitution.md`, становится ACTIVE и переживает restart;
7. UI проходит light/dark, keyboard, empty/proposed/publishing/active/failed states;
8. threat model, domain glossary и decomposition checkpoint обновлены;
9. `pnpm verify` и production audit зелёные.
