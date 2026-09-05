# L1 — Readiness v2: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** расширить закрытый каталог Project Readiness с 8 до 14 пунктов, добавив проверяемые локально факты о
зависимостях и разделении окружений плюс четыре owner-решения, необходимых перед запуском.

**Architecture:** словарь расширяется первым и не меняет поведения; новые проверки пишутся как чистые функции с
собственными тестами и подключаются одним атомарным «флипом» вместе с bump счётчиков, domain-каталогом и
миграцией. `packages/project-readiness` остаётся read-only модулем без SQLite и HTTP, домен остаётся
детерминированным, SQLite остаётся operational truth.

**Tech Stack:** TypeScript strict, Zod, vitest, node:sqlite, React + собственный i18n, Playwright.

**Спецификация:** [`82-l-production-launch-track-spec.ru.md`](82-l-production-launch-track-spec.ru.md), §2 (веха
L1), §4 D14, §5.1

**Предшественник:** [`29-b3-b2-project-readiness-security-spec.ru.md`](29-b3-b2-project-readiness-security-spec.ru.md)

## Global Constraints

- Активация toolchain обязательна в каждой Bash-команде, состояние shell между вызовами не сохраняется:
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm <...>`. Бесприставочный `pnpm` в этом
  чекауте — версия 8 и падает с `ERR_PNPM_UNSUPPORTED_ENGINE`.
- Node `>=24.19 <25`, pnpm `11.21.0`.
- TypeScript strict; `any` запрещён в production-коде и публичных тестах; только named exports.
- Домен не читает filesystem; `packages/project-readiness` не знает SQLite и HTTP; `packages/*` не импортирует из
  `apps/*`.
- Миграция, вошедшая в общую историю, не редактируется — добавляется новая.
- Новый AUTOMATED пункт обязан проходить тривиально при отсутствии предмета проверки (спека §4 D14).
- Finding сообщает факт и никогда не содержит значение секрета (спека §4 D4 предшественника).
- Статус не кодируется только цветом; light и dark равноправны; EN и RU равноправны.
- **Коммит выполняется только по явной просьбе владельца** (CLAUDE.md). Шаги «Commit» ниже означают
  подготовленный и проверенный коммит, который не выполняется без запроса.
- Каждая задача заканчивается зелёным узким набором тестов; `pnpm verify` запускается один раз в задаче 8.

---

### Task 1: Словарь каталога v2

Добавляет новые члены закрытых enum и все зависящие от них строки UI. Поведение не меняется: счётчики остаются 8,
scanner по-прежнему выдаёт 8 пунктов. Задача существует отдельно потому, что `satisfies Record<...>` в UI
превращает добавление ключа в немедленную ошибку typecheck — словарь и его отображение обязаны меняться вместе.

**Files:**

- Modify: `packages/contracts/src/readiness.ts:11` (категории), `:22` (ключи), `:34` (коды findings)
- Modify: `apps/web/src/i18n.tsx:343` (EN-блок), `:1431` (RU-блок)
- Modify: `apps/web/src/shell/AppFrame.tsx:694-728` (четыре `satisfies Record` карты)
- Modify: `apps/web/src/views/WorkbenchPage.tsx:482` (второй, независимый `Record<ReadinessCheck["key"],
TranslationKey>`, дублирующий один из карт `AppFrame.tsx`; не был предусмотрен при написании плана и найден
  typecheck'ом в реализации — без него Gate «typecheck зелёный» недостижим)
- Test: `packages/contracts/test/readiness.unit.test.ts`

**Interfaces:**

- Produces: `readinessCheckKeySchema` с 14 членами; `readinessCategorySchema` с `DEPENDENCIES | ENVIRONMENT |
OPERATIONS` в дополнение к прежним; `securityFindingCodeSchema` с `LOCKFILE_MISSING | LOCKFILE_AMBIGUOUS |
DEPENDENCY_INPUT_UNVERIFIABLE | PROD_ENV_NOT_IGNORED | INLINE_SECRET_IN_CI`.
- Consumes: ничего.

- [ ] **Step 1: Написать падающий тест на новые члены словаря**

В `packages/contracts/test/readiness.unit.test.ts` добавить:

```ts
describe("readiness catalog v2 vocabulary", () => {
  it("accepts the six launch-readiness keys and their categories", () => {
    const drafts = [
      { key: "DEPS_LOCKFILE_PRESENT", category: "DEPENDENCIES", mode: "AUTOMATED" },
      { key: "ENV_PROD_SEPARATION", category: "ENVIRONMENT", mode: "AUTOMATED" },
      { key: "SECURITY_HEADERS_OWNER_REVIEW", category: "SECURITY", mode: "OWNER" },
      { key: "OPS_HEALTH_ENDPOINT_DECLARED", category: "OPERATIONS", mode: "OWNER" },
      { key: "OPS_ROLLBACK_PLAN", category: "OPERATIONS", mode: "OWNER" },
      { key: "OPS_BACKUP", category: "OPERATIONS", mode: "OWNER" },
    ] as const;

    for (const draft of drafts) {
      expect(
        readinessCheckDraftSchema.parse({
          ...draft,
          status: "ACTION_REQUIRED",
          summary: "fixture",
          findings: [],
        }).key,
      ).toBe(draft.key);
    }
  });

  it("accepts the five launch-readiness finding codes", () => {
    for (const code of [
      "LOCKFILE_MISSING",
      "LOCKFILE_AMBIGUOUS",
      "DEPENDENCY_INPUT_UNVERIFIABLE",
      "PROD_ENV_NOT_IGNORED",
      "INLINE_SECRET_IN_CI",
    ] as const) {
      expect(
        securityFindingDraftSchema.parse({ code, severity: "HIGH", path: null, message: "fixture" }).code,
      ).toBe(code);
    }
  });

  it("still rejects a key outside the closed catalog", () => {
    expect(() =>
      readinessCheckDraftSchema.parse({
        key: "OPS_MONITORING",
        category: "OPERATIONS",
        mode: "OWNER",
        status: "ACTION_REQUIRED",
        summary: "fixture",
        findings: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/contracts exec vitest run test/readiness.unit.test.ts
```

Ожидание: FAIL — `readinessCheckDraftSchema` отвергает `DEPS_LOCKFILE_PRESENT`.

- [ ] **Step 3: Расширить enum в contracts**

В `packages/contracts/src/readiness.ts` заменить три схемы:

```ts
export const readinessCategorySchema = z.enum([
  "SECURITY",
  "LEGAL",
  "PAYMENTS",
  "ANALYTICS",
  "DEPENDENCIES",
  "ENVIRONMENT",
  "OPERATIONS",
]);
```

```ts
export const readinessCheckKeySchema = z.enum([
  "SECURITY_ACTIVE_CONSTITUTION",
  "SECURITY_SECRET_PATHS",
  "SECURITY_ENV_IGNORED",
  "SECURITY_CI_HARDENING",
  "LEGAL_LICENSE",
  "LEGAL_OWNER_REVIEW",
  "PAYMENTS_OWNER_REVIEW",
  "ANALYTICS_OWNER_REVIEW",
  "DEPS_LOCKFILE_PRESENT",
  "ENV_PROD_SEPARATION",
  "SECURITY_HEADERS_OWNER_REVIEW",
  "OPS_HEALTH_ENDPOINT_DECLARED",
  "OPS_ROLLBACK_PLAN",
  "OPS_BACKUP",
]);
```

```ts
export const securityFindingCodeSchema = z.enum([
  "ACTIVE_CONSTITUTION_MISSING",
  "TRACKED_SECRET_PATH",
  "ENV_NOT_IGNORED",
  "CI_PULL_REQUEST_TARGET",
  "CI_WRITE_ALL_PERMISSIONS",
  "CI_ACTION_NOT_PINNED",
  "CI_INPUT_UNVERIFIABLE",
  "LICENSE_MISSING",
  "LOCKFILE_MISSING",
  "LOCKFILE_AMBIGUOUS",
  "DEPENDENCY_INPUT_UNVERIFIABLE",
  "PROD_ENV_NOT_IGNORED",
  "INLINE_SECRET_IN_CI",
]);
```

Счётчики `.length(8)` и `.max(8)` **не трогать** — они меняются в задаче 6.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/contracts exec vitest run test/readiness.unit.test.ts
```

Ожидание: PASS.

- [ ] **Step 5: Убедиться, что typecheck теперь падает на UI-картах**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm typecheck
```

Ожидание: FAIL в `apps/web/src/shell/AppFrame.tsx` — `readinessCategoryKeys`, `readinessCheckKeys` и
`readinessFindingKeys` больше не удовлетворяют `satisfies Record<...>`. Это ожидаемый сигнал: компилятор
перечисляет оставшуюся работу задачи.

- [ ] **Step 6: Добавить EN-строки**

В `apps/web/src/i18n.tsx` после `"settings.readiness.category.analytics"` (строка 346) добавить:

```ts
  "settings.readiness.category.dependencies": "Dependencies",
  "settings.readiness.category.environment": "Environment",
  "settings.readiness.category.operations": "Operations",
```

После `"settings.readiness.check.analyticsOwner"` (строка 354) добавить:

```ts
  "settings.readiness.check.lockfile": "Reproducible dependency lockfile",
  "settings.readiness.check.envProdSeparation": "Production values kept out of the repository",
  "settings.readiness.check.securityHeadersOwner": "Security headers decision",
  "settings.readiness.check.healthEndpoint": "Health endpoint",
  "settings.readiness.check.rollbackPlan": "Rollback plan",
  "settings.readiness.check.backup": "Data backup",
```

После `"settings.readiness.finding.license"` (строка 373) добавить:

```ts
  "settings.readiness.finding.lockfileMissing":
    "A tracked manifest has no lockfile, so installs are not reproducible.",
  "settings.readiness.finding.lockfileAmbiguous":
    "More than one package manager lockfile is tracked.",
  "settings.readiness.finding.dependencyUnverifiable":
    "Dependency inputs could not be inspected within safe bounds.",
  "settings.readiness.finding.prodEnvNotIgnored":
    "A production environment file exists and is not covered by ignore rules.",
  "settings.readiness.finding.inlineSecretInCi":
    "CI assigns a secret-named variable a literal value instead of a managed reference.",
```

- [ ] **Step 7: Добавить RU-строки**

В RU-блоке (`const ru`, начинается на строке 1091) добавить те же ключи по тем же позициям:

```ts
  "settings.readiness.category.dependencies": "Зависимости",
  "settings.readiness.category.environment": "Окружение",
  "settings.readiness.category.operations": "Эксплуатация",
```

```ts
  "settings.readiness.check.lockfile": "Воспроизводимый lockfile зависимостей",
  "settings.readiness.check.envProdSeparation": "Продакшн-значения вне репозитория",
  "settings.readiness.check.securityHeadersOwner": "Решение по security headers",
  "settings.readiness.check.healthEndpoint": "Health-эндпоинт",
  "settings.readiness.check.rollbackPlan": "План отката",
  "settings.readiness.check.backup": "Резервное копирование данных",
```

```ts
  "settings.readiness.finding.lockfileMissing":
    "У отслеживаемого manifest нет lockfile, установка не воспроизводится.",
  "settings.readiness.finding.lockfileAmbiguous":
    "Отслеживается больше одного lockfile разных пакетных менеджеров.",
  "settings.readiness.finding.dependencyUnverifiable":
    "Данные о зависимостях не удалось проверить в безопасных пределах.",
  "settings.readiness.finding.prodEnvNotIgnored":
    "Файл продакшн-окружения существует и не покрыт правилами ignore.",
  "settings.readiness.finding.inlineSecretInCi":
    "CI присваивает переменной с секретным именем литеральное значение вместо ссылки на управляемый секрет.",
```

- [ ] **Step 8: Дополнить карты в AppFrame**

В `apps/web/src/shell/AppFrame.tsx` дополнить три карты:

```ts
const readinessCategoryKeys = {
  SECURITY: "settings.readiness.category.security",
  LEGAL: "settings.readiness.category.legal",
  PAYMENTS: "settings.readiness.category.payments",
  ANALYTICS: "settings.readiness.category.analytics",
  DEPENDENCIES: "settings.readiness.category.dependencies",
  ENVIRONMENT: "settings.readiness.category.environment",
  OPERATIONS: "settings.readiness.category.operations",
} as const satisfies Record<ReadinessCheck["category"], TranslationKey>;
```

В `readinessCheckKeys` добавить шесть записей:

```ts
  DEPS_LOCKFILE_PRESENT: "settings.readiness.check.lockfile",
  ENV_PROD_SEPARATION: "settings.readiness.check.envProdSeparation",
  SECURITY_HEADERS_OWNER_REVIEW: "settings.readiness.check.securityHeadersOwner",
  OPS_HEALTH_ENDPOINT_DECLARED: "settings.readiness.check.healthEndpoint",
  OPS_ROLLBACK_PLAN: "settings.readiness.check.rollbackPlan",
  OPS_BACKUP: "settings.readiness.check.backup",
```

В `readinessFindingKeys` добавить пять записей:

```ts
  LOCKFILE_MISSING: "settings.readiness.finding.lockfileMissing",
  LOCKFILE_AMBIGUOUS: "settings.readiness.finding.lockfileAmbiguous",
  DEPENDENCY_INPUT_UNVERIFIABLE: "settings.readiness.finding.dependencyUnverifiable",
  PROD_ENV_NOT_IGNORED: "settings.readiness.finding.prodEnvNotIgnored",
  INLINE_SECRET_IN_CI: "settings.readiness.finding.inlineSecretInCi",
```

- [ ] **Step 9: Прогнать typecheck и узкие тесты**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm typecheck && corepack pnpm --dir packages/contracts exec vitest run test/readiness.unit.test.ts
```

Ожидание: обе команды PASS.

- [ ] **Step 10: Commit (только по явной просьбе владельца)**

```bash
git add packages/contracts/src/readiness.ts packages/contracts/test/readiness.unit.test.ts apps/web/src/i18n.tsx apps/web/src/shell/AppFrame.tsx
git commit -m "feat(readiness): open catalog v2 vocabulary"
```

**Gate:** словарь расширен, EN и RU симметричны, typecheck зелёный, поведение не изменилось — Run по-прежнему
содержит 8 пунктов.

---

### Task 2: Выделить ограниченное чтение CI-workflow

Behaviour-preserving рефакторинг. Сейчас `ciFindings` одновременно читает файлы и ищет паттерны; задаче 5 нужны те
же прочитанные файлы для другой проверки. Читать их дважды означало бы удвоить bounds и разойтись в лимитах.

**Files:**

- Modify: `packages/project-readiness/src/scanner.ts:173-289`
- Test: `packages/project-readiness/test/scanner.integration.test.ts` (существующие тесты — страховочная сетка)

**Interfaces:**

- Produces: `type CiWorkflowFile = { path: string; content: string }` и
  `readBoundedCiWorkflows(repositoryPath: string): Promise<{ files: readonly CiWorkflowFile[]; unverifiable: readonly SecurityFindingDraft[] }>`;
  `ciFindings(files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[]` становится чистой функцией.
- Consumes: `finding` из задачи-предшественника (существует).

- [ ] **Step 1: Зафиксировать текущее поведение прогоном существующих тестов**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: PASS. Этот результат — эталон, после рефакторинга он обязан остаться таким же.

- [ ] **Step 2: Ввести тип и разделить функцию**

В `packages/project-readiness/src/scanner.ts` заменить сигнатуру `ciFindings` на две функции. Вся логика обхода
директории, проверки symlink, лимитов `MAX_CI_FILES`, `MAX_CI_FILE_BYTES`, `MAX_CI_TOTAL_BYTES` и все findings с
кодом `CI_INPUT_UNVERIFIABLE` переезжают в `readBoundedCiWorkflows` без изменений; вся логика поиска паттернов
`pull_request_target`, `permissions: write-all` и непринятого пиннинга переезжает в `ciFindings`, которая теперь
принимает уже прочитанные файлы:

```ts
type CiWorkflowFile = { path: string; content: string };

const readBoundedCiWorkflows = async (
  repositoryPath: string,
): Promise<{ files: readonly CiWorkflowFile[]; unverifiable: readonly SecurityFindingDraft[] }> => {
  // Строки 175-256 прежнего ciFindings переносятся сюда без единого изменения: lstat директории,
  // readdir, сортировка по имени, MAX_CI_FILES, MAX_CI_FILE_BYTES, MAX_CI_TOTAL_BYTES, отказ от
  // symlink и все пять мест, где создаётся CI_INPUT_UNVERIFIABLE. Они накапливаются в unverifiable.
  // Единственное отличие: там, где прежний код после `content = ...` искал паттерны, новый код
  // делает `files.push({ path: relativePath, content })` и продолжает цикл.
};

const ciFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    if (/^\s*pull_request_target\s*:/m.test(file.content)) {
      findings.push(
        finding(
          "CI_PULL_REQUEST_TARGET",
          "HIGH",
          file.path,
          "The workflow uses pull_request_target and requires an explicit trust-boundary review.",
        ),
      );
    }
    if (/^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im.test(file.content)) {
      findings.push(
        finding("CI_WRITE_ALL_PERMISSIONS", "HIGH", file.path, "The workflow grants write-all permissions."),
      );
    }
    const actionPattern = /^\s*-?\s*uses\s*:\s*["']?([^\s"'#]+)@([^\s"'#]+)["']?/gim;
    for (const match of file.content.matchAll(actionPattern)) {
      const target = match[1];
      const reference = match[2];
      if (
        target?.startsWith("./") ||
        target?.startsWith("docker://") ||
        /^[0-9a-f]{40}$/i.test(reference ?? "")
      ) {
        continue;
      }
      findings.push(
        finding(
          "CI_ACTION_NOT_PINNED",
          "MEDIUM",
          file.path,
          `The action ${target ?? "unknown"} is not pinned to a full commit SHA.`,
        ),
      );
    }
  }
  return findings;
};
```

- [ ] **Step 3: Обновить точку вызова в `assessProjectReadiness`**

В блоке `Promise.all` заменить `ciFindings(canonicalRoot)` на `readBoundedCiWorkflows(canonicalRoot)`, а сборку
findings для `SECURITY_CI_HARDENING` — на объединение в прежнем порядке:

```ts
const ci = [...workflows.unverifiable, ...ciFindings(workflows.files)];
```

Порядок важен: прежняя реализация выдавала `CI_INPUT_UNVERIFIABLE` для превышения лимита файлов раньше остальных
findings, и существующие тесты это фиксируют.

- [ ] **Step 4: Прогнать эталонный набор ещё раз**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: PASS, тот же результат, что в шаге 1. Ни один тест не правится — если тест пришлось менять, рефакторинг
изменил поведение и его нужно откатить.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add packages/project-readiness/src/scanner.ts
git commit -m "refactor(readiness): split bounded CI reading from pattern findings"
```

**Gate:** чтение и анализ CI разделены, лимиты остались в одном месте, поведение не изменилось.

---

### Task 3: Проверка `DEPS_LOCKFILE_PRESENT`

**Files:**

- Modify: `packages/project-readiness/src/scanner.ts`
- Test: `packages/project-readiness/test/scanner.integration.test.ts`

**Interfaces:**

- Produces: `lockfileFindings(trackedPaths: readonly string[] | null): readonly SecurityFindingDraft[]`;
  `null` означает «список отслеживаемых путей вышел за безопасные пределы».
- Consumes: `finding` (существует), `SecurityFindingDraft` из `@loomrail/contracts`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `packages/project-readiness/test/scanner.integration.test.ts`, импортировав `lockfileFindings` из
`../src/scanner.js`:

```ts
describe("lockfile findings", () => {
  it("passes a repository without a tracked manifest", () => {
    expect(lockfileFindings(["README.md", "src/index.ts"])).toEqual([]);
  });

  it("passes a manifest with exactly one lockfile", () => {
    expect(lockfileFindings(["package.json", "pnpm-lock.yaml"])).toEqual([]);
  });

  it("reports a manifest without any lockfile", () => {
    const findings = lockfileFindings(["package.json"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "LOCKFILE_MISSING", severity: "HIGH", path: "package.json" });
  });

  it("reports every lockfile when more than one package manager is tracked", () => {
    const findings = lockfileFindings(["package.json", "pnpm-lock.yaml", "package-lock.json"]);
    expect(findings.map((entry) => entry.code)).toEqual(["LOCKFILE_AMBIGUOUS", "LOCKFILE_AMBIGUOUS"]);
  });

  it("ignores a lockfile that is not at the repository root", () => {
    const findings = lockfileFindings(["package.json", "packages/api/pnpm-lock.yaml"]);
    expect(findings.map((entry) => entry.code)).toEqual(["LOCKFILE_MISSING"]);
  });

  it("reports unverifiable inputs instead of guessing", () => {
    const findings = lockfileFindings(null);
    expect(findings).toEqual([
      expect.objectContaining({ code: "DEPENDENCY_INPUT_UNVERIFIABLE", severity: "HIGH", path: null }),
    ]);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что тест падает**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts -t "lockfile findings"
```

Ожидание: FAIL — `lockfileFindings` не экспортируется.

- [ ] **Step 3: Реализовать проверку**

В `packages/project-readiness/src/scanner.ts` рядом с `isSecretLikePath` добавить:

```ts
const ROOT_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
] as const;

export const lockfileFindings = (trackedPaths: readonly string[] | null): readonly SecurityFindingDraft[] => {
  if (trackedPaths === null) {
    return [
      finding(
        "DEPENDENCY_INPUT_UNVERIFIABLE",
        "HIGH",
        null,
        "Tracked paths exceeded the safe inspection bound, so lockfile coverage was not checked.",
      ),
    ];
  }
  const rootPaths = new Set(trackedPaths.filter((path) => !path.includes("/")));
  if (!rootPaths.has("package.json")) return [];
  const present = ROOT_LOCKFILES.filter((name) => rootPaths.has(name));
  if (present.length === 0) {
    return [
      finding(
        "LOCKFILE_MISSING",
        "HIGH",
        "package.json",
        "A tracked manifest has no tracked lockfile, so installed versions are not reproducible.",
      ),
    ];
  }
  if (present.length === 1) return [];
  return present.map((name) =>
    finding(
      "LOCKFILE_AMBIGUOUS",
      "MEDIUM",
      name,
      "More than one package manager lockfile is tracked, so the installed tree is ambiguous.",
    ),
  );
};
```

Отсутствие `package.json` даёт пустой результат намеренно: спека §4 D14 запрещает AUTOMATED-пункту навсегда
блокировать `READY` у проекта, где предмета проверки просто нет.

- [ ] **Step 4: Запустить и убедиться, что тест проходит**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: PASS, включая прежние тесты.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add packages/project-readiness/src/scanner.ts packages/project-readiness/test/scanner.integration.test.ts
git commit -m "feat(readiness): observe tracked dependency lockfile coverage"
```

**Gate:** проверка построена как отсутствие нарушения, не читает содержимое manifest и не запускает пакетный
менеджер.

---

### Task 4: Проверка `ENV_PROD_SEPARATION`

Доказывает один факт: продакшн-значения не лежат в репозитории и не присваиваются литералами в CI. Требование
«имена переменных объявлены» сюда не входит — его нельзя вывести честно без пресета, и оно появится в L4.

**Files:**

- Modify: `packages/project-readiness/src/scanner.ts`
- Test: `packages/project-readiness/test/scanner.integration.test.ts`

**Interfaces:**

- Produces: `inlineSecretFindings(files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[]` и
  `prodEnvFindings(entries: readonly { path: string; exists: boolean; ignored: boolean | null }[]): readonly SecurityFindingDraft[]`.
- Consumes: `CiWorkflowFile` из задачи 2, `ignoredByGit` (существует).

- [ ] **Step 1: Написать падающие тесты**

```ts
describe("production environment separation", () => {
  it("passes when no production env file exists", () => {
    expect(prodEnvFindings([{ path: ".env.production", exists: false, ignored: false }])).toEqual([]);
  });

  it("reports an existing production env file that is not ignored", () => {
    const findings = prodEnvFindings([{ path: ".env.production", exists: true, ignored: false }]);
    expect(findings).toEqual([
      expect.objectContaining({ code: "PROD_ENV_NOT_IGNORED", severity: "HIGH", path: ".env.production" }),
    ]);
  });

  it("reports an existing production env file whose ignore state is unknown", () => {
    const findings = prodEnvFindings([{ path: ".env.production", exists: true, ignored: null }]);
    expect(findings.map((entry) => entry.code)).toEqual(["PROD_ENV_NOT_IGNORED"]);
  });

  it("passes an existing production env file that is ignored", () => {
    expect(prodEnvFindings([{ path: ".env.production", exists: true, ignored: true }])).toEqual([]);
  });

  it("passes a workflow that references managed secrets", () => {
    const files = [
      {
        path: ".github/workflows/ci.yml",
        content: "env:\n  API_TOKEN: ${{ secrets.API_TOKEN }}\n  DB_PASSWORD: $DB_PASSWORD\n",
      },
    ];
    expect(inlineSecretFindings(files)).toEqual([]);
  });

  it("reports one finding per workflow that assigns a literal secret value", () => {
    const files = [
      {
        path: ".github/workflows/deploy.yml",
        content: 'env:\n  DEPLOY_TOKEN: "kx7Qm2ZpLr9TvWs4"\n  OTHER_SECRET: aVeryLongLiteralValue\n',
      },
    ];
    const findings = inlineSecretFindings(files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "INLINE_SECRET_IN_CI",
      severity: "CRITICAL",
      path: ".github/workflows/deploy.yml",
    });
  });

  it("never repeats the observed value in the message", () => {
    const files = [
      { path: ".github/workflows/deploy.yml", content: 'env:\n  DEPLOY_TOKEN: "kx7Qm2ZpLr9TvWs4"\n' },
    ];
    expect(inlineSecretFindings(files)[0]?.message).not.toContain("kx7Qm2ZpLr9TvWs4");
  });

  it("ignores a short placeholder and a variable without a secret-shaped name", () => {
    const files = [
      { path: ".github/workflows/ci.yml", content: "env:\n  API_TOKEN: todo\n  NODE_VERSION: 24.19.0\n" },
    ];
    expect(inlineSecretFindings(files)).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что тест падает**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts -t "production environment separation"
```

Ожидание: FAIL — функции не экспортируются.

- [ ] **Step 3: Реализовать обе функции**

```ts
const SECRET_NAME_PATTERN = /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS/i;
const MANAGED_REFERENCE_PATTERN = /^\$\{\{.+\}\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[^}]+\}$/;
const MIN_LITERAL_SECRET_LENGTH = 8;

export const inlineSecretFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
      const name = match?.[1];
      const rawValue = match?.[2];
      if (!name || !rawValue || !SECRET_NAME_PATTERN.test(name)) continue;
      const value = rawValue.replace(/^["']/, "").replace(/["']$/, "");
      if (value.length < MIN_LITERAL_SECRET_LENGTH || MANAGED_REFERENCE_PATTERN.test(value)) continue;
      findings.push(
        finding(
          "INLINE_SECRET_IN_CI",
          "CRITICAL",
          file.path,
          `The workflow assigns ${name} a literal value instead of referencing a managed secret.`,
        ),
      );
      break;
    }
  }
  return findings;
};

export const prodEnvFindings = (
  entries: readonly { path: string; exists: boolean; ignored: boolean | null }[],
): readonly SecurityFindingDraft[] =>
  entries
    .filter((entry) => entry.exists && entry.ignored !== true)
    .map((entry) =>
      finding(
        "PROD_ENV_NOT_IGNORED",
        "HIGH",
        entry.path,
        entry.ignored === null
          ? "Ignore coverage could not be verified for an existing production environment file."
          : "An existing production environment file is not covered by Git ignore rules.",
      ),
    );
```

`break` после первого finding в файле ограничивает объём; имя переменной в сообщении допустимо, значение — нет.

- [ ] **Step 4: Запустить и убедиться, что тест проходит**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: PASS.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add packages/project-readiness/src/scanner.ts packages/project-readiness/test/scanner.integration.test.ts
git commit -m "feat(readiness): observe production environment separation"
```

**Gate:** ни одно значение не попадает в finding; репозиторий без CI и без файлов окружения проходит проверку.

---

### Task 5: Четыре owner-пункта

**Files:**

- Modify: `packages/project-readiness/src/scanner.ts`
- Test: `packages/project-readiness/test/scanner.integration.test.ts`

**Interfaces:**

- Consumes: `ownerCheck(key, category, summary)` (существует).
- Produces: ничего нового; четыре вызова `ownerCheck` подключаются в задаче 6.

- [ ] **Step 1: Написать падающий тест на формулировки**

```ts
describe("launch owner checks", () => {
  it("starts every launch owner check unresolved and without findings", () => {
    for (const draft of launchOwnerChecks()) {
      expect(draft.mode).toBe("OWNER");
      expect(draft.status).toBe("ACTION_REQUIRED");
      expect(draft.findings).toEqual([]);
      expect(draft.summary.length).toBeGreaterThan(0);
    }
    expect(launchOwnerChecks().map((draft) => draft.key)).toEqual([
      "SECURITY_HEADERS_OWNER_REVIEW",
      "OPS_HEALTH_ENDPOINT_DECLARED",
      "OPS_ROLLBACK_PLAN",
      "OPS_BACKUP",
    ]);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что тест падает**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts -t "launch owner checks"
```

Ожидание: FAIL — `launchOwnerChecks` не существует.

- [ ] **Step 3: Реализовать**

```ts
export const launchOwnerChecks = (): readonly ReadinessCheckDraft[] => [
  ownerCheck(
    "SECURITY_HEADERS_OWNER_REVIEW",
    "SECURITY",
    "Confirm the security header decision for this project, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_HEALTH_ENDPOINT_DECLARED",
    "OPERATIONS",
    "Confirm a health or readiness path exists, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_ROLLBACK_PLAN",
    "OPERATIONS",
    "Confirm what happens when a release fails and how the previous state is restored.",
  ),
  ownerCheck(
    "OPS_BACKUP",
    "OPERATIONS",
    "Confirm how project data is backed up and restored, or mark it not applicable.",
  ),
];
```

- [ ] **Step 4: Запустить и убедиться, что тест проходит**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: PASS.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add packages/project-readiness/src/scanner.ts packages/project-readiness/test/scanner.integration.test.ts
git commit -m "feat(readiness): add launch owner attestations"
```

**Gate:** каждый owner-пункт стартует нерешённым, формулировка допускает обоснованное `N/A`.

---

### Task 6: Флип каталога на 14 пунктов

Единственная задача, меняющая наблюдаемое поведение. Всё, что зависит от размера каталога, переключается вместе:
scanner, счётчики contracts, domain-каталог, схема SQLite и прежние утверждения о восьми.

**Files:**

- Modify: `packages/project-readiness/src/scanner.ts` (массив `checks` в `assessProjectReadiness`)
- Modify: `packages/contracts/src/readiness.ts:127`, `:163`, `:198`, `:227`
- Modify: `packages/domain/src/readiness.ts:41-54`
- Create: `packages/persistence-sqlite/migrations/0052_readiness_catalog_v2.sql`
- Modify: `packages/persistence-sqlite/src/migrations.ts` (реестр, после версии 51)
- Modify: `packages/persistence-sqlite/src/index.ts` (`newCheckIds` — хардкод из восьми генерируемых
  идентификаторов; не был предусмотрен при написании плана и, оставленный как есть, заставил бы каждый
  `RecordProjectReadinessAssessmentCommand` бросать `READINESS_CATALOG_INVALID`)
- Modify: `apps/web/src/shell/AppFrame.tsx` (хардкод из четырёх категорий в `ProjectReadinessPanel` расширяется
  до семи по Ruling 5, и добавляется guard на пустую секцию по Ruling 8 — оба не были предусмотрены при
  написании плана)
- Modify: `packages/project-readiness/test/scanner.integration.test.ts:57`
- Modify: `packages/persistence-sqlite/test/readiness-state.integration.test.ts:24` (фикстура каталога) и `:109` (счётчик)
- Test: `apps/daemon/test/readiness.integration.test.ts`

**Interfaces:**

- Consumes: `lockfileFindings`, `prodEnvFindings`, `inlineSecretFindings`, `launchOwnerChecks` из задач 3–5.
- Produces: Run из 14 пунктов; `READY` по-прежнему означает «ни одного `ACTION_REQUIRED`».

- [ ] **Step 1: Обновить утверждения о количестве в существующих тестах**

В `packages/project-readiness/test/scanner.integration.test.ts:57` заменить `toHaveLength(8)` на
`toHaveLength(14)`. В `packages/persistence-sqlite/test/readiness-state.integration.test.ts:109` — так же.

- [ ] **Step 2: Запустить и убедиться, что тесты падают**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts
```

Ожидание: FAIL — scanner возвращает 8 пунктов.

- [ ] **Step 3: Подключить новые пункты в scanner**

Сначала добавить помощник рядом с `ignoredByGit`:

```ts
const pathExists = async (repositoryPath: string, path: string): Promise<boolean> => {
  try {
    await lstat(join(repositoryPath, path));
    return true;
  } catch {
    return false;
  }
};
```

Затем заменить деструктуризацию `Promise.all` в `assessProjectReadiness` целиком — имя `ci` уже стало
`workflows` в задаче 2, порядок элементов массива и деструктуризации обязан совпадать:

```ts
const [
  headResult,
  statusResult,
  trackedResult,
  envIgnored,
  envLocalIgnored,
  npmrcIgnored,
  hasLicense,
  workflows,
  prodEnvExists,
  prodEnvLocalExists,
  prodEnvIgnored,
  prodEnvLocalIgnored,
] = await Promise.all([
  runBoundedGit(["rev-parse", "HEAD"], canonicalRoot),
  runBoundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], canonicalRoot),
  runBoundedGit(["ls-files", "-z"], canonicalRoot),
  ignoredByGit(canonicalRoot, ".env"),
  ignoredByGit(canonicalRoot, ".env.local"),
  ignoredByGit(canonicalRoot, ".npmrc"),
  licensePresent(canonicalRoot),
  readBoundedCiWorkflows(canonicalRoot),
  pathExists(canonicalRoot, ".env.production"),
  pathExists(canonicalRoot, ".env.production.local"),
  ignoredByGit(canonicalRoot, ".env.production"),
  ignoredByGit(canonicalRoot, ".env.production.local"),
]);
```

и добавить в конец массива `checks`, после `ANALYTICS_OWNER_REVIEW`, шесть новых записей — **не** «после
`LEGAL_LICENSE`»: `decideProjectReadinessAssessment` строит вывод через `catalog.map(...)` и находит каждый
draft по ключу через `find`, поэтому порядок именно в scanner-массиве нигде не наблюдается и не обязан ничему
совпадать; порядок в UI полностью определяет `catalog` в домене (задача 5 ниже). Разместить здесь новые записи
проще всего в конце, чтобы обе последовательности читались одинаково:

```ts
    automatedCheck(
      "DEPS_LOCKFILE_PRESENT",
      "DEPENDENCIES",
      "No missing or ambiguous lockfiles were found for tracked dependency manifests.",
      "Track a single lockfile so installs are reproducible.",
      lockfileFindings(
        trackedResult.exitCode !== 0 || trackedResult.overflowed ? null : splitNullPaths(trackedResult),
      ),
    ),
    automatedCheck(
      "ENV_PROD_SEPARATION",
      "ENVIRONMENT",
      "Production values are referenced, not stored in the repository.",
      "Keep production values out of the repository and out of CI literals.",
      [
        ...prodEnvFindings([
          { path: ".env.production", exists: prodEnvExists, ignored: prodEnvIgnored },
          { path: ".env.production.local", exists: prodEnvLocalExists, ignored: prodEnvLocalIgnored },
        ]),
        ...inlineSecretFindings(workflows.files),
        ...workflows.unverifiable,
      ],
    ),
    ...launchOwnerChecks(),
```

Обе строки, изменившиеся против первой реализации, отражены выше: pass-summary у `DEPS_LOCKFILE_PRESENT`
переформулирован как утверждение об отсутствии («no missing or ambiguous lockfiles»), а не как утверждение о
наличии manifest — исходная формулировка была бы ложной для репозитория без единого manifest, у которого этот
пункт тоже обязан проходить (спека §4 D14). `ENV_PROD_SEPARATION` наследует `...workflows.unverifiable`: без
этого репозиторий, чей единственный CI-workflow оказался symlink'ом вне безопасного чтения, получал бы
`PASSED` по этой проверке вместо `ACTION_REQUIRED`, хотя ничего не было фактически проверено.

- [ ] **Step 4: Синхронизировать счётчики contracts**

В `packages/contracts/src/readiness.ts` заменить `.max(8)` на `.max(14)` (строка 127) и три `.length(8)` на
`.length(14)` (строки 163, 198, 227).

- [ ] **Step 5: Расширить каталог домена**

В `packages/domain/src/readiness.ts` дополнить константу `catalog` шестью строками в том же порядке, что в
scanner:

```ts
  ["DEPS_LOCKFILE_PRESENT", "DEPENDENCIES", "AUTOMATED"],
  ["ENV_PROD_SEPARATION", "ENVIRONMENT", "AUTOMATED"],
  ["SECURITY_HEADERS_OWNER_REVIEW", "SECURITY", "OWNER"],
  ["OPS_HEALTH_ENDPOINT_DECLARED", "OPERATIONS", "OWNER"],
  ["OPS_ROLLBACK_PLAN", "OPERATIONS", "OWNER"],
  ["OPS_BACKUP", "OPERATIONS", "OWNER"],
```

- [ ] **Step 6: Написать миграцию 0052**

`project_readiness_checks` имеет закрытые `CHECK` на `check_key` и `category`, а `project_readiness_findings` — на
`code`. SQLite не умеет менять `CHECK`, поэтому обе таблицы пересобираются по документированной 12-шаговой
процедуре, как это уже сделано в `0051_verification_cancellation_intent.sql`. На `project_readiness_checks`
ссылаются `project_readiness_findings.check_id` и `project_readiness_attestations.check_id`, поэтому миграция
регистрируется как перестраивающая referenced-таблицу.

Создать `packages/persistence-sqlite/migrations/0052_readiness_catalog_v2.sql`:

```sql
-- L1 (`docs/plans/82-l-production-launch-track-spec.ru.md` §5.1). Catalog v2 widens the closed check,
-- category and finding vocabularies. Existing Runs keep their eight rows unchanged; only future Runs
-- record fourteen. `CHECK` constraints cannot be altered in place, so both tables are rebuilt.
DROP TRIGGER project_readiness_findings_are_append_only_update;
DROP TRIGGER project_readiness_findings_are_append_only_delete;
DROP INDEX project_readiness_findings_run_idx;
DROP INDEX project_readiness_checks_run_idx;

CREATE TABLE project_readiness_checks_v52 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  check_key TEXT NOT NULL CHECK (check_key IN (
    'SECURITY_ACTIVE_CONSTITUTION', 'SECURITY_SECRET_PATHS', 'SECURITY_ENV_IGNORED',
    'SECURITY_CI_HARDENING', 'LEGAL_LICENSE', 'LEGAL_OWNER_REVIEW',
    'PAYMENTS_OWNER_REVIEW', 'ANALYTICS_OWNER_REVIEW',
    'DEPS_LOCKFILE_PRESENT', 'ENV_PROD_SEPARATION', 'SECURITY_HEADERS_OWNER_REVIEW',
    'OPS_HEALTH_ENDPOINT_DECLARED', 'OPS_ROLLBACK_PLAN', 'OPS_BACKUP'
  )),
  category TEXT NOT NULL CHECK (category IN (
    'SECURITY', 'LEGAL', 'PAYMENTS', 'ANALYTICS', 'DEPENDENCIES', 'ENVIRONMENT', 'OPERATIONS'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('AUTOMATED', 'OWNER')),
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (run_id, check_key),
  CHECK (
    (mode = 'AUTOMATED' AND status IN ('PASSED', 'ACTION_REQUIRED')) OR
    (mode = 'OWNER' AND status IN ('ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE'))
  )
) STRICT;

INSERT INTO project_readiness_checks_v52 (
  id, schema_version, run_id, project_id, check_key, category, mode, status, summary, version
)
SELECT id, schema_version, run_id, project_id, check_key, category, mode, status, summary, version
FROM project_readiness_checks;

DROP TABLE project_readiness_checks;
ALTER TABLE project_readiness_checks_v52 RENAME TO project_readiness_checks;

CREATE INDEX project_readiness_checks_run_idx ON project_readiness_checks(run_id, check_key);

CREATE TABLE project_readiness_findings_v52 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL REFERENCES project_readiness_checks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code IN (
    'ACTIVE_CONSTITUTION_MISSING', 'TRACKED_SECRET_PATH', 'ENV_NOT_IGNORED',
    'CI_PULL_REQUEST_TARGET', 'CI_WRITE_ALL_PERMISSIONS', 'CI_ACTION_NOT_PINNED',
    'CI_INPUT_UNVERIFIABLE', 'LICENSE_MISSING',
    'LOCKFILE_MISSING', 'LOCKFILE_AMBIGUOUS', 'DEPENDENCY_INPUT_UNVERIFIABLE',
    'PROD_ENV_NOT_IGNORED', 'INLINE_SECRET_IN_CI'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  path TEXT CHECK (path IS NULL OR length(path) BETWEEN 1 AND 500),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500)
) STRICT;

INSERT INTO project_readiness_findings_v52 (
  id, schema_version, run_id, check_id, project_id, code, severity, path, message
)
SELECT id, schema_version, run_id, check_id, project_id, code, severity, path, message
FROM project_readiness_findings;

DROP TABLE project_readiness_findings;
ALTER TABLE project_readiness_findings_v52 RENAME TO project_readiness_findings;

CREATE INDEX project_readiness_findings_run_idx ON project_readiness_findings(run_id, check_id, id);

CREATE TRIGGER project_readiness_findings_are_append_only_update
BEFORE UPDATE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
CREATE TRIGGER project_readiness_findings_are_append_only_delete
BEFORE DELETE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
```

- [ ] **Step 7: Зарегистрировать миграцию**

В `packages/persistence-sqlite/src/migrations.ts` в конец массива `migrations` добавить:

```ts
  {
    version: 52,
    name: "readiness_catalog_v2",
    filename: "0052_readiness_catalog_v2.sql",
    rebuildsAReferencedTable: true,
  },
```

- [ ] **Step 8: Расширить фикстуру каталога в тесте persistence**

`packages/persistence-sqlite/test/readiness-state.integration.test.ts:24` содержит собственный `checkCatalog` из
восьми записей, из которого строится payload команды. После bump `.length(14)` команда с восемью пунктами
отвергается схемой, поэтому фикстуру нужно дополнить теми же шестью строками и в том же порядке:

```ts
const checkCatalog: readonly CheckCatalogEntry[] = [
  ["SECURITY_ACTIVE_CONSTITUTION", "SECURITY", "AUTOMATED"],
  ["SECURITY_SECRET_PATHS", "SECURITY", "AUTOMATED"],
  ["SECURITY_ENV_IGNORED", "SECURITY", "AUTOMATED"],
  ["SECURITY_CI_HARDENING", "SECURITY", "AUTOMATED"],
  ["LEGAL_LICENSE", "LEGAL", "AUTOMATED"],
  ["LEGAL_OWNER_REVIEW", "LEGAL", "OWNER"],
  ["PAYMENTS_OWNER_REVIEW", "PAYMENTS", "OWNER"],
  ["ANALYTICS_OWNER_REVIEW", "ANALYTICS", "OWNER"],
  ["DEPS_LOCKFILE_PRESENT", "DEPENDENCIES", "AUTOMATED"],
  ["ENV_PROD_SEPARATION", "ENVIRONMENT", "AUTOMATED"],
  ["SECURITY_HEADERS_OWNER_REVIEW", "SECURITY", "OWNER"],
  ["OPS_HEALTH_ENDPOINT_DECLARED", "OPERATIONS", "OWNER"],
  ["OPS_ROLLBACK_PLAN", "OPERATIONS", "OWNER"],
  ["OPS_BACKUP", "OPERATIONS", "OWNER"],
];
```

Отдельного теста «исторический Run из восьми пунктов остался читаемым» здесь не будет, и это осознанно: после
bump такой Run невозможно создать публичной командой, а значит тест пришлось бы писать сырым SQL мимо домена.
Сохранность строк доказывают сама миграция (`INSERT ... SELECT` переносит все столбцы обеих таблиц) и
`PRAGMA foreign_key_check`, который runner выполняет до коммита транзакции и превращает потерянную строку в
`MIGRATION_FAILED`.

- [ ] **Step 9: Прогнать весь затронутый набор**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm build && corepack pnpm --dir packages/contracts exec vitest run test/readiness.unit.test.ts && corepack pnpm --dir packages/project-readiness exec vitest run test/scanner.integration.test.ts && corepack pnpm --dir packages/persistence-sqlite exec vitest run test/readiness-state.integration.test.ts && corepack pnpm --dir apps/daemon exec vitest run --project integration test/readiness.integration.test.ts
```

Ожидание: все PASS. `PRAGMA foreign_key_check` внутри миграции обязан вернуть пустой результат — иначе runner
сам бросит `MIGRATION_FAILED`.

- [ ] **Step 10: Commit (только по явной просьбе владельца)**

```bash
git add packages/project-readiness/src/scanner.ts packages/contracts/src/readiness.ts packages/domain/src/readiness.ts packages/persistence-sqlite/migrations/0052_readiness_catalog_v2.sql packages/persistence-sqlite/src/migrations.ts packages/project-readiness/test/scanner.integration.test.ts packages/persistence-sqlite/test/readiness-state.integration.test.ts
git commit -m "feat(readiness): assess the catalog v2 launch checks"
```

**Gate:** новый Run содержит 14 пунктов, исторический Run из восьми читается без изменений, порядок в scanner и
домене совпадает, миграция не редактирует прежние.

---

### Task 7: Project → Readiness в браузере

Покрытие уже существует: `e2e/walking-skeleton.spec.ts:3396` прогоняет readiness и жёстко утверждает восемь
пунктов. Задача расширяет его, а не создаёт второй файл с дублирующей навигацией.

**Files:**

- Modify: `e2e/walking-skeleton.spec.ts:3396-3433`
- Modify: `apps/web/src/shell/AppFrame.tsx` только если проверка выявит проблему группировки категорий

**Interfaces:**

- Consumes: 14-пунктовый Run из задачи 6 и строки из задачи 1.

- [ ] **Step 1: Обновить существующий E2E и добавить утверждения о новых категориях**

В `e2e/walking-skeleton.spec.ts` в тесте «runs project readiness and persists an explicit owner decision»
заменить счётчик и добавить проверку новых пунктов сразу после него:

```ts
await expect(readiness.locator(".readiness-check")).toHaveCount(14);
await expect(readiness.getByText("Reproducible dependency lockfile")).toBeVisible();
await expect(readiness.getByText("Production values kept out of the repository")).toBeVisible();
await expect(readiness.getByText("Rollback plan")).toBeVisible();
await expect(readiness.getByText("Data backup")).toBeVisible();
```

Строку `await expect(readiness.getByText("Passed automatically", { exact: true })).toHaveCount(2);` **не
угадывать**: fixture-репозиторий из `initializeWorkspace` может проходить или не проходить два новых
AUTOMATED-пункта. Запустить тест, прочитать фактическое число из отчёта Playwright и подставить его, а в описании
задачи записать, почему оно именно такое.

- [ ] **Step 2: Запустить E2E**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm build && corepack pnpm exec playwright test e2e/walking-skeleton.spec.ts -g "runs project readiness"
```

Ожидание: PASS после подстановки фактического числа из шага 1.

- [ ] **Step 3: Добавить owner-решение по новому пункту**

Прежний тест доводит до решения только `LEGAL_OWNER_REVIEW`. Добавить такой же проход по `OPS_ROLLBACK_PLAN`,
чтобы новая категория тоже была доказана целиком — от `ACTION_REQUIRED` до сохранённого после переоткрытия
диалога решения:

```ts
const rollbackCheck = readiness.locator(".readiness-check").filter({ hasText: "Rollback plan" });
await rollbackCheck
  .getByRole("textbox", { name: "Decision note" })
  .fill("Redeploy the previous build from the hosting dashboard.");
await rollbackCheck.getByRole("button", { name: "Confirm" }).click();
await expect(rollbackCheck.getByText("Confirmed by owner", { exact: true })).toBeVisible();
```

- [ ] **Step 4: Проверить RU, тёмную тему и клавиатуру**

Переключить язык на русский, тему на тёмную и пройти по owner-пунктам только с клавиатуры: фокус обязан быть
видимым, а статус — читаться без цвета. Зафиксировать в описании задачи, что именно проверено; заявление «UI
проверен» без этого прохода не принимается.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add e2e/walking-skeleton.spec.ts
git commit -m "test(readiness): cover catalog v2 categories in the browser"
```

**Gate:** владелец без терминала видит все 14 пунктов, три новые категории и доводит до решения пункт из новой
категории, который переживает переоткрытие диалога.

---

### Task 8: Документы и полный gate

**Files:**

- Modify: `docs/plans/82-l-production-launch-track-spec.ru.md` (статус L1)
- Modify: `docs/plans/83-l1-readiness-v2-implementation-plan.ru.md` (итоговый раздел)
- Modify: `docs/product/MASTER-PLAN.ru.md` (checkpoint-строка трека L)
- Modify: `docs/security/THREAT-MODEL.md` только если верификация выявит новую поверхность

- [ ] **Step 1: Прогнать полный gate**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm verify
```

Ожидание: PASS. Если появятся прежние защищённые landing-диагностики, зафиксировать их как известные и не
маскировать глобальным отключением правил.

- [ ] **Step 2: Проверить зависимости**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use; corepack pnpm audit --prod --audit-level high
```

- [ ] **Step 3: Записать результат в документы**

В спеке §2 отметить L1 как реализованный, в план дописать раздел «Результат реализации» с точными числами:
сколько пунктов в каталоге, какие тесты прогнаны, на каких платформах. Никаких обобщений вида «всё работает» —
только проверенные факты.

- [ ] **Step 4: Проверить кроссплатформенность**

Прогнать набор задачи 6 на второй блокирующей платформе (macOS и Windows оба блокирующие). Fixture-репозитории
уже используют пути с пробелами и кириллицей; убедиться, что новые тесты наследуют это свойство.

- [ ] **Step 5: Commit (только по явной просьбе владельца)**

```bash
git add docs/plans/82-l-production-launch-track-spec.ru.md docs/plans/83-l1-readiness-v2-implementation-plan.ru.md docs/product/MASTER-PLAN.ru.md
git commit -m "docs(readiness): record catalog v2 implementation result"
```

**Gate:** `pnpm verify` зелёный на обеих блокирующих платформах, документы отражают фактическое состояние.

---

## Результат реализации

**Дата:** 2026-09-06. **Коммиты:** `d703458..5a25248` — 10 коммитов на ветке `worktree-l1-readiness-v2`, база
`428b2c3`. Ничего не push'нуто.

### Каталог

- Пункты (`readinessCheckKeySchema`): 8 → **14**. Добавлены `DEPS_LOCKFILE_PRESENT`, `ENV_PROD_SEPARATION`,
  `SECURITY_HEADERS_OWNER_REVIEW`, `OPS_HEALTH_ENDPOINT_DECLARED`, `OPS_ROLLBACK_PLAN`, `OPS_BACKUP`.
- Категории (`readinessCategorySchema`): 4 → **7**. Добавлены `DEPENDENCIES`, `ENVIRONMENT`, `OPERATIONS`.
- Коды findings (`securityFindingCodeSchema`): 8 → **13**. Добавлены `LOCKFILE_MISSING`, `LOCKFILE_AMBIGUOUS`,
  `DEPENDENCY_INPUT_UNVERIFIABLE`, `PROD_ENV_NOT_IGNORED`, `INLINE_SECRET_IN_CI`.
- Порядок scanner-массива (`packages/project-readiness/src/scanner.ts`) и domain-каталога
  (`packages/domain/src/readiness.ts`) идентичен — проверено прямым чтением обоих файлов в этой задаче — но
  наблюдаемо только второе: `decideProjectReadinessAssessment` строит вывод через `catalog.map(...)` и находит
  каждый draft по ключу через `find`, порядок в scanner-массиве нигде не читается.
- Миграция `packages/persistence-sqlite/migrations/0052_readiness_catalog_v2.sql` перестроила
  `project_readiness_checks` и `project_readiness_findings` (SQLite не допускает изменение `CHECK` in place).
  Задача 6 проверила сохранность существующих строк отдельным scratch-скриптом (не входит в состав репозитория):
  БД с уже существующим pre-v2 Run из 8 checks мигрирована на версию 52, каждая строка всех трёх таблиц
  (`checks`, `findings`, `attestations`) сверена `deepEqual` до и после, `PRAGMA foreign_key_check` и
  `integrity_check` чистые, оба append-only триггера и оба индекса восстановлены.

### Что прогнано в этой задаче и что оно показало

Все команды — на macOS, активация `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"; corepack pnpm ...`.

| Команда                                                                                                          | Результат                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify` (полная цепочка)                                                                                   | **FAIL** на первом же шаге, `format:check` — см. ниже                                                                                                                   |
| `pnpm format:check` (repo-wide, до правок)                                                                       | FAIL — 4 файла: `docs/plans/82-...md`, `docs/plans/83-...md` (мои), `docs/research/cripthub-...md`, `docs/research/skin-case-...md` (не мои)                            |
| `pnpm exec prettier --write` на двух моих файлах, затем `pnpm format:check` снова                                | 2 моих файла исправлены (только выравнивание таблиц/переносы, без изменения текста — проверено `git diff`); **2 файла остаются красными** — см. «Известные ограничения» |
| `pnpm test:public-readiness`                                                                                     | PASS — `Public-tree check passed for 779 files`, toolchain Node 24.19.0/pnpm 11.21.0, activation contract verified                                                      |
| `pnpm lint` (`pnpm build && eslint .`)                                                                           | PASS, exit 0, без замечаний                                                                                                                                             |
| `pnpm typecheck` (`pnpm build && tsc --noEmit` + все воркспейсы)                                                 | PASS, exit 0, без ошибок                                                                                                                                                |
| `pnpm test` (6 `node --test` скриптов + `pnpm -r --workspace-concurrency=1 test` по 23 из 24 workspace-проектов) | PASS — node:test **33/33**; vitest **161 test files / 1545 tests**, 0 упавших, во всех пакетах                                                                          |
| `pnpm audit --prod --audit-level high`                                                                           | `No known vulnerabilities found`                                                                                                                                        |
| `pnpm exec playwright test e2e/walking-skeleton.spec.ts -g "runs project readiness"`                             | PASS — **1/1**, прогнан отдельно в этой задаче (сверх `pnpm verify`, который e2e не включает)                                                                           |

Суммы `pnpm test` включают весь репозиторий (23 пакета/приложения), а не только readiness; отдельно, для
пунктов из этого плана, точные числа (уже входящие в суммы выше, не отдельный прогон):

| Набор                                                                  | Результат                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/contracts/test/readiness.unit.test.ts`                       | 7/7                                                     |
| `packages/project-readiness/test/scanner.integration.test.ts`          | 19/19                                                   |
| `packages/persistence-sqlite/test/readiness-state.integration.test.ts` | 4/4                                                     |
| `apps/daemon/test/readiness.integration.test.ts`                       | 1/1 (7 owner-аттестаций, `version: 8`, `status: READY`) |
| `apps/web` (полный пакет — `i18n`, `AppFrame`, `WorkbenchPage`)        | 100/100                                                 |
| `e2e/walking-skeleton.spec.ts -g "runs project readiness"`             | 1/1                                                     |

### Платформы

- **macOS — verified в этой сессии.** Все команды из таблицы выше выполнены напрямую; `pnpm verify` зелёный за
  вычетом двух унаследованных Markdown-файлов (см. ниже); `pnpm audit` и целевой e2e-сценарий — отдельно и оба
  зелёные.
- **Windows — NOT DONE.** В этой сессии нет доступа к Windows-хосту, поэтому набор задачи 6 не был прогнан на
  Windows здесь; это не «пропущено молча», а зафиксированный пробел. Репозиторий держит Windows как блокирующую
  платформу в CI (см. недавние `ci(release)` коммиты на этой же истории), и именно CI — маршрут владельца к
  закрытию этого пробела, не эта сессия. Наиболее вероятное место, где могла бы вскрыться платформенная разница:
  `lockfileFindings` фильтрует «не-корневые» пути условием `path.includes("/")`
  (`packages/project-readiness/src/scanner.ts`) — `git ls-files` эмитит `/`-разделители даже на Windows, так что
  это должно быть безопасно, но здесь это не доказано. Fixture-репозитории задачи 6 уже используют пути с
  пробелами и кириллицей (подтверждено при этом прогоне — `apps/daemon` тесты создавали worktree-пути вида
  `loomrail state тест <suffix>`), но только на macOS.

### Известные ограничения

- `pnpm format:check` остаётся красным на `docs/research/cripthub-gray-settlement-model-primary-sources.ru.md` и
  `docs/research/skin-case-legal-primary-sources.ru.md`. Оба файла пришли в историю коммитом `b3f059c` («123»)
  до появления этой ветки и уже были неотформатированы на тот момент — не относятся к этому треку и не
  переформатированы намеренно: в этом checkout параллельно работает другая сессия, и перевыравнивание чужих
  файлов создало бы ей merge-конфликт без какой-либо пользы. Gate этой задачи оценивается относительно этого
  унаследованного состояния, а не против чистого repo-wide `format:check`.
- Windows не проверен — см. выше.
- `docs/security/THREAT-MODEL.md` дополнен разделом «L1 Readiness v2 delta (T53)», а не T50: на момент записи
  T50–T52 уже используются в `docs/plans/81-i1-tracker-round-trip-youtrack-spec.ru.md` (незакоммиченный файл
  той же параллельной сессии, что писала `b3f059c`) для трёх её собственных будущих threat-model-угроз; T53
  выбран, чтобы не создавать коллизию номеров, когда та работа дойдёт до собственной дельты в THREAT-MODEL.md.
  Помимо номера, добавленный раздел фиксирует, что две из шести новых проверок
  читают содержимое репозитория, а не только имена путей (прямой `lstat` двух фиксированных путей и
  построчный поиск литеральных секретов в уже ограниченном CI-контенте), что не было покрыто прежним текстом
  T25 дословно.

---

## Что эта веха не делает

- не исполняет ни одной найденной команды и не поднимает приложение — это L2;
- не вводит `Environment`, `Release` и `Deployment` — это L3;
- не приближает деплой и не требует нового PD;
- не измеряет фактические заголовки, перфоманс и незакрытые маршруты — это `MEASURED` gates в L2.
