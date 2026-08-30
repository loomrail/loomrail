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
    pageTitle: "Loomrail — The local control plane for accountable AI software teams.",
    metaDescription:
      "The local control plane for accountable AI software teams: durable workflow state, evidence, budgets, decisions, and owner acceptance.",
    ogDescription:
      "Keep the brief, workflow, evidence, budgets, decisions, and final acceptance intact across agent sessions.",
    skipLink: "Skip to content",
    primaryNavigation: "Primary navigation",
    homeLabel: "Loomrail home",
    headerCta: "Run alpha.2 →",
    languageLabel: "Language",
    lightTheme: "Light",
    darkTheme: "Dark",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    heroTitle: "The local control plane for accountable AI software teams",
    installTitle: "Start with the route that cannot touch your repo.",
    installIntro:
      "The default mock proves the local workflow, durable state, and owner acceptance without starting Codex or Claude Code.",
    recommendedPath: "Recommended · project-local",
    copyInstallCommand: "Copy the install and launch commands",
    copy: "Copy",
    copying: "Copying…",
    copied: "Copied",
    copyFailed: "Copy failed",
    runtimeLabel: "Runtime",
    platformLabel: "Platforms",
    platformValue: "macOS · Windows",
    networkLabel: "Network",
    networkValue: "Loopback only",
    firstRunLabel: "First run",
    firstRunValue: "Deterministic mock",
    quickStartCta: "Complete the safe route →",
    sourceCta: "View source ↗",
    ownershipTitle: "The workflow belongs to Loomrail, not the chat.",
    ownershipIntro:
      "Provider output is untrusted input. The deterministic domain model owns state, permissions, budgets, gates, and acceptance.",
    briefKey: "Brief",
    briefTitle: "Define observable done.",
    briefBody:
      "The brief, acceptance criteria, workflow version, permissions, and budget become one durable task contract.",
    requestKey: "Request",
    requestTitle: "Stop at the real fork.",
    requestBody:
      "A missing decision becomes a typed Human Request. The answer is attributable and survives restart.",
    evidenceKey: "Evidence",
    evidenceTitle: "Show the work against the criteria.",
    evidenceBody:
      "Review, QA, changes, provider sessions, and recovery events stay attached to the task that produced them.",
    decisionKey: "Decision",
    decisionTitle: "Keep done owner-only.",
    decisionBody: "The agent may finish a run. Only the owner can accept the delivery or return it to work.",
    workbenchTitle: "One task carries the whole decision trail.",
    workbenchIntro:
      "The board stays compact. Open a task to inspect its contract, live requests, budgets, changes, evidence, and acceptance history.",
    workbenchAlt: "Loomrail Workbench with a delivery board, task inspector, changes, and activity history",
    proofOne: "The board indexes delivery state.",
    proofTwo: "The task opens the control surface.",
    proofThree: "Evidence and Decisions persist.",
    controlLoopTitle: "Agent output is input, not acceptance.",
    controlLoopIntro:
      "The route can pause, recover, or change provider without turning provider narration into product truth.",
    controlLoopLabel: "The Loomrail control loop",
    loopBrief: "Brief",
    loopBriefNote: "criteria · budget · permissions",
    loopWork: "Agent work",
    loopWorkNote: "sessions · requests · recovery",
    loopEvidence: "Evidence",
    loopEvidenceNote: "changes · review · QA",
    loopDecision: "Owner Decision",
    loopAccept: "Accept",
    loopReturn: "Return to work",
    gitBoundary:
      "No automatic commit, push, merge, or deploy. A worktree is isolation between tasks, not an OS sandbox.",
    boundaryTitle: "An alpha should say where it stops.",
    boundaryIntro: "The current package is useful, public, and deliberately bounded.",
    todayTitle: "Available today",
    todayLocal: "Same-machine browser UI, loopback daemon, and local SQLite state.",
    todayProviders: "Deterministic mock, Codex across six stages, Claude Code across three.",
    todayRecovery: "Restart recovery, typed Human Requests, budgets, evidence, and Decisions.",
    todayRepo: "Repository registration and owner-approved Project Constitution.",
    notYetTitle: "Not claimed in alpha.2",
    notCloud: "Cloud sync, remote access, mobile control, or team accounts.",
    notDesktop: "Desktop packaging, automatic updates, or a desktop installer.",
    notGit: "Automatic commit, push, merge, deploy, or browser execution.",
    notSandbox: "A complete operating-system security sandbox for live providers.",
    docsTitle: "Read the operating manual before the first live run.",
    docsIntro: "Start with mock. Add a repository. Then connect a provider with the boundary open.",
    docsNavigation: "Loomrail documentation",
    quickStartTitle: "Quick start",
    quickStartBody: "Empty directory to persisted mock acceptance.",
    userGuideTitle: "Owner guide",
    userGuideBody: "Repository, providers, recovery, backup, and troubleshooting.",
    fullRouteTitle: "Full-route example",
    fullRouteBody: "A bounded repository and reproducible live task.",
    securityTitle: "Security model",
    securityBody: "Trust boundaries, High/Critical threats, and verified controls.",
    architectureTitle: "Architecture",
    architectureBody: "Domain ownership, persistence, providers, and delivery.",
    footerRelease: "PUBLIC PRE-ALPHA",
    footerLocal: "LOCAL LOOPBACK",
    footerTelemetry: "NO TELEMETRY",
    footerAcceptance: "HUMAN ACCEPTANCE REQUIRED",
    footerSource: "SOURCE ↗",
    footerIssues: "ISSUES ↗",
  },
  ru: {
    pageTitle: "Loomrail — локальный центр управления ответственной работой AI-команды.",
    metaDescription:
      "Локальный центр управления ответственной работой AI-команды: устойчивый workflow, evidence, бюджеты, решения и приёмка владельцем.",
    ogDescription:
      "Brief, workflow, evidence, бюджеты, решения и итоговая приёмка сохраняются между сессиями агентов.",
    skipLink: "К содержимому",
    primaryNavigation: "Основная навигация",
    homeLabel: "Главная Loomrail",
    headerCta: "Запустить alpha.2 →",
    languageLabel: "Язык",
    lightTheme: "Светлая",
    darkTheme: "Тёмная",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",
    heroTitle: "Локальный центр управления ответственной работой AI-команды",
    installTitle: "Начните с маршрута, который не тронет ваш репозиторий.",
    installIntro:
      "Mock по умолчанию проверяет локальный workflow, устойчивое состояние и приёмку владельцем, не запуская Codex или Claude Code.",
    recommendedPath: "Рекомендуем · локально в проекте",
    copyInstallCommand: "Скопировать команды установки и запуска",
    copy: "Копировать",
    copying: "Копируем…",
    copied: "Скопировано",
    copyFailed: "Не скопировано",
    runtimeLabel: "Runtime",
    platformLabel: "Платформы",
    platformValue: "macOS · Windows",
    networkLabel: "Сеть",
    networkValue: "Только loopback",
    firstRunLabel: "Первый запуск",
    firstRunValue: "Детерминированный mock",
    quickStartCta: "Пройти безопасный маршрут →",
    sourceCta: "Открыть исходники ↗",
    ownershipTitle: "Workflow принадлежит Loomrail, а не чату.",
    ownershipIntro:
      "Вывод provider — недоверенный вход. Детерминированная доменная модель владеет состоянием, правами, бюджетами, gates и приёмкой.",
    briefKey: "Brief",
    briefTitle: "Опишите наблюдаемый результат.",
    briefBody:
      "Brief, критерии приёмки, версия workflow, права и бюджет становятся одним устойчивым контрактом задачи.",
    requestKey: "Запрос",
    requestTitle: "Остановитесь в точке решения.",
    requestBody:
      "Недостающее решение становится типизированным Human Request. Ответ атрибутирован и переживает restart.",
    evidenceKey: "Evidence",
    evidenceTitle: "Покажите работу по критериям.",
    evidenceBody:
      "Review, QA, изменения, provider sessions и recovery-события остаются прикреплены к породившей их задаче.",
    decisionKey: "Решение",
    decisionTitle: "Оставьте Done только владельцу.",
    decisionBody: "Агент может завершить run. Только владелец принимает поставку или возвращает её в работу.",
    workbenchTitle: "Одна задача хранит весь след решения.",
    workbenchIntro:
      "Доска остаётся компактной. Откройте задачу, чтобы проверить контракт, запросы, бюджеты, изменения, evidence и историю приёмки.",
    workbenchAlt: "Workbench Loomrail с доской поставки, inspector задачи, изменениями и историей активности",
    proofOne: "Доска индексирует состояние поставки.",
    proofTwo: "Задача открывает поверхность управления.",
    proofThree: "Evidence и Decisions сохраняются.",
    controlLoopTitle: "Вывод агента — вход, а не приёмка.",
    controlLoopIntro:
      "Маршрут может остановиться, восстановиться или сменить provider, не превращая его рассказ в продуктовую истину.",
    controlLoopLabel: "Контур управления Loomrail",
    loopBrief: "Brief",
    loopBriefNote: "критерии · бюджет · права",
    loopWork: "Работа агента",
    loopWorkNote: "сессии · запросы · recovery",
    loopEvidence: "Evidence",
    loopEvidenceNote: "изменения · review · QA",
    loopDecision: "Решение владельца",
    loopAccept: "Принять",
    loopReturn: "Вернуть в работу",
    gitBoundary:
      "Нет автоматических commit, push, merge или deploy. Worktree изолирует задачи, но не является OS sandbox.",
    boundaryTitle: "Alpha должна честно говорить, где она заканчивается.",
    boundaryIntro: "Текущий пакет полезен, публичен и намеренно ограничен.",
    todayTitle: "Доступно сегодня",
    todayLocal: "Браузер на той же машине, loopback daemon и локальное состояние SQLite.",
    todayProviders: "Детерминированный mock, Codex на шести стадиях, Claude Code на трёх.",
    todayRecovery: "Recovery после restart, Human Requests, бюджеты, evidence и Decisions.",
    todayRepo: "Регистрация репозитория и Project Constitution с одобрением владельца.",
    notYetTitle: "Не обещаем в alpha.2",
    notCloud: "Cloud sync, удалённый доступ, mobile control или командные аккаунты.",
    notDesktop: "Desktop packaging, автоматические обновления или desktop installer.",
    notGit: "Автоматические commit, push, merge, deploy или browser execution.",
    notSandbox: "Полный OS-level security sandbox для живых providers.",
    docsTitle: "Прочитайте operating manual до первого живого запуска.",
    docsIntro: "Начните с mock. Добавьте репозиторий. Затем подключите provider, не пряча границы.",
    docsNavigation: "Документация Loomrail",
    quickStartTitle: "Быстрый старт",
    quickStartBody: "От пустого каталога до сохранённой mock-приёмки.",
    userGuideTitle: "Руководство владельца",
    userGuideBody: "Репозиторий, providers, recovery, backup и troubleshooting.",
    fullRouteTitle: "Full-route пример",
    fullRouteBody: "Ограниченный репозиторий и воспроизводимая живая задача.",
    securityTitle: "Модель безопасности",
    securityBody: "Границы доверия, High/Critical угрозы и проверенные controls.",
    architectureTitle: "Архитектура",
    architectureBody: "Владение доменом, persistence, providers и delivery.",
    footerRelease: "ПУБЛИЧНЫЙ PRE-ALPHA",
    footerLocal: "ЛОКАЛЬНЫЙ LOOPBACK",
    footerTelemetry: "БЕЗ ТЕЛЕМЕТРИИ",
    footerAcceptance: "ПРИЁМКА ЧЕЛОВЕКОМ ОБЯЗАТЕЛЬНА",
    footerSource: "ИСХОДНИКИ ↗",
    footerIssues: "ISSUES ↗",
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
    // The landing remains usable when storage is blocked.
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
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
    button.setAttribute("aria-pressed", String(button.dataset["locale"] === locale));
  }
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("[data-doc-link]")) {
    const destination = anchor.dataset["docLink"];
    if (destination === "quick-start" || destination === "user-guide" || destination === "full-route") {
      anchor.href = docDestinations[locale][destination];
    }
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
  const initial = isLocale(stored) ? stored : browserLocale;
  applyLocale(doc, initial);

  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
    button.addEventListener("click", () => {
      const locale = button.dataset["locale"];
      if (!isLocale(locale)) return;
      applyLocale(doc, locale);
      safeStorageWrite(win.localStorage, localeStorageKey, locale);
    });
  }
}

