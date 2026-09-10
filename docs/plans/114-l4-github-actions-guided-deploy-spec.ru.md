# L4a — owner-approved GitHub Actions Guided Deploy

**Дата:** 2026-09-10
**Статус:** утверждено к реализации
**Основание:** PD-030, ADR-0029, L-track D3/D4/D7/D9/D10, L3 Release evidence

## 1. Outcome

Authenticated owner может связать неизменяемый L3 Release с одним repository-owned GitHub Actions workflow,
увидеть точную цель, подтвердить одну попытку и затем наблюдать exact run. Loomrail не получает deploy secrets, не
исполняет SSH/VPS-команды и не выдаёт provider deploy capability.

## 2. Архитектурная граница

Домен владеет `DeploymentPlan`, `DeploymentApproval`, `Deployment`, переходами, eligibility и audit intents. Он не
читает Git, filesystem, GitHub или process output. Один daemon-owned `DeploymentDriver` получает нормализованные
идентичности и возвращает только typed outcomes. Единственный production adapter v1 инкапсулирует GitHub CLI;
никакой GitHub payload не пересекает adapter boundary.

HTTP и React не вычисляют разрешение или terminal state. Provider adapters не импортируют L4 и не получают L4
mutation tools.

## 3. Встроенный пресет

`GITHUB_ACTIONS_WORKFLOW_V1`, revision 1:

- host: только `github.com`;
- remote: только credential-free HTTPS/SSH GitHub remote;
- workflow: только `.github/workflows/deploy-production.yml`;
- trigger: явный top-level `workflow_dispatch`; неоднозначный YAML fail-closed;
- ref: текущая именованная branch, уже указывающая на тот же commit в `origin`;
- inputs: отсутствуют;
- executable: локальный `gh` через argv без shell;
- dispatch deadline: 30 секунд; output: не более 32 KiB;
- observe deadline: 15 секунд; output: не более 64 KiB;
- rollback: `UNAVAILABLE` в revision 1.

План хранит только portable repository slug, branch, commit, workflow path/hash и закрытые budgets. Абсолютный path,
remote URL, CLI output и auth material в domain state не входят.

## 4. Два owner confirmations

1. `ADOPT_DEPLOYMENT_PLAN`: owner принимает exact repository/workflow/branch/commit preview, связанный с Release и
   Environment.
2. `APPROVE_DEPLOYMENT`: owner создаёт одноразовый Approval для exact approval digest. Одной транзакцией Deployment
   становится `APPROVED`; runner перед side effect транзакционно переводит его в `RUNNING`.

Approval digest покрывает:

`releaseContentHash | environmentId | environmentContentHash | planRevision | planContentHash | repositorySlug |
branch | commit | workflowPath | workflowContentHash | argvDigest | intent`.

Любое изменение создаёт новый Plan/Deployment и требует нового подтверждения.

## 5. Eligibility

- actor обоих подтверждений — HUMAN;
- Project и Release существуют и совпадают;
- Release freshness — `CURRENT`;
- все обязательные Release gates — `PASSED` (waiver/hotfix добавляются отдельным L4b slice);
- Release Environment равен exact Environment snapshot плана;
- source tree чистый, равен `HEAD^{tree}` и Release `sourceTree`;
- remote branch равен local `HEAD`;
- `PRODUCTION/STANDARD` требует успешный Deployment того же Release в PREVIEW. Пока preview отсутствует, UI
  показывает typed block; автоматического обхода нет.

Первый vertical slice допускает PREVIEW/STANDARD. PRODUCTION, HOTFIX и ROLLBACK остаются видимыми blocked/unavailable
до реализации их полного доменного контракта; они не эмулируются.

## 6. Состояния и recovery

```text
PENDING_APPROVAL -> APPROVED -> RUNNING -> SUCCEEDED
                                        -> FAILED
                                        -> UNKNOWN
```

- `PENDING_APPROVAL` показывает preview без authority.
- `APPROVED` имеет одноразовый owner Approval, но внешний процесс ещё не начат.
- `RUNNING` записан до запуска `gh`.
- `FAILED` допустим только для доказанного отсутствия side effect либо exact terminal GitHub conclusion.
- `UNKNOWN` означает возможный внешний side effect без доказуемого результата.
- startup переводит `RUNNING` в `UNKNOWN` и ничего не запускает.
- replay command ID возвращает прежний результат; другой payload с тем же ID получает `COMMAND_ID_REUSED`.

## 7. Untrusted output

Dispatch принимает только один URL вида
`https://github.com/<exact-owner>/<exact-repository>/actions/runs/<positive-integer>`. Отсутствующий, лишний,
off-repository или malformed URL даёт `UNKNOWN`. Observe принимает JSON через runtime schema и сверяет run id,
`headSha`, event `workflow_dispatch` и URL. Свободный поиск по тексту, выбор последнего run и raw payload persistence
запрещены.

Persisted failure хранит closed code и фиксированное summary. Bounded sanitized output может существовать только во
внешнем app-private artifact с digest; v1 не сохраняет его вообще.

## 8. Security acceptance

- traversal, symlink workflow, repository subdirectory и credential remote запрещены;
- dirty tree, detached HEAD, in-progress Git и unpublished commit запрещены;
- environment token, `.env` canary, provider payload, absolute macOS/Windows path и raw GitHub JSON не попадают в
  state/event/HTTP;
- dispatch timeout/cancel/output overflow дают `UNKNOWN`, не retry;
- duplicate runner wake создаёт максимум один external attempt;
- restart `RUNNING` не вызывает `gh workflow run`;
- Windows/macOS пути с пробелами и Unicode проходят preflight tests;
- HTTP mutation сохраняет loopback session/Origin/CSRF boundary.

## 9. UI

Launch показывает последовательно: план не принят, ожидает подтверждения, approved/running, success, failure или
unknown. Для каждого blocked состояния есть одна обычная причина и безопасное следующее действие. `UNKNOWN`
отдельно предупреждает не нажимать deploy повторно. Состояние не кодируется одним цветом; кнопки доступны с
клавиатуры и имеют visible focus.

## 10. Не входит в L4a

- произвольные workflow/inputs, GitHub Enterprise и другие hosts;
- Git push/merge/tag/release;
- локальный SSH/VPS/container deploy;
- production secret storage;
- HOTFIX, waiver и rollback execution;
- автоматическое наблюдение, retry, probe или rollback;
- обещание production readiness.
