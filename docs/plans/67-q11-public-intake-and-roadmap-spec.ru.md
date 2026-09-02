# Q11 — Public issue intake and roadmap

**Дата:** 2026-09-03

**Статус:** implemented locally; macOS/Windows evidence pending

**Предшественники:** R1, Q4, Q6, Q7, Q9, Q10

**Нормативные решения:** PD-003, PD-005, PD-007, AD-004, SD-001, T06, T13, T41, T44

## 1. Outcome

Внешний участник получает два понятных публичных маршрута: воспроизводимый bug report и bounded product proposal.
Template chooser отдельно уводит vulnerability reports в GitHub Private Vulnerability Reporting и не предлагает
пустой public issue. Корневой `ROADMAP.md` показывает Now/Next/Later без дат, обещаний или альтернативного product
authority.

Q11 закрывает Phase 8 deliverable `public issue templates/roadmap`, но не включает GitHub API, issue sync, voting,
automatic triage, SLA или runtime ingestion. `docs/product/PRODUCT-DECISIONS.ru.md` и master plan остаются
нормативными; roadmap — публичное краткое представление текущего порядка.

## 2. Public intake contract

`.github/ISSUE_TEMPLATE` содержит ровно:

- `bug.yml` — version/commit, OS, install route, provider route, current/expected behavior и воспроизводимые шаги;
- `feature.yml` — problem, desired outcome, bounded proposal, observable acceptance и security/privacy impact;
- `config.yml` — `blank_issues_enabled: false`, private security route и ссылка на public roadmap.

Forms не назначают label, project, assignee или severity автоматически: эти repository objects могут отсутствовать,
а public reporter не получает release/priority authority. Обязательные acknowledgement требуют поиска duplicate,
соблюдения Code of Conduct и подтверждения, что issue не содержит секретов, private repository content, raw
transcripts/logs, personal paths или unsanitized artifacts.

Security report никогда не предлагается как bug body. Canonical private route остаётся
`https://github.com/loomrail/loomrail/security/advisories/new` из `SECURITY.md`.

## 3. Public roadmap contract

`ROADMAP.md`:

- честно называет текущий pre-alpha status и отсутствие stable support promise;
- делит работу на `Now`, `Next`, `Later` и `Not planned before stable`;
- связывает Now с оставшимися проверяемыми stable gates, а не с календарным обещанием;
- не дублирует исторические implementation plans и не объявляет закрытыми private dogfood, live-provider,
  telemetry, security review или registry provenance;
- объясняет, что issue reactions и requests являются input, а не автоматическим приоритетом.

README, docs index и contributing guide ссылаются на roadmap и structured issue chooser.

## 4. Verification

Standard-library verifier проверяет exact community file set, regular/bounded files, top-level form fields, unique
IDs, exact required fields, private security route, выключенные blank issues, safety acknowledgements, roadmap
headings/links и отсутствие календарных обещаний. Policy tests доказывают valid tree и fail-closed mutations.

Prettier остаётся YAML syntax gate. Named CI step исполняет community verifier на macOS и Windows до общего lint,
чтобы protected landing failure не скрывал evidence.

## 5. Security delta

Public issue text — untrusted, permanently public input. T45 контролирует accidental disclosure и social-engineering
content: structured prompts, private vulnerability route, explicit public-data acknowledgement, no uploads/log
request, closed chooser и no runtime ingestion. Q11 не импортирует issue text в Loomrail и не запускает его.

## 6. Acceptance criteria

1. GitHub chooser предлагает actionable bug и product proposal forms, но не blank public issue.
2. Vulnerability reporter видит private advisory route до отправки public body.
3. Обе формы собирают минимально достаточный воспроизводимый/acceptance-oriented контекст без запроса secrets/logs.
4. Public roadmap отражает реальные remaining stable gates и не содержит дат или promises.
5. Closed verifier и mutation tests проходят локально, на macOS и Windows.
6. Q11 не меняет `apps/landing/**`, runtime state/API, provider adapters или npm publication state.

## 7. Non-goals

- GitHub OAuth/API, issue/PR/check sync или Projects automation;
- Discussions, support desk, maintainer SLA или public support guarantee;
- automatic labels, severity, prioritization, roadmap dates или voting;
- telemetry/crash upload;
- private dogfood, live-provider matrix promotion, trusted registry publish;
- обработка public issue как trusted prompt или provider context.

## 8. External format authority

Format соответствует актуальной GitHub documentation:

- [Configuring issue templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)
- [Syntax for issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
