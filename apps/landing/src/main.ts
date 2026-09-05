import "./styles.css";

type Theme = "light" | "dark";
type Locale = "en" | "ru";
type CopyState = "idle" | "loading" | "success" | "error";

const themeStorageKey = "loomrail-landing-theme";
const localeStorageKey = "loomrail-landing-locale";
const installCommand = [
  "mkdir loomrail-evaluation",
  "cd loomrail-evaluation",
  "npm install loomrail@next",
  "npx loomrail",
].join("\n");

const messages = {
  en: {
    pageTitle: "Loomrail — The task outlives the chat.",
    metaDescription:
      "A local control plane for accountable AI software work: durable task state, gates, evidence, budgets, and owner acceptance.",
    ogDescription:
      "Keep the brief, allowed actions, evidence, budgets, and owner decision in one local record.",
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

    heroTitle: "The task outlives the chat.",
    heroBody:
      "A local control plane for AI coding agents. The brief, the limits, the open questions and the final decision live in one durable record on your machine — not in a transcript that ends with the session.",
    heroPrimaryCta: "Install and run",
    heroSecondaryCta: "See how it works",
    heroNote: "Free and open source · Apache-2.0 · Runs entirely on your machine",
    heroShotCaption:
      "A real run of 0.1.0-alpha.2 against the deterministic mock: the task contract, a blocking Human Request, an approved budget increase, and the owner accepting the delivery.",
    demoAlt:
      "Screen recording of Loomrail: a task is created, the workflow blocks on a Human Request, a budget increase is approved, and the owner accepts the delivery",
    demoPlay: "Play the demo",

    promisesLabel: "What Loomrail never does",
    promiseCommit: "Never commits",
    promisePush: "Never pushes",
    promiseMerge: "Never merges",
    promiseDeploy: "Never deploys",
    promiseAccept: "You accept the delivery",

    whyTitle: "Chat is a poor place to keep a task.",
    whyBody:
      "A session ends, a process dies, a provider changes. Anything that lived only in the transcript goes with it. Loomrail moves the parts that matter out of the conversation and into a record that a deterministic state machine owns.",
    whyOneTitle: "Durable by default",
    whyOneBody:
      "State, requests, budgets, evidence and decisions are written to local SQLite in one transaction. Restart the daemon and the task is exactly where you left it.",
    whyTwoTitle: "Bounded by design",
    whyTwoBody:
      "Every task carries allowed actions and a spend limit. The agent works inside them, and raising a limit is an explicit decision that gets recorded.",
    whyThreeTitle: "You stay the owner",
    whyThreeBody:
      "An agent never closes its own task. Loomrail never commits, pushes, merges or deploys. The delivery is accepted or returned by a person.",

    howTitle: "How a task moves through Loomrail",
    howIntro:
      "Four steps, the same every time. The first run does all of this against a deterministic mock, so nothing is sent to a provider and nothing in your repository is touched.",
    stepOneTitle: "Write the task, not the prompt",
    stepOneBody:
      "A task states its outcome, its acceptance criteria, which actions the agent may take and how much it may spend. That contract is fixed before any work starts, and it is what the result is judged against later.",
    stepTwoTitle: "The agent works inside the limits",
    stepTwoBody:
      "Loomrail starts the provider session, watches the spend and advances the workflow state itself. The provider’s output is treated as input to that state machine, never as the source of truth about progress.",
    stepThreeTitle: "It stops and asks when it must",
    stepThreeBody:
      "When a decision needs a person, the agent raises a Human Request. The task blocks, the question stays attached to it, and your answer is recorded next to the work instead of scrolling away in a chat.",
    stepFourTitle: "You accept the delivery, or send it back",
    stepFourBody:
      "The task arrives with its evidence: the changes, the review, the QA result and any follow-up work it created. You inspect it and decide. Nothing is committed, pushed or merged for you.",

    chipReady: "Ready",
    chipBlocked: "Blocked",
    uiTaskTitle: "Persisted board integration",
    uiTaskDesc:
      "Verify project isolation, state transitions and activity through the authenticated local API.",
    uiAcceptance: "Acceptance",
    uiAcceptanceValue: "3 criteria",
    uiAllowed: "Allowed actions",
    uiAllowedValue: "Read, edit, run tests",
    uiBudget: "Budget",
    flowBacklog: "Backlog",
    flowReady: "Ready",
    flowRunning: "Running",
    flowReview: "Review",
    flowDone: "Accepted",
    uiWorkflowState: "Workflow state",
    uiSpend: "Spend",
    uiProvider: "Provider",
    uiProviderValue: "Deterministic mock",
    uiSession: "Session",
    uiSessionValue: "Restarted once, state kept",
    uiRequestLabel: "Human Request",
    uiQuestion:
      "Should the migration drop the legacy sessions table, or keep it read-only until the next release?",
    uiAnswer: "Answer",
    uiReturn: "Return to work",
    uiEvidence: "Evidence",
    uiChanges: "Changes",
    uiReview: "Review",
    uiReviewValue: "2 findings, both resolved",
    uiQa: "QA",
    uiQaValue: "84 checks passed",
    uiAccept: "Accept delivery",

    installTitle: "Try Loomrail without giving it a repository.",
    installIntro:
      "The first run uses a deterministic mock, binds to loopback, and does not start an agent. Start in a new empty directory, not inside a repository you care about.",
    installCommandLabel: "Install and launch Loomrail safely",
    copyInstallCommand: "Copy the safe install and launch commands",
    copy: "Copy",
    copying: "Copying…",
    copied: "Copied",
    copyFailed: "Failed",
    runStepOne: "Choose “Initialize demo workspace” in the browser tab that opens.",
    runStepTwo: "Create a task, move it to Ready and start the workflow.",
    runStepThree: "Answer the blocking Human Request and approve the budget increase.",
    runStepFour: "Inspect the evidence, then accept the delivery or return it.",
    installLive:
      "Live providers are opt-in. Install and authenticate the provider CLI yourself, then start the same installation with LOOMRAIL_PROVIDER=CODEX or LOOMRAIL_PROVIDER=CLAUDE_CODE.",
    runtimeLabel: "Runtime",
    runtimeValue: "Node.js 24.19–24.x",
    networkLabel: "Network",
    networkValue: "127.0.0.1 only",
    firstRunLabel: "First run",
    firstRunValue: "Deterministic mock",
    platformLabel: "Platforms",
    platformValue: "macOS, Windows, Linux",

    boundaryTitle: "What alpha.2 actually does",
    boundaryIntro:
      "Loomrail 0.1.0-alpha.2 is public pre-alpha. The second column is an honest list of what it does not do yet — not a roadmap.",
    todayTitle: "Available today",
    todayLocal: "Same-machine browser UI, loopback daemon, and local SQLite state.",
    todayProviders: "Deterministic mock, plus bounded Codex and Claude Code adapters.",
    todayRecovery: "Restart recovery, Human Requests, budgets, evidence, and Decisions.",
    todayRepo: "Repository registration, per-task worktrees, and change inspection.",
    notYetTitle: "Not claimed yet",
    notCloud: "Cloud sync, remote access, mobile control, or team accounts.",
    notDesktop: "Desktop packaging, automatic updates, or a desktop installer.",
    notGit: "Automatic commit, push, merge, deploy, or browser execution.",
    notSandbox: "A complete operating-system sandbox for live providers.",

    docsTitle: "Documentation",
    docsIntro:
      "Run the mock first. Register a repository second. Connect a live provider only after reading the threat model.",
    docsNavigation: "Loomrail documentation",
    quickStartTitle: "Quick start",
    quickStartBody: "From an empty directory to a persisted mock acceptance.",
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

    ctaTitle: "Start with the mock. It spends nothing.",
    ctaBody:
      "One command, a new empty directory, and a workflow that runs end to end without touching a repository or a provider account.",
    ctaAction: "Get the commands",
    sourceCta: "View the source",
    footerNavigation: "Footer navigation",
    footerTagline: "Local state. Human acceptance.",
    footerSource: "Source",
    footerIssues: "Issues",
    footerDocs: "Docs",
  },
  ru: {
    pageTitle: "Loomrail — задача не заканчивается вместе с чатом.",
    metaDescription:
      "Локальная панель управления работой AI-агентов: устойчивое состояние задач, контрольные точки, доказательства, бюджеты и приёмка владельцем.",
    ogDescription:
      "Храните постановку, разрешённые действия, доказательства, бюджеты и решение владельца в одной локальной записи.",
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

    heroTitle: "Задача не заканчивается вместе с чатом.",
    heroBody:
      "Локальная панель управления для AI-агентов, которые пишут код. Постановка, ограничения, открытые вопросы и финальное решение живут в одной устойчивой записи на вашей машине, а не в переписке, которая заканчивается вместе с сессией.",
    heroPrimaryCta: "Установить и запустить",
    heroSecondaryCta: "Как это работает",
    heroNote: "Открытый исходный код · Apache-2.0 · Работает полностью на вашей машине",
    heroShotCaption:
      "Реальный прогон 0.1.0-alpha.2 на детерминированном mock: контракт задачи, блокирующий Human Request, подтверждение бюджета и приёмка владельцем.",
    demoAlt:
      "Запись экрана Loomrail: создаётся задача, workflow блокируется на Human Request, подтверждается увеличение бюджета, владелец принимает поставку",
    demoPlay: "Запустить демо",

    promisesLabel: "Чего Loomrail не делает",
    promiseCommit: "Не коммитит",
    promisePush: "Не пушит",
    promiseMerge: "Не мержит",
    promiseDeploy: "Не деплоит",
    promiseAccept: "Поставку принимаете вы",

    whyTitle: "Чат — плохое место для задачи.",
    whyBody:
      "Сессия заканчивается, процесс падает, провайдер меняется. Всё, что жило только в переписке, уходит вместе с ней. Loomrail выносит важное из разговора в запись, которой управляет детерминированный конечный автомат.",
    whyOneTitle: "Устойчиво по умолчанию",
    whyOneBody:
      "Состояние, запросы, бюджеты, доказательства и решения пишутся в локальный SQLite одной транзакцией. После перезапуска задача ровно там, где вы её оставили.",
    whyTwoTitle: "Ограничено по проекту",
    whyTwoBody:
      "У каждой задачи есть разрешённые действия и лимит трат. Агент работает внутри них, а повышение лимита — явное решение, которое записывается.",
    whyThreeTitle: "Владелец — вы",
    whyThreeBody:
      "Агент никогда не закрывает свою задачу сам. Loomrail не коммитит, не пушит, не мержит и не деплоит. Поставку принимает или возвращает человек.",

    howTitle: "Как задача проходит через Loomrail",
    howIntro:
      "Четыре шага, каждый раз одинаковых. Первый запуск проходит их на детерминированном mock: ничего не уходит провайдеру и ничего в вашем репозитории не меняется.",
    stepOneTitle: "Пишете задачу, а не промпт",
    stepOneBody:
      "Задача описывает результат, критерии приёмки, разрешённые действия и лимит трат. Этот контракт фиксируется до начала работы, и именно по нему потом оценивается результат.",
    stepTwoTitle: "Агент работает внутри ограничений",
    stepTwoBody:
      "Loomrail запускает сессию провайдера, следит за тратами и сам двигает состояние workflow. Вывод провайдера — это вход для конечного автомата, а не источник истины о прогрессе.",
    stepThreeTitle: "Останавливается и спрашивает, когда нужно",
    stepThreeBody:
      "Когда решение требует человека, агент создаёт Human Request. Задача блокируется, вопрос остаётся прикреплённым к ней, а ваш ответ записывается рядом с работой, а не уезжает вверх по переписке.",
    stepFourTitle: "Вы принимаете поставку или возвращаете её",
    stepFourBody:
      "Задача приходит с доказательствами: изменения, ревью, результат QA и созданные ею последующие задачи. Вы смотрите и решаете. Ничего не коммитится, не пушится и не мержится за вас.",

    chipReady: "Ready",
    chipBlocked: "Blocked",
    uiTaskTitle: "Persisted board integration",
    uiTaskDesc:
      "Проверить изоляцию проектов, переходы состояний и активность через аутентифицированный локальный API.",
    uiAcceptance: "Приёмка",
    uiAcceptanceValue: "3 критерия",
    uiAllowed: "Разрешено",
    uiAllowedValue: "Чтение, правки, тесты",
    uiBudget: "Бюджет",
    flowBacklog: "Backlog",
    flowReady: "Ready",
    flowRunning: "Running",
    flowReview: "Review",
    flowDone: "Accepted",
    uiWorkflowState: "Состояние workflow",
    uiSpend: "Потрачено",
    uiProvider: "Провайдер",
    uiProviderValue: "Детерминированный mock",
    uiSession: "Сессия",
    uiSessionValue: "Перезапущена, состояние сохранено",
    uiRequestLabel: "Human Request",
    uiQuestion:
      "Удалять ли в миграции старую таблицу sessions или оставить её только для чтения до следующего релиза?",
    uiAnswer: "Ответить",
    uiReturn: "Вернуть в работу",
    uiEvidence: "Доказательства",
    uiChanges: "Изменения",
    uiReview: "Ревью",
    uiReviewValue: "2 замечания, оба закрыты",
    uiQa: "QA",
    uiQaValue: "84 проверки пройдено",
    uiAccept: "Принять поставку",

    installTitle: "Попробуйте Loomrail без доступа к репозиторию.",
    installIntro:
      "Первый запуск использует детерминированный mock, слушает только loopback и не запускает агента. Начните в новом пустом каталоге, а не внутри репозитория, который вам дорог.",
    installCommandLabel: "Безопасная установка и запуск Loomrail",
    copyInstallCommand: "Скопировать безопасные команды установки и запуска",
    copy: "Копировать",
    copying: "Копируем…",
    copied: "Скопировано",
    copyFailed: "Ошибка",
    runStepOne: "Выберите «Initialize demo workspace» во вкладке, которая откроется.",
    runStepTwo: "Создайте задачу, переведите её в Ready и запустите workflow.",
    runStepThree: "Ответьте на блокирующий Human Request и подтвердите увеличение бюджета.",
    runStepFour: "Посмотрите доказательства и примите поставку либо верните её в работу.",
    installLive:
      "Живые провайдеры подключаются явно. Установите и авторизуйте CLI провайдера сами, затем запустите ту же установку с LOOMRAIL_PROVIDER=CODEX или LOOMRAIL_PROVIDER=CLAUDE_CODE.",
    runtimeLabel: "Runtime",
    runtimeValue: "Node.js 24.19–24.x",
    networkLabel: "Сеть",
    networkValue: "Только 127.0.0.1",
    firstRunLabel: "Первый запуск",
    firstRunValue: "Детерминированный mock",
    platformLabel: "Платформы",
    platformValue: "macOS, Windows, Linux",

    boundaryTitle: "Что alpha.2 действительно умеет",
    boundaryIntro:
      "Loomrail 0.1.0-alpha.2 — публичная pre-alpha. Вторая колонка — честный список того, чего он пока не делает, а не дорожная карта.",
    todayTitle: "Доступно сейчас",
    todayLocal: "Браузер на той же машине, loopback daemon и локальное состояние SQLite.",
    todayProviders: "Детерминированный mock и ограниченные адаптеры Codex и Claude Code.",
    todayRecovery: "Восстановление после перезапуска, Human Requests, бюджеты, доказательства и Decisions.",
    todayRepo: "Регистрация репозитория, worktree на задачу и просмотр изменений.",
    notYetTitle: "Пока не обещаем",
    notCloud: "Cloud sync, удалённый доступ, mobile control или командные аккаунты.",
    notDesktop: "Desktop packaging, автоматические обновления или desktop installer.",
    notGit: "Автоматические commit, push, merge, deploy или browser execution.",
    notSandbox: "Полный OS-level sandbox для живых providers.",

    docsTitle: "Документация",
    docsIntro:
      "Сначала запустите mock. Потом зарегистрируйте репозиторий. Живого провайдера подключайте только после чтения threat model.",
    docsNavigation: "Документация Loomrail",
    quickStartTitle: "Быстрый старт",
    quickStartBody: "От пустого каталога до сохранённой mock-приёмки.",
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

    ctaTitle: "Начните с mock. Он ничего не тратит.",
    ctaBody:
      "Одна команда, новый пустой каталог и workflow, который проходит целиком, не трогая ни репозиторий, ни аккаунт провайдера.",
    ctaAction: "Показать команды",
    sourceCta: "Открыть исходники",
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
  applyDemoTheme(doc, theme);
}

/** The hero demo ships one recording per theme, so a theme switch reloads the matching sources. */
function applyDemoTheme(doc: Document, theme: Theme): void {
  for (const video of doc.querySelectorAll<HTMLVideoElement>("[data-product-demo]")) {
    const wasPlaying = !video.paused;
    video.poster = `./demo/mock-route-${theme}.webp`;
    for (const source of video.querySelectorAll<HTMLSourceElement>("source[data-demo-format]")) {
      source.src = `./demo/mock-route-${theme}.${source.dataset["demoFormat"] ?? "webm"}`;
    }
    try {
      video.load();
    } catch {
      // Media is unavailable in this environment; the poster frame stands in for it.
    }
    if (wasPlaying) playDemo(video);
  }
}

/** Native controls do not belong on a looping hero; a blocked autoplay reveals our own button. */
function playDemo(video: HTMLVideoElement): void {
  const settle = (): void => {
    syncDemoTrigger(video);
  };
  try {
    const started: unknown = video.play();
    if (started instanceof Promise) started.then(settle, settle);
    else settle();
  } catch {
    settle();
  }
}

function syncDemoTrigger(video: HTMLVideoElement): void {
  const trigger = video.parentElement?.querySelector<HTMLButtonElement>("[data-demo-play]");
  if (trigger === null || trigger === undefined) return;
  trigger.hidden = !video.paused;
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

/** Walks the illustrated workflow pipeline so the "how it works" step shows movement, not a static diagram. */
function setupFlow(doc: Document, win: Window): void {
  const flow = doc.querySelector<HTMLElement>("[data-flow]");
  if (flow === null) return;
  const stages = [...flow.children];
  if (stages.length === 0) return;

  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = reduced ? Math.min(2, stages.length - 1) : 0;
  const paint = (): void => {
    stages.forEach((stage, index) => {
      stage.classList.toggle("is-current", index === current);
    });
  };

  paint();
  if (reduced) return;
  win.setInterval(() => {
    current = (current + 1) % stages.length;
    paint();
  }, 1700);
}

/** Autoplay is motion: a reader who asked for less of it gets the poster frame and real controls. */
function setupDemo(doc: Document, win: Window): void {
  const videos = doc.querySelectorAll<HTMLVideoElement>("[data-product-demo]");
  if (videos.length === 0) return;

  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const video of videos) {
    video.controls = false;
    video.addEventListener("play", () => {
      syncDemoTrigger(video);
    });
    video.addEventListener("pause", () => {
      syncDemoTrigger(video);
    });
    video.parentElement
      ?.querySelector<HTMLButtonElement>("[data-demo-play]")
      ?.addEventListener("click", () => {
        playDemo(video);
      });

    if (!reduced) {
      video.autoplay = true;
      playDemo(video);
    }
    syncDemoTrigger(video);
  }
}

/** Progressive enhancement: sections stay visible unless the browser can observe and animate them. */
function setupReveal(doc: Document, win: Window): void {
  const targets = doc.querySelectorAll<HTMLElement>("[data-reveal]");
  const observerFactory = Reflect.get(win, "IntersectionObserver") as typeof IntersectionObserver | undefined;
  if (targets.length === 0 || observerFactory === undefined) return;
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  doc.documentElement.dataset["motion"] = "ready";
  const observer = new observerFactory(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
  );
  for (const target of targets) observer.observe(target);
}

export function initializeLanding(doc: Document, win: Window): void {
  if (doc.documentElement.dataset["landingReady"] === "true") return;
  doc.documentElement.dataset["landingReady"] = "true";
  setupLocale(doc, win);
  setupTheme(doc, win);
  setupCopyButtons(doc, win);
  setupDemo(doc, win);
  setupFlow(doc, win);
  setupReveal(doc, win);
}

initializeLanding(document, window);
