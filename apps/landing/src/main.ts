import "./styles.css";

import cliPackage from "../../cli/package.json" with { type: "json" };
import guidedActivationSource from "../../../packages/contracts/src/guided-activation.v1.json" with { type: "json" };

type Theme = "light" | "dark";
type Locale = "en" | "ru";
type CopyState = "idle" | "loading" | "success" | "error";

const themeStorageKey = "loomrail-landing-theme";
const localeStorageKey = "loomrail-landing-locale";
const installCommands = Object.freeze([...guidedActivationSource.install.commands]);
const installCommand = installCommands.join("\n");
const productVersion = cliPackage.version;

const messages = {
  en: {
    pageTitle: "Loomrail — Orchestrate agents. Own the outcome.",
    metaDescription:
      "Local orchestration for Codex and Claude: six workflow stages, independent review, measured QA and a TypeScript starter. macOS Apple Silicon.",
    ogDescription:
      "Bring your repository or start from a TypeScript boilerplate. Plan, implement, review and verify with local CLIs. You accept the result.",
    skipLink: "Skip to content",
    primaryNavigation: "Primary navigation",
    homeLabel: "Loomrail home",
    navHow: "How it works",
    navInstall: "Install",
    navBoundary: "Scope",
    navDocs: "Docs",
    headerCta: "Get started",
    languageLabel: "Language",
    switchToRussian: "Switch to Russian",
    switchToEnglish: "Switch to English",
    darkTheme: "Dark",
    lightTheme: "Light",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",

    heroTitle: "Orchestrate agents. Own the outcome.",
    heroBody:
      "Bring Codex and Claude into one accountable workflow. Plan the work, run a bounded implementation, review the changes and check the result — with you making the final decision.",
    heroPrimaryCta: "Try locally",
    heroSecondaryCta: "Choose your starting point",
    heroNote: "Open source · Apache-2.0 · Local state, your CLI subscriptions",
    promisesLabel: "Control stays with you",
    promiseCommit: "Never commits",
    promisePush: "Never pushes",
    promiseMerge: "Never merges",
    promiseDeploy: "No automatic deploy",
    promiseAccept: "You accept the delivery",

    whyTitle: "The task outlives the chat.",
    whyBody:
      "Switch sessions without losing the brief, the open questions or the decision. Loomrail keeps the work in a durable local record, so you can see what happened and what still needs attention.",
    whyOneTitle: "Durable by default",
    whyOneBody:
      "State, questions, evidence and decisions are stored locally. After a restart, recover recorded progress and identify interrupted work without silently replaying an agent.",
    whyTwoTitle: "Limits you can inspect",
    whyTwoBody:
      "Set allowed actions and session limits, inspect recorded usage and approve any increase. Budget accounting is reconciled after the provider session.",
    whyThreeTitle: "You stay the owner",
    whyThreeBody:
      "An agent never accepts its own work. Commit, push and merge remain your actions. Guided deployment requires a separate eligible plan and owner approval.",

    howTitle: "Agents do the work. Loomrail keeps it accountable.",
    howIntro:
      "The orchestrator is the workflow engine: it assigns stage roles, checks permissions and keeps durable state outside provider sessions.",
    installTitle: "Try Loomrail without giving it a repository.",
    installIntro:
      "The copy block makes the package and Chromium downloads explicit, then checks your local Codex or Claude Code CLI on loopback. Sign in through that CLI first and start in a new empty directory.",
    installCommandLabel: "Install and launch Loomrail safely",
    copyInstallCommand: "Copy the safe install and launch commands",
    copy: "Copy",
    copying: "Copying…",
    copied: "Copied",
    copyFailed: "Failed",
    runStepOne:
      "Run the five visible commands. npm fetches Loomrail; Playwright fetches Chromium separately.",
    runStepTwo:
      "The read-only preflight runs first. When it is ready, /try opens and names local state and log creation.",
    runStepThree:
      "Prepare the demo workspace, choose Codex CLI or Claude Code CLI, create the seeded task, move it to Ready and start the workflow.",
    runStepFour:
      "Answer the Human Request, approve a bounded real-provider budget if asked, inspect the available evidence, then decide yourself.",
    installLive:
      "Loomrail uses the local CLI's existing subscription login. A missing, incompatible or signed-out CLI blocks dispatch; Loomrail never asks for a provider API key.",
    runtimeLabel: "Runtime",
    runtimeValue: "Node.js 24.19–24.x",
    networkLabel: "Local interface",
    networkValue: "127.0.0.1 only",
    firstRunLabel: "First run",
    firstRunValue: "Local CLI preflight",
    platformLabel: "Platforms",
    platformValue: "macOS Apple Silicon",

    boundaryTitle: "What this macOS Stable release actually does",
    boundaryIntro: `Loomrail ${productVersion} is Stable for macOS on Apple Silicon. Windows and Linux remain outside this release support target and fail closed.`,
    todayTitle: "Available today",
    todayLocal: "Same-machine browser UI, loopback daemon, and local SQLite state.",
    todayProviders:
      "Codex CLI and Claude Code CLI adapters with fail-closed version/login checks and bounded workspace tools.",
    todayRecovery: "Restart recovery, Human Requests, budgets, evidence, and Decisions.",
    todayRepo: "Existing repositories, isolated worktrees, a TypeScript/Node starter and change inspection.",
    notYetTitle: "Not claimed yet",
    notCloud: "Cloud sync, remote access, mobile control, or team accounts.",
    notDesktop: "Windows/Linux live-provider support, automatic updates, or a desktop installer.",
    notGit: "Automatic commit, push, merge, deploy, or browser execution.",
    notSandbox: "A complete operating-system sandbox for live providers.",

    docsTitle: "Documentation",
    docsIntro:
      "Sign in through an official local CLI, run the preflight, then register a repository after reading the threat model.",
    docsNavigation: "Loomrail documentation",
    quickStartTitle: "Quick start",
    quickStartBody: "From an empty directory to a bounded real-provider task.",
    userGuideTitle: "Owner guide",
    userGuideBody: "Repositories, providers, recovery, backup, troubleshooting.",
    fullRouteTitle: "Full-route example",
    fullRouteBody: "A bounded repository and a reproducible live task.",
    securityTitle: "Threat model",
    securityBody: "Trust boundaries, High and Critical threats, verified controls.",
    architectureTitle: "Architecture",
    architectureBody: "Domain ownership, persistence, providers, and delivery.",
    sourceTitle: "Source code",
    sourceBody: "Read it, build it, or open an issue on GitHub.",

    heroPlatform: "Codex CLI + Claude Code · macOS Apple Silicon",
    heroSource: "Explore the source →",
    navStarters: "Starters",
    routeCaption: "One task. Six stages. Open a stage to explore.",
    routeNote: "Workflow guide, not a live run. Loomrail owns the transitions; agents supply the work.",
    route0Title: "Understand the task",
    route0Body:
      "Clarify the goal, surface open questions and agree on acceptance criteria before implementation.",
    route1Title: "Make the work explicit",
    route1Body:
      "Break the brief into tasks, dependencies and a verification plan. Keep scope and permissions attached to the work.",
    route2Title: "Give the writer a bounded workspace",
    route2Body:
      "A coding agent edits inside the approved workspace. Changes and tool activity remain attached to the task.",
    route3Title: "Get an independent review",
    route3Body:
      "A fresh reviewer examines the changes. Findings can send the task back for correction; the writer cannot approve itself.",
    route4Title: "Check what actually works",
    route4Body:
      "Run approved project checks and measured browser scenarios. Keep reports and evidence tied to the current work.",
    route5Title: "The final decision is yours",
    route5Body:
      "Inspect the acceptance package, accept the delivery or return it. An agent cannot accept its own work.",
    howArchitecture: "How orchestration works →",
    ownerTitle: "You set the direction",
    ownerBody:
      "Define the outcome, answer open questions, approve boundaries and accept or return the result.",
    engineTitle: "Loomrail controls the workflow",
    engineBody:
      "Stage transitions, permissions, session limits, human requests and recovery belong to the local engine — not a model’s claim that it is done.",
    workerTitle: "Codex and Claude execute",
    workerBody:
      "Planning, implementation, independent review and QA run through supported, authenticated local CLIs. Provider network connections remain with those CLIs.",
    researchTitle: "Next: a code-blind planning model",
    researchBody:
      "Astra/Fable planning with Luna/Sonnet workers is being researched, not shipped. The manager would receive short reports, never repository files. Token savings still need a controlled evaluation.",
    researchLink: "Read the design research →",
    startersTitle: "Start with your code. Or a clean slate.",
    startersIntro:
      "Bring a repository, create a small TypeScript project or explore the workflow in a disposable demo.",
    starterRecipe: "Built-in boilerplate · typescript-node@1",
    starterNewTitle: "A starting point you can inspect.",
    starterNewBody:
      "Preview the files, confirm the destination and create a new Git repository with a Node ESM + TypeScript baseline. Your project stays ordinary code, with no Loomrail runtime dependency.",
    starterNewLimit:
      "One built-in recipe today. No template downloads, automatic dependency install, commits or pushes.",
    starterRecipeLink: "Inspect the recipe →",
    starterFiles: "Files you receive",
    starterFilesNote: "Preview → your confirmation → new local project",
    starterExistingTitle: "An existing repository",
    starterExistingBody:
      "Register your local Git repository. Start a bounded task in an isolated worktree and inspect its changes before accepting the delivery.",
    starterExistingLink: "Bring your repository →",
    starterDemoTitle: "A safe place to explore",
    starterDemoBody:
      "Use the guided /try route and bundled web-app/API examples before connecting your own code. Starting an agent still consumes provider quota.",
    starterDemoLink: "Start the guided demo →",
    footerClosing: "From a brief to a result you can inspect.",

    footerNavigation: "Footer navigation",
    footerTagline: "Local state. Human acceptance.",
    footerSource: "Source",
    footerIssues: "Issues",
    footerDocs: "Docs",
  },
  ru: {
    pageTitle: "Loomrail — AI-команда. Результат под контролем.",
    metaDescription:
      "Локальная оркестрация Codex и Claude: шесть этапов, независимое ревью, QA и TypeScript-бойлерплейт. Для macOS Apple Silicon.",
    ogDescription:
      "Подключите репозиторий или начните с TypeScript-шаблона. Планирование, код, ревью и проверки через локальные CLI. Результат принимаете вы.",
    skipLink: "К содержимому",
    primaryNavigation: "Основная навигация",
    homeLabel: "Главная Loomrail",
    navHow: "Как это работает",
    navInstall: "Установка",
    navBoundary: "Границы",
    navDocs: "Документация",
    headerCta: "Начать",
    languageLabel: "Язык",
    switchToRussian: "Переключить на русский",
    switchToEnglish: "Переключить на английский",
    darkTheme: "Тёмная",
    lightTheme: "Светлая",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",

    heroTitle: "AI-команда. Результат под контролем.",
    heroBody:
      "Соберите Codex и Claude в один управляемый процесс: планирование, реализация в заданных границах, ревью и проверка результата. Финальное решение остаётся за вами.",
    heroPrimaryCta: "Попробовать локально",
    heroSecondaryCta: "Выбрать точку старта",
    heroNote: "Открытый код · Apache-2.0 · Локальное состояние, ваши подписки CLI",
    promisesLabel: "Контроль остаётся у вас",
    promiseCommit: "Не коммитит",
    promisePush: "Не пушит",
    promiseMerge: "Не мержит",
    promiseDeploy: "Без автодеплоя",
    promiseAccept: "Поставку принимаете вы",

    whyTitle: "Задача не заканчивается вместе с чатом.",
    whyBody:
      "Сессии меняются, но постановка, вопросы и решения не теряются. Loomrail хранит работу локально: видно, что уже сделано и что требует вашего внимания.",
    whyOneTitle: "Устойчиво по умолчанию",
    whyOneBody:
      "Состояние, вопросы, отчёты и решения хранятся локально. После перезапуска можно восстановить записанный прогресс и увидеть прерванную работу без скрытого перезапуска агента.",
    whyTwoTitle: "Понятные ограничения",
    whyTwoBody:
      "Задайте разрешённые действия и лимиты сессии, проверьте записанный расход и явно подтвердите увеличение. Учёт бюджета сверяется после сессии провайдера.",
    whyThreeTitle: "Владелец — вы",
    whyThreeBody:
      "Агент не принимает собственную работу. Коммиты, push и merge остаются вашими действиями. Управляемый деплой требует отдельного допустимого плана и вашего подтверждения.",

    howTitle: "Агенты работают. Loomrail управляет процессом.",
    howIntro:
      "Оркестратор здесь — движок workflow: он назначает роли на этапы, проверяет разрешения и хранит состояние вне сессий провайдеров.",
    installTitle: "Попробуйте Loomrail без доступа к репозиторию.",
    installIntro:
      "Copy-блок явно показывает загрузку пакета и Chromium, затем проверяет локальный Codex или Claude Code CLI на loopback. Сначала войдите через этот CLI и начните в новом пустом каталоге.",
    installCommandLabel: "Безопасная установка и запуск Loomrail",
    copyInstallCommand: "Скопировать безопасные команды установки и запуска",
    copy: "Копировать",
    copying: "Копируем…",
    copied: "Скопировано",
    copyFailed: "Ошибка",
    runStepOne:
      "Выполните пять видимых команд. npm загрузит Loomrail, а Playwright отдельно загрузит Chromium.",
    runStepTwo:
      "Сначала выполнится read-only preflight. Если он готов, откроется /try с явным описанием создания local state и logs.",
    runStepThree:
      "Подготовьте demo workspace, выберите Codex CLI или Claude Code CLI, создайте задачу, переведите её в Ready и запустите workflow.",
    runStepFour:
      "Ответьте на Human Request, при необходимости подтвердите ограниченный бюджет реального провайдера, проверьте доступные свидетельства и решите сами.",
    installLive:
      "Loomrail использует существующий подписочный login локального CLI. Отсутствующий, несовместимый или неавторизованный CLI блокирует dispatch; provider API key не нужен.",
    runtimeLabel: "Среда запуска",
    runtimeValue: "Node.js 24.19–24.x",
    networkLabel: "Локальный интерфейс",
    networkValue: "Только 127.0.0.1",
    firstRunLabel: "Первый запуск",
    firstRunValue: "Preflight локального CLI",
    platformLabel: "Платформы",
    platformValue: "macOS Apple Silicon",

    boundaryTitle: "Что умеет Stable-релиз для macOS",
    boundaryIntro: `Loomrail ${productVersion} — Stable для macOS на Apple Silicon. Windows и Linux не входят в support target этого релиза и продолжают fail closed.`,
    todayTitle: "Доступно сейчас",
    todayLocal: "Браузер на той же машине, loopback daemon и локальное состояние SQLite.",
    todayProviders:
      "Адаптеры Codex CLI и Claude Code CLI с fail-closed проверкой версии/login и ограниченными workspace tools.",
    todayRecovery: "Восстановление после перезапуска, Human Requests, бюджеты, доказательства и Decisions.",
    todayRepo: "Свои репозитории, отдельные worktree, TypeScript/Node-шаблон и просмотр изменений.",
    notYetTitle: "Пока не обещаем",
    notCloud: "Cloud sync, удалённый доступ, mobile control или командные аккаунты.",
    notDesktop: "Live-provider support на Windows/Linux, автоматические обновления или desktop installer.",
    notGit: "Автоматические commit, push, merge, deploy или browser execution.",
    notSandbox: "Полный OS-level sandbox для живых providers.",

    docsTitle: "Документация",
    docsIntro:
      "Войдите через официальный локальный CLI, пройдите preflight и только потом регистрируйте репозиторий после чтения threat model.",
    docsNavigation: "Документация Loomrail",
    quickStartTitle: "Быстрый старт",
    quickStartBody: "От пустого каталога до ограниченной задачи реального провайдера.",
    userGuideTitle: "Руководство владельца",
    userGuideBody: "Репозитории, провайдеры, восстановление, бэкап, диагностика.",
    fullRouteTitle: "Full-route пример",
    fullRouteBody: "Ограниченный репозиторий и воспроизводимая живая задача.",
    securityTitle: "Модель угроз",
    securityBody: "Границы доверия, High и Critical угрозы, проверенные меры.",
    architectureTitle: "Архитектура",
    architectureBody: "Владение доменом, persistence, providers и delivery.",
    sourceTitle: "Исходный код",
    sourceBody: "Прочитать, собрать или завести issue на GitHub.",

    heroPlatform: "Codex CLI + Claude Code · macOS Apple Silicon",
    heroSource: "Посмотреть исходники →",
    navStarters: "Шаблоны",
    routeCaption: "Одна задача. Шесть этапов. Раскройте любой.",
    routeNote: "Схема процесса, не живой запуск. Этапами управляет Loomrail, работу выполняют агенты.",
    route0Title: "Разобраться в задаче",
    route0Body: "Уточнить цель, задать вопросы и согласовать критерии приёмки до начала реализации.",
    route1Title: "Составить конкретный план",
    route1Body:
      "Разложить задачу на части, зависимости и проверки. Закрепить объём работы и разрешённые действия.",
    route2Title: "Передать агенту ограниченную рабочую область",
    route2Body:
      "Агент пишет код в согласованной рабочей области. Изменения и действия инструментов остаются в истории задачи.",
    route3Title: "Получить независимое ревью",
    route3Body:
      "Отдельный запуск ревьюера проверяет изменения. Замечания возвращают задачу на доработку; автор не одобряет собственный код.",
    route4Title: "Проверить работающий результат",
    route4Body:
      "Выполнить согласованные проверки проекта и реальные браузерные сценарии. Сохранить отчёты, связанные с текущими изменениями.",
    route5Title: "Решение остаётся за вами",
    route5Body:
      "Изучить пакет приёмки, принять результат или вернуть в работу. Агент не может принять собственную работу.",
    howArchitecture: "Как устроена оркестрация →",
    ownerTitle: "Вы задаёте направление",
    ownerBody:
      "Определяете результат, отвечаете на вопросы, утверждаете ограничения и принимаете работу — или возвращаете на доработку.",
    engineTitle: "Loomrail управляет процессом",
    engineBody:
      "Переходы между этапами, разрешения, лимиты сессий, вопросы и восстановление контролирует локальный движок, а не сообщение модели «готово».",
    workerTitle: "Codex и Claude выполняют работу",
    workerBody:
      "Планирование, реализация, независимое ревью и QA идут через поддерживаемые локальные CLI с вашим входом. Сетевые запросы к провайдерам выполняют эти CLI.",
    researchTitle: "Дальше — планировщик без доступа к коду",
    researchBody:
      "Astra/Fable для планирования и Luna/Sonnet для исполнения — пока исследование, не готовый режим. Планировщик должен получать короткие отчёты, а не файлы репозитория. Экономию токенов ещё предстоит измерить.",
    researchLink: "Исследование архитектуры →",
    startersTitle: "Начните со своего кода. Или с чистого листа.",
    startersIntro:
      "Подключите репозиторий, создайте небольшой TypeScript-проект или изучите процесс на отдельном демо.",
    starterRecipe: "Встроенный бойлерплейт · typescript-node@1",
    starterNewTitle: "Стартовый проект без сюрпризов.",
    starterNewBody:
      "Посмотрите список файлов, подтвердите каталог и создайте новый Git-репозиторий на Node ESM + TypeScript. Это обычный код: для работы проекта Loomrail не нужен.",
    starterNewLimit:
      "Сейчас встроен один шаблон. Без скачивания шаблонов, автоматической установки зависимостей, коммитов и push.",
    starterRecipeLink: "Посмотреть шаблон →",
    starterFiles: "Что будет в проекте",
    starterFilesNote: "Предпросмотр → ваше подтверждение → новый проект",
    starterExistingTitle: "Уже есть репозиторий",
    starterExistingBody:
      "Подключите локальный Git-репозиторий. Запустите задачу в отдельном worktree и проверьте изменения перед приёмкой.",
    starterExistingLink: "Подключить репозиторий →",
    starterDemoTitle: "Хочется сначала попробовать",
    starterDemoBody:
      "Пройдите маршрут /try и примеры веб-приложения и API, не подключая свой код. Запуск агента всё равно расходует квоту провайдера.",
    starterDemoLink: "Начать с демо →",
    footerClosing: "От постановки — к проверяемому результату.",

    footerNavigation: "Навигация в подвале",
    footerTagline: "Локальное состояние. Приёмка человеком.",
    footerSource: "Исходники",
    footerIssues: "Issues",
    footerDocs: "Документация",
  },
} as const;

