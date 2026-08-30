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
    headerCta: "Run demo",
    languageLabel: "Language",
    switchToRussian: "Switch to Russian",
    switchToEnglish: "Switch to English",
    darkTheme: "Dark",
    lightTheme: "Light",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    releaseLine: "Version 0.1.0-alpha.2 · public pre-alpha",
    heroTitle: "The task outlives the chat.",
    heroBody:
      "Loomrail keeps the brief, allowed actions, requests, evidence, budgets, and final decision in one local record. Agent sessions can stop, restart, or change provider without rewriting the work.",
    quickStartCta: "Read quick start",
    sourceCta: "Inspect source",
    installTitle: "Try Loomrail without giving it a repository.",
    installIntro: "The first run uses a deterministic mock, binds to loopback, and does not start an agent.",
    installCommandLabel: "Install and launch Loomrail safely",
    copyInstallCommand: "Copy the safe install and launch commands",
    copy: "Copy commands",
    copying: "Copying…",
    copied: "Copied",
    copyFailed: "Copy failed",
    scopeLabel: "Directory",
    scopeValue: "New and empty",
    firstRunLabel: "First run",
    firstRunValue: "Deterministic mock",
    networkLabel: "Network",
    networkValue: "127.0.0.1 only",
    runtimeLabel: "Runtime",
    runtimeValue: "Node.js 24.19–24.x",
    productTitle: "The task, not the transcript.",
    productIntro:
      "The Workbench shows current state, the task contract, Human Requests, evidence, and the owner’s decision. Raw provider output stays diagnostic.",
    workbenchAlt:
      "Loomrail Workbench showing current work, a durable task, its state, and the owner activity trail",
    workbenchCaptionTitle: "Workbench",
    workbenchCaptionBody: "Current work, one durable task, and the actions that changed it.",
    ledgerTitle: "What survives a provider session?",
    ledgerIntro:
      "Provider output is input. Loomrail’s deterministic model owns workflow state and acceptance.",
    ledgerBrief: "Brief",
    ledgerBriefBody: "Acceptance criteria, workflow version, permissions, and budget.",
    ledgerRequests: "Human Requests",
    ledgerRequestsBody: "Questions that need a person stay attached to the task.",
    ledgerEvidence: "Evidence",
    ledgerEvidenceBody: "Changes, review, QA, and durable follow-up work.",
    ledgerDecision: "Decision",
    ledgerDecisionBody: "Only the owner accepts the delivery or returns it to work.",
    boundaryTitle: "What does alpha.2 actually do?",
    boundaryIntro: "The boundary is part of the product, not release-note fine print.",
    todayTitle: "Available in alpha.2",
    todayLocal: "Same-machine browser UI, loopback daemon, and local SQLite state.",
    todayProviders: "Deterministic mock, plus bounded Codex and Claude Code adapters.",
    todayRecovery: "Restart recovery, Human Requests, budgets, evidence, and Decisions.",
    todayRepo: "Repository registration and an owner-approved Project Constitution.",
    notYetTitle: "Deliberately not claimed",
    notCloud: "Cloud sync, remote access, mobile control, or team accounts.",
    notDesktop: "Desktop packaging, automatic updates, or a desktop installer.",
    notGit: "Automatic commit, push, merge, deploy, or browser execution.",
    notSandbox: "A complete operating-system sandbox for live providers.",
    docsTitle: "Where should I start?",
    docsIntro:
      "Run the mock first. Register a repository second. Connect a provider only after reading the boundary.",
    docsNavigation: "Loomrail documentation",
    quickStartTitle: "Quick start",
    quickStartBody: "Empty directory to persisted mock acceptance.",
    userGuideTitle: "Owner guide",
    userGuideBody: "Repositories, providers, recovery, backup, and troubleshooting.",
    fullRouteTitle: "Full-route example",
    fullRouteBody: "A bounded repository and a reproducible live task.",
    securityTitle: "Security model",
    securityBody: "Trust boundaries, High/Critical threats, and verified controls.",
    architectureTitle: "Architecture",
    architectureBody: "Domain ownership, persistence, providers, and delivery.",
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
    headerCta: "Демо",
    languageLabel: "Язык",
    switchToRussian: "Переключить на русский",
    switchToEnglish: "Переключить на английский",
    darkTheme: "Тёмная",
    lightTheme: "Светлая",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",
    releaseLine: "Версия 0.1.0-alpha.2 · публичный pre-alpha",
    heroTitle: "Задача не заканчивается вместе с чатом.",
    heroBody:
      "Loomrail хранит постановку, разрешённые действия, запросы, доказательства, бюджеты и финальное решение в одной локальной записи. Сессию агента можно остановить, восстановить или сменить, не переписывая работу.",
    quickStartCta: "Открыть быстрый старт",
    sourceCta: "Изучить исходники",
    installTitle: "Попробуйте Loomrail без доступа к репозиторию.",
    installIntro:
      "Первый запуск использует детерминированный mock, слушает только loopback и не запускает агента.",
    installCommandLabel: "Безопасная установка и запуск Loomrail",
    copyInstallCommand: "Скопировать безопасные команды установки и запуска",
    copy: "Копировать",
    copying: "Копируем…",
    copied: "Скопировано",
    copyFailed: "Не скопировано",
    scopeLabel: "Каталог",
    scopeValue: "Новый и пустой",
    firstRunLabel: "Первый запуск",
    firstRunValue: "Детерминированный mock",
    networkLabel: "Сеть",
    networkValue: "Только 127.0.0.1",
    runtimeLabel: "Runtime",
    runtimeValue: "Node.js 24.19–24.x",
    productTitle: "Задача, а не переписка.",
    productIntro:
      "Workbench показывает текущее состояние, контракт задачи, Human Requests, доказательства и решение владельца. Сырой вывод провайдера остаётся диагностикой.",
    workbenchAlt:
      "Workbench Loomrail с текущей работой, устойчивой задачей, её состоянием и историей действий владельца",
    workbenchCaptionTitle: "Workbench",
    workbenchCaptionBody: "Текущая работа, одна устойчивая задача и действия, которые её изменили.",
    ledgerTitle: "Что переживает сессию провайдера?",
    ledgerIntro:
      "Вывод провайдера — это входные данные. Состоянием workflow и приёмкой управляет детерминированная модель Loomrail.",
    ledgerBrief: "Постановка",
    ledgerBriefBody: "Критерии приёмки, версия workflow, разрешения и бюджет.",
    ledgerRequests: "Human Requests",
    ledgerRequestsBody: "Вопросы, требующие ответа человека, остаются рядом с задачей.",
    ledgerEvidence: "Доказательства",
    ledgerEvidenceBody: "Изменения, ревью, QA и устойчивые последующие задачи.",
    ledgerDecision: "Решение",
    ledgerDecisionBody: "Только владелец принимает поставку или возвращает её в работу.",
    boundaryTitle: "Что на самом деле умеет alpha.2?",
    boundaryIntro: "Границы — часть продукта, а не мелкий шрифт в release notes.",
    todayTitle: "Доступно в alpha.2",
    todayLocal: "Браузер на той же машине, loopback daemon и локальное состояние SQLite.",
    todayProviders: "Детерминированный mock и ограниченные адаптеры Codex и Claude Code.",
    todayRecovery: "Восстановление после перезапуска, Human Requests, бюджеты, доказательства и Decisions.",
    todayRepo: "Регистрация репозитория и Project Constitution с одобрением владельца.",
    notYetTitle: "Намеренно не обещаем",
    notCloud: "Cloud sync, удалённый доступ, mobile control или командные аккаунты.",
    notDesktop: "Desktop packaging, автоматические обновления или desktop installer.",
    notGit: "Автоматические commit, push, merge, deploy или browser execution.",
    notSandbox: "Полный OS-level sandbox для живых providers.",
    docsTitle: "С чего начать?",
    docsIntro:
      "Сначала запустите mock. Затем зарегистрируйте репозиторий. Подключайте провайдера только после чтения границ.",
    docsNavigation: "Документация Loomrail",
    quickStartTitle: "Быстрый старт",
    quickStartBody: "От пустого каталога до сохранённой mock-приёмки.",
    userGuideTitle: "Руководство владельца",
    userGuideBody: "Репозитории, providers, recovery, backup и troubleshooting.",
    fullRouteTitle: "Full-route пример",
    fullRouteBody: "Ограниченный репозиторий и воспроизводимая живая задача.",
    securityTitle: "Модель безопасности",
    securityBody: "Границы доверия, High/Critical угрозы и проверенные controls.",
    architectureTitle: "Архитектура",
    architectureBody: "Владение доменом, persistence, providers и delivery.",
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
  for (const image of doc.querySelectorAll<HTMLImageElement>("[data-product-image]")) {
    image.src = `./screenshots/workbench-${theme}.png`;
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
  setupLocale(doc, win);
  setupTheme(doc, win);
  setupCopyButtons(doc, win);
}

initializeLanding(document, window);