function applyTheme(doc: Document, theme: Theme): void {
  doc.documentElement.dataset["theme"] = theme;
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const label = button?.querySelector<HTMLElement>("[data-theme-label]");
  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  if (button !== null)
    button.setAttribute("aria-label", message(doc, nextTheme === "dark" ? "switchToDark" : "switchToLight"));
  if (label !== null && label !== undefined) {
    label.textContent = message(doc, nextTheme === "dark" ? "darkTheme" : "lightTheme");
  }
  const image = doc.querySelector<HTMLImageElement>("[data-product-image]");
  if (image !== null) image.src = `./screenshots/workbench-${theme}.png`;
}

function setupTheme(doc: Document, win: Window): void {
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (button === null) return;

  const media = win.matchMedia("(prefers-color-scheme: dark)");
  const stored = safeStorageRead(win.localStorage, themeStorageKey);
  let followsSystem = !isTheme(stored);
  const initial: Theme = isTheme(stored) ? stored : media.matches ? "dark" : "light";
  applyTheme(doc, initial);

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
    const current: Theme = doc.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
    applyTheme(doc, current);
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
      const current = button.dataset["state"];
      const state: CopyState =
        current === "loading" || current === "success" || current === "error" ? current : "idle";
      setCopyState(doc, button, state);
    });
    button.addEventListener("click", () => {
      const value = button.dataset["copy"];
      if (value === undefined) return;

      setCopyState(doc, button, "loading");
      const clipboard = Reflect.get(win.navigator, "clipboard") as Clipboard | undefined;
      if (clipboard === undefined) {
        setCopyState(doc, button, "error");
        win.setTimeout(() => {
          setCopyState(doc, button, "idle");
        }, 2200);
        return;
      }
      void clipboard.writeText(value).then(
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