type MessageKey = keyof (typeof messages)["en"];

const docDestinations = {
  en: {
    "quick-start": "https://github.com/loomrail/loomrail/blob/main/docs/guides/GETTING-STARTED.md",
    "user-guide": "https://github.com/loomrail/loomrail/blob/main/docs/guides/USER-GUIDE.md",
    "full-route": "https://github.com/loomrail/loomrail/tree/main/docs/examples/full-route",
  },
  ru: {
    "quick-start": "https://github.com/loomrail/loomrail/blob/main/docs/guides/GETTING-STARTED.ru.md",
    "user-guide": "https://github.com/loomrail/loomrail/blob/main/docs/guides/USER-GUIDE.ru.md",
    "full-route": "https://github.com/loomrail/loomrail/tree/main/docs/examples/full-route",
  },
} as const;

function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "ru";
}

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

function isMessageKey(value: string | undefined): value is MessageKey {
  return value !== undefined && value in messages.en;
}

function safeStorageRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageWrite(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // The public page remains usable when storage is blocked.
  }
}

function localeFor(doc: Document): Locale {
  return doc.documentElement.lang === "ru" ? "ru" : "en";
}

function message(doc: Document, key: MessageKey): string {
  return messages[localeFor(doc)][key];
}

function setupActivationContract(doc: Document): void {
  for (const code of doc.querySelectorAll<HTMLElement>("[data-install-commands]")) {
    const lines = installCommands.map((command, index) => {
      const line = doc.createElement("span");
      line.className = index === installCommands.length - 1 ? "line line-last" : "line";
      line.textContent = command;
      return line;
    });
    code.replaceChildren(...lines);
  }

  for (const version of doc.querySelectorAll<HTMLElement>("[data-product-version]")) {
    version.textContent = productVersion;
  }
}

function applyLocale(doc: Document, locale: Locale): void {
  doc.documentElement.lang = locale;
  const copy = messages[locale];

  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (isMessageKey(key)) element.textContent = copy[key];
  }
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = element.dataset["i18nAriaLabel"];
    if (isMessageKey(key)) element.setAttribute("aria-label", copy[key]);
  }
  for (const element of doc.querySelectorAll<HTMLImageElement>("[data-i18n-alt]")) {
    const key = element.dataset["i18nAlt"];
    if (isMessageKey(key)) element.alt = copy[key];
  }
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("[data-doc-link]")) {
    const destination = anchor.dataset["docLink"];
    if (destination === "quick-start" || destination === "user-guide" || destination === "full-route") {
      anchor.href = docDestinations[locale][destination];
    }
  }

  const localeButton = doc.querySelector<HTMLButtonElement>("[data-locale-toggle]");
  const localeLabel = localeButton?.querySelector<HTMLElement>("[data-locale-toggle-label]");
  if (localeButton !== null) {
    localeButton.dataset["nextLocale"] = locale === "en" ? "ru" : "en";
    localeButton.setAttribute("aria-label", locale === "en" ? copy.switchToRussian : copy.switchToEnglish);
  }
  if (localeLabel !== null && localeLabel !== undefined) {
    localeLabel.textContent = locale === "en" ? "RU" : "EN";
  }

  doc.title = copy.pageTitle;
  doc
    .querySelector<HTMLMetaElement>('meta[name="description"]')
    ?.setAttribute("content", copy.metaDescription);
  doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", copy.pageTitle);
  doc
    .querySelector<HTMLMetaElement>('meta[property="og:description"]')
    ?.setAttribute("content", copy.ogDescription);
  doc.dispatchEvent(new CustomEvent("loomrail:localechange"));
}

function setupLocale(doc: Document, win: Window): void {
  const stored = safeStorageRead(win.localStorage, localeStorageKey);
  const browserLocale: Locale = win.navigator.language.toLocaleLowerCase().startsWith("ru") ? "ru" : "en";
  applyLocale(doc, isLocale(stored) ? stored : browserLocale);

  doc.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.addEventListener("click", (event) => {
    const locale = (event.currentTarget as HTMLButtonElement).dataset["nextLocale"];
    if (!isLocale(locale)) return;
    applyLocale(doc, locale);
    safeStorageWrite(win.localStorage, localeStorageKey, locale);
  });
}

function applyTheme(doc: Document, theme: Theme): void {
  doc.documentElement.dataset["theme"] = theme;
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const label = button?.querySelector<HTMLElement>("[data-theme-label]");
  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  if (button !== null) {
    button.setAttribute("aria-label", message(doc, nextTheme === "dark" ? "switchToDark" : "switchToLight"));
  }
  if (label !== null && label !== undefined) {
    label.textContent = message(doc, nextTheme === "dark" ? "darkTheme" : "lightTheme");
  }
}

function setupTheme(doc: Document, win: Window): void {
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (button === null) return;

  const media = win.matchMedia("(prefers-color-scheme: dark)");
  const stored = safeStorageRead(win.localStorage, themeStorageKey);
  let followsSystem = !isTheme(stored);
  applyTheme(doc, isTheme(stored) ? stored : media.matches ? "dark" : "light");

  button.addEventListener("click", () => {
    const current: Theme = doc.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
    const next: Theme = current === "dark" ? "light" : "dark";
    followsSystem = false;
    applyTheme(doc, next);
    safeStorageWrite(win.localStorage, themeStorageKey, next);
  });
  media.addEventListener("change", (event) => {
    if (followsSystem) applyTheme(doc, event.matches ? "dark" : "light");
  });
  doc.addEventListener("loomrail:localechange", () => {
    applyTheme(doc, doc.documentElement.dataset["theme"] === "dark" ? "dark" : "light");
  });
}

function setCopyState(doc: Document, button: HTMLButtonElement, state: CopyState): void {
  button.dataset["state"] = state;
  button.disabled = state === "loading";
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  if (label === null) return;
  const key: MessageKey =
    state === "loading"
      ? "copying"
      : state === "success"
        ? "copied"
        : state === "error"
          ? "copyFailed"
          : "copy";
  label.textContent = message(doc, key);
}

function setupCopyButtons(doc: Document, win: Window): void {
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    button.dataset["copy"] = installCommand;
    setCopyState(doc, button, "idle");
    doc.addEventListener("loomrail:localechange", () => {
      const state = button.dataset["state"];
      setCopyState(
        doc,
        button,
        state === "loading" || state === "success" || state === "error" ? state : "idle",
      );
    });
    button.addEventListener("click", () => {
      const clipboard = Reflect.get(win.navigator, "clipboard") as Clipboard | undefined;
      if (clipboard === undefined) {
        setCopyState(doc, button, "error");
        win.setTimeout(() => {
          setCopyState(doc, button, "idle");
        }, 2200);
        return;
      }

      setCopyState(doc, button, "loading");
      void clipboard.writeText(installCommand).then(
        () => {
          setCopyState(doc, button, "success");
          win.setTimeout(() => {
            setCopyState(doc, button, "idle");
          }, 2500);
        },
        () => {
          setCopyState(doc, button, "error");
          win.setTimeout(() => {
            setCopyState(doc, button, "idle");
          }, 2200);
        },
      );
    });
  }
}

export function initializeLanding(doc: Document, win: Window): void {
  if (doc.documentElement.dataset["landingReady"] === "true") return;
  doc.documentElement.dataset["landingReady"] = "true";
  setupActivationContract(doc);
  setupLocale(doc, win);
  setupTheme(doc, win);
  setupCopyButtons(doc, win);
}

initializeLanding(document, window);
