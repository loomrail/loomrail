import "./styles.css";

type Theme = "light" | "dark";
type Locale = "en" | "ru";
type CopyState = "idle" | "loading" | "success" | "error";

const themeStorageKey = "loomrail-landing-theme";
const localeStorageKey = "loomrail-landing-locale";

const messages = {
  en: {
    pageTitle: "Loomrail — Agents propose. Owners accept.",
    metaDescription:
      "Loomrail keeps AI software delivery accountable: durable tasks, evidence, budgets, decisions, and owner acceptance in a local control plane.",
    ogDescription:
      "Durable tasks, evidence, budgets, decisions, and owner acceptance around local coding agents.",
    skipLink: "Skip to content",
    primaryNavigation: "Primary navigation",
    homeLabel: "Loomrail home",
    searchNavigation: "Search sections and docs",
    languageLabel: "Language",
    switchTheme: "Switch theme",
    lightTheme: "Light",
    darkTheme: "Dark",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    releaseLine: "Public pre-alpha · 0.1.0-alpha.1 · local only",
    heroTitle: "Agents propose. Owners accept.",
    heroLede:
      "Loomrail keeps the task, evidence, budgets, decisions, and final acceptance intact when an agent session ends.",
    installCta: "Install the pre-alpha",
    quickStartCta: "Read quick start",
    heroNote: "Loopback runtime · No Loomrail account · No analytics",
    safeFirstRun: "Safe first run",
    launchTitle: "Reach owner acceptance without provider quota.",
    launchStepInstall: "Install the explicit pre-alpha channel",
    launchStepRun: "Start the loopback Workbench",
    launchStepRoute: "Initialize the demo and run one task",
    launchStepRouteNote: "Answer a Human Request, approve a budget, inspect evidence.",
    seeInstallDetails: "Requirements and alternatives",
    routeTitle: "A delivery route that survives the chat.",
    routeIntro:
      "Provider messages are inputs. Loomrail owns the workflow state and records each consequential change.",
    routeOneTitle: "Define done",
    routeOneBody: "Brief, criteria, permissions, workflow version, and budget become one task contract.",
    routeOneOutput: "Output: versioned WorkItem",
    routeTwoTitle: "Decide at the fork",
    routeTwoBody: "Questions and approvals become typed Human Requests and durable Decisions.",
    routeTwoOutput: "Output: attributable decision",
    routeThreeTitle: "Inspect the change",
    routeThreeBody: "Review and QA attach typed evidence to the acceptance criteria.",
    routeThreeOutput: "Output: evidence matrix",
    routeFourTitle: "Accept as owner",
    routeFourBody: "Done is a separate owner-only event, never a provider claim.",
    routeFourOutput: "Output: acceptance package",
    workbenchTitle: "The board is the index. The task is the cockpit.",
    workbenchIntro:
      "Current state stays compact. The contract, criteria, provider sessions, changes, evidence, and owner actions open behind the task.",
    ownsStateTitle: "Durable state",
    ownsStateBody: "SQLite, restart recovery, idempotent commands, append-only events.",
    ownsRepoTitle: "Repository boundary",
    ownsRepoBody: "Per-task worktrees, bounded Constitution scan, owner-approved publication.",
    ownsHumanTitle: "Human authority",
    ownsHumanBody: "Explicit requests, budgets, recovery decisions, and final acceptance.",
    workbenchAlt: "Loomrail Workbench in dark theme with a task card, inspector, and activity history",
    workbenchCaption: "Real Phase 0 Workbench",
    workbenchCaptionMeta: "Dark theme · persisted local state",
    limitsTitle: "Useful now. Exact about the boundary.",
    limitsIntro: "Pre-alpha is a product state, not fine print.",
    boundaryRuntimeTitle: "Runtime",
    boundaryRuntimeBody: "Loopback daemon, authenticated browser session, local SQLite state.",
    boundaryProvidersTitle: "Providers",
    boundaryProvidersBody: "Codex: six stages. Claude Code: Discovery, Plan, and Review.",
    boundaryGitTitle: "Git",
    boundaryGitBody: "Task worktrees and change inspection. No automatic commit, push, merge, or deploy.",
    boundaryPlatformsTitle: "Platforms",
    boundaryPlatformsBody: "macOS and Windows are blocking. Linux is best effort.",
    boundaryNetworkTitle: "Security",
    boundaryNetworkBody:
      "Local-first is not a sandbox. Live agents keep the OS account’s permissions and network.",
    boundaryDistributionTitle: "Distribution",
    boundaryDistributionBody: "npm package today. No desktop installer, remote mode, cloud sync, or plugins.",
    installTitle: "Install locally. Verify safely.",
    installIntro:
      "Start with the deterministic mock route. Connect a live provider only after the local workflow behaves as expected.",
    operatingSystem: "OS",
    networkBinding: "Binding",
    recommended: "Recommended",
    localInstallTitle: "Project-local install",
    copy: "Copy",
    copying: "Copying…",
    copied: "Copied",
    copyFailed: "Copy failed",
    copyInstallCommand: "Copy install command",
    copyLaunchCommand: "Copy launch command",
    afterLaunch:
      "Then initialize the demo workspace, run one task, answer the request, approve the mock budget, and inspect acceptance evidence.",
    globalAlternative: "Need a global command or a fixed port?",
    noOpenNote: "Open the printed one-time URL on the same machine within 60 seconds.",
    docsTitle: "Documentation by the job at hand.",
    docsIntro: "Start small, then move to live repository work with the boundary visible.",
    documentationNavigation: "Documentation navigation",
    quickStartTitle: "Quick start",
    quickStartBody: "Install and complete the mock route.",
    userGuideTitle: "User guide",
    userGuideBody: "Repository, Constitution, providers, recovery, backup.",
    fullRouteTitle: "Full-route example",
    fullRouteBody: "A bounded repository and reproducible Codex task.",
    securityTitle: "Security model",
    securityBody: "Trust boundaries, threats, and verified controls.",
    footerStatement: "The agent can propose. Only the owner accepts.",
    footerNavigation: "Footer navigation",
    footerMeta: "Public pre-alpha · no telemetry",
    navigateLoomrail: "Navigate Loomrail",
    searchPlaceholder: "Go to a section or resource…",
    filterNavigation: "Filter navigation",
    closeMenu: "Close menu",
    routeNav: "Delivery route",
    limitsNav: "Current boundary",
    installNav: "Install",
    docsNav: "Documentation",
    sectionType: "Section",
    docsType: "Docs",
    githubRepository: "GitHub repository",
    externalType: "External",
    noDestination: "No matching destination.",
  },
  ru: {
    pageTitle: "Loomrail — Агенты предлагают. Владелец принимает.",
    metaDescription:
      "Loomrail делает поставку с AI-агентами проверяемой: долговечные задачи, evidence, бюджеты, решения и приёмка владельцем в локальном control plane.",
    ogDescription: "Задачи, evidence, бюджеты, решения и приёмка владельцем вокруг локальных coding-агентов.",
    skipLink: "Перейти к содержанию",
    primaryNavigation: "Основная навигация",
    homeLabel: "Главная Loomrail",
    searchNavigation: "Найти раздел или документ",
    languageLabel: "Язык",
    switchTheme: "Переключить тему",
    lightTheme: "Светлая",
    darkTheme: "Тёмная",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",
    releaseLine: "Публичный pre-alpha · 0.1.0-alpha.1 · только локально",
    heroTitle: "Агенты предлагают. Владелец принимает.",
    heroLede:
      "Loomrail сохраняет задачу, evidence, бюджеты, решения и итоговую приёмку после завершения агентской сессии.",
    installCta: "Установить pre-alpha",
    quickStartCta: "Открыть быстрый старт",
    heroNote: "Loopback runtime · Без аккаунта Loomrail · Без аналитики",
    safeFirstRun: "Безопасный первый запуск",
    launchTitle: "Дойдите до приёмки без расхода provider quota.",
    launchStepInstall: "Установите явный pre-alpha канал",
    launchStepRun: "Запустите loopback Workbench",
    launchStepRoute: "Создайте demo и проведите одну задачу",
    launchStepRouteNote: "Ответьте на Human Request, одобрите бюджет, проверьте evidence.",
    seeInstallDetails: "Требования и альтернативы",
    routeTitle: "Маршрут поставки, который переживает чат.",
    routeIntro:
      "Сообщения provider — входные данные. Loomrail владеет workflow state и записывает значимые изменения.",
    routeOneTitle: "Определите готовность",
    routeOneBody:
      "Brief, критерии, permissions, версия workflow и budget становятся единым контрактом задачи.",
    routeOneOutput: "Результат: версионированный WorkItem",
    routeTwoTitle: "Примите решение в точке выбора",
    routeTwoBody: "Вопросы и approvals становятся типизированными Human Requests и долговечными Decisions.",
    routeTwoOutput: "Результат: авторизованное решение",
    routeThreeTitle: "Проверьте изменение",
    routeThreeBody: "Review и QA привязывают типизированные evidence к критериям приёмки.",
    routeThreeOutput: "Результат: матрица evidence",
    routeFourTitle: "Примите как владелец",
    routeFourBody: "Done — отдельное событие владельца, а не утверждение provider.",
    routeFourOutput: "Результат: пакет приёмки",
    workbenchTitle: "Доска — индекс. Задача — cockpit.",
    workbenchIntro:
      "Текущее состояние остаётся компактным. Контракт, критерии, provider sessions, изменения, evidence и действия владельца открываются внутри задачи.",
    ownsStateTitle: "Долговечное состояние",
    ownsStateBody: "SQLite, recovery после restart, idempotent-команды, append-only events.",
    ownsRepoTitle: "Граница репозитория",
    ownsRepoBody: "Worktree на задачу, ограниченный Constitution scan, публикация после решения владельца.",
    ownsHumanTitle: "Полномочия человека",
    ownsHumanBody: "Явные запросы, бюджеты, recovery decisions и итоговая приёмка.",
    workbenchAlt: "Workbench Loomrail в тёмной теме с карточкой задачи, inspector и историей активности",
    workbenchCaption: "Настоящий Workbench фазы 0",
    workbenchCaptionMeta: "Тёмная тема · сохранённое локальное состояние",
    limitsTitle: "Полезен сейчас. Точен о границах.",
    limitsIntro: "Pre-alpha — состояние продукта, а не мелкий шрифт.",
    boundaryRuntimeTitle: "Runtime",
    boundaryRuntimeBody: "Loopback daemon, авторизованная browser session, локальное SQLite-состояние.",
    boundaryProvidersTitle: "Providers",
    boundaryProvidersBody: "Codex: шесть стадий. Claude Code: Discovery, Plan и Review.",
    boundaryGitTitle: "Git",
    boundaryGitBody:
      "Worktree задач и просмотр изменений. Без автоматических commit, push, merge или deploy.",
    boundaryPlatformsTitle: "Платформы",
    boundaryPlatformsBody: "macOS и Windows — blocking. Linux — best effort.",
    boundaryNetworkTitle: "Безопасность",
    boundaryNetworkBody:
      "Local-first не означает sandbox. Живые агенты сохраняют права OS-аккаунта и доступ к сети.",
    boundaryDistributionTitle: "Дистрибуция",
    boundaryDistributionBody: "Сейчас npm-пакет. Без desktop installer, remote mode, cloud sync и plugins.",
    installTitle: "Установите локально. Проверьте безопасно.",
    installIntro:
      "Начните с детерминированного mock-маршрута. Подключайте живого provider только после проверки локального workflow.",
    operatingSystem: "ОС",
    networkBinding: "Сетевой интерфейс",
    recommended: "Рекомендуем",
    localInstallTitle: "Локальная установка в проект",
    copy: "Копировать",
    copying: "Копируем…",
    copied: "Скопировано",
    copyFailed: "Не скопировано",
    copyInstallCommand: "Скопировать команду установки",
    copyLaunchCommand: "Скопировать команду запуска",
    afterLaunch:
      "Затем создайте demo-пространство, проведите одну задачу, ответьте на запрос, одобрите mock-бюджет и проверьте evidence приёмки.",
    globalAlternative: "Нужна глобальная команда или фиксированный порт?",
    noOpenNote: "Откройте напечатанную одноразовую ссылку на той же машине в течение 60 секунд.",
    docsTitle: "Документация по вашей текущей задаче.",
    docsIntro: "Начните с малого, затем переходите к живому репозиторию с видимой границей ответственности.",
    documentationNavigation: "Навигация по документации",
    quickStartTitle: "Быстрый старт",
    quickStartBody: "Установите Loomrail и пройдите mock-маршрут.",
    userGuideTitle: "Руководство пользователя",
    userGuideBody: "Репозиторий, Конституция, providers, recovery и backup.",
    fullRouteTitle: "Full-route пример",
    fullRouteBody: "Ограниченный репозиторий и воспроизводимая задача Codex.",
    securityTitle: "Модель безопасности",
    securityBody: "Границы доверия, угрозы и проверенные controls.",
    footerStatement: "Агент может предложить. Принимает только владелец.",
    footerNavigation: "Навигация в подвале",
    footerMeta: "Публичный pre-alpha · без телеметрии",
    navigateLoomrail: "Навигация Loomrail",
    searchPlaceholder: "Перейти к разделу или документу…",
    filterNavigation: "Фильтр навигации",
    closeMenu: "Закрыть меню",
    routeNav: "Маршрут поставки",
    limitsNav: "Текущие границы",
    installNav: "Установка",
    docsNav: "Документация",
    sectionType: "Раздел",
    docsType: "Документ",
    githubRepository: "Репозиторий GitHub",
    externalType: "Внешняя ссылка",
    noDestination: "Подходящих разделов нет.",
  },
} as const;

type MessageKey = keyof (typeof messages)["en"];

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark";
}

function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "ru";
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
    // Controls remain functional when storage is blocked.
  }
}

function currentLocale(doc: Document): Locale {
  return doc.documentElement.lang === "ru" ? "ru" : "en";
}

function message(doc: Document, key: MessageKey): string {
  return messages[currentLocale(doc)][key];
}

function isMessageKey(value: string | undefined): value is MessageKey {
  return value !== undefined && value in messages.en;
}

function setMetaContent(doc: Document, selector: string, value: string): void {
  doc.querySelector<HTMLMetaElement>(selector)?.setAttribute("content", value);
}

function applyLocale(doc: Document, locale: Locale): void {
  const dictionary = messages[locale];
  doc.documentElement.lang = locale;
  doc.title = dictionary.pageTitle;
  setMetaContent(doc, 'meta[name="description"]', dictionary.metaDescription);
  setMetaContent(doc, 'meta[property="og:title"]', dictionary.pageTitle);
  setMetaContent(doc, 'meta[property="og:description"]', dictionary.ogDescription);

  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (isMessageKey(key)) element.textContent = dictionary[key];
  }
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = element.dataset["i18nAriaLabel"];
    if (isMessageKey(key)) element.setAttribute("aria-label", dictionary[key]);
  }
  for (const element of doc.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = element.dataset["i18nPlaceholder"];
    if (isMessageKey(key)) element.placeholder = dictionary[key];
  }
  for (const element of doc.querySelectorAll<HTMLImageElement>("[data-i18n-alt]")) {
    const key = element.dataset["i18nAlt"];
    if (isMessageKey(key)) element.alt = dictionary[key];
  }
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
    button.setAttribute("aria-pressed", String(button.dataset["locale"] === locale));
  }
  for (const link of doc.querySelectorAll<HTMLAnchorElement>("[data-doc-link]")) {
    const documentName = link.dataset["docLink"];
    if (documentName === "getting-started") {
      link.href = `https://github.com/loomrail/loomrail/blob/main/docs/guides/GETTING-STARTED${locale === "ru" ? ".ru" : ""}.md`;
    } else if (documentName === "user-guide") {
      link.href = `https://github.com/loomrail/loomrail/blob/main/docs/guides/USER-GUIDE${locale === "ru" ? ".ru" : ""}.md`;
    }
  }
  doc.dispatchEvent(new CustomEvent("loomrail:localechange", { detail: locale }));
}

function setupLocale(doc: Document, win: Window): void {
  const stored = safeStorageRead(win.localStorage, localeStorageKey);
  const preferred = win.navigator.language.toLocaleLowerCase().startsWith("ru") ? "ru" : "en";
  const initial: Locale = isLocale(stored) ? stored : preferred;
  applyLocale(doc, initial);

  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
    button.addEventListener("click", () => {
      const locale = button.dataset["locale"];
      if (!isLocale(locale)) return;
      safeStorageWrite(win.localStorage, localeStorageKey, locale);
      applyLocale(doc, locale);
    });
  }
}

function resolvedTheme(root: HTMLElement, media: MediaQueryList): Theme {
  const explicit = root.dataset["theme"];
  if (isTheme(explicit)) return explicit;
  return media.matches ? "dark" : "light";
}

function setThemeLabel(doc: Document, button: HTMLButtonElement, label: HTMLElement, theme: Theme): void {
  label.textContent = message(doc, theme === "dark" ? "darkTheme" : "lightTheme");
  button.setAttribute("aria-label", message(doc, theme === "dark" ? "switchToLight" : "switchToDark"));
}

function setupTheme(doc: Document, win: Window): void {
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const label = doc.querySelector<HTMLElement>("[data-theme-label]");
  if (button === null || label === null) return;

  const media = win.matchMedia("(prefers-color-scheme: dark)");
  const stored = safeStorageRead(win.localStorage, themeStorageKey);
  if (isTheme(stored)) doc.documentElement.dataset["theme"] = stored;

  const refresh = (): void => {
    setThemeLabel(doc, button, label, resolvedTheme(doc.documentElement, media));
  };
  refresh();
  button.addEventListener("click", () => {
    const next: Theme = resolvedTheme(doc.documentElement, media) === "dark" ? "light" : "dark";
    doc.documentElement.dataset["theme"] = next;
    safeStorageWrite(win.localStorage, themeStorageKey, next);
    refresh();
  });
  media.addEventListener("change", () => {
    if (doc.documentElement.dataset["theme"] === undefined) refresh();
  });
  doc.addEventListener("loomrail:localechange", refresh);
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
      const value = button.dataset["copy"];
      if (value === undefined) return;

      setCopyState(doc, button, "loading");
      const clipboard = (win.navigator as unknown as { readonly clipboard?: Clipboard }).clipboard;
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

function setupCommandPalette(doc: Document): void {
  const dialog = doc.querySelector<HTMLDialogElement>("[data-command-dialog]");
  const search = doc.querySelector<HTMLInputElement>("[data-command-search]");
  const close = doc.querySelector<HTMLButtonElement>("[data-command-close]");
  const empty = doc.querySelector<HTMLElement>("[data-command-empty]");
  if (dialog === null || search === null || close === null || empty === null) return;

  const links = [...dialog.querySelectorAll<HTMLAnchorElement>(".command-link")];
  let activeIndex = 0;

  const visibleLinks = (): HTMLAnchorElement[] => links.filter((link) => !link.closest("li")?.hidden);
  const updateActive = (index: number): void => {
    const visible = visibleLinks();
    for (const link of links) delete link.dataset["active"];
    if (visible.length === 0) {
      activeIndex = 0;
      return;
    }
    activeIndex = (index + visible.length) % visible.length;
    visible[activeIndex]?.setAttribute("data-active", "true");
  };
  const filter = (): void => {
    const query = search.value.trim().toLocaleLowerCase(currentLocale(doc));
    for (const link of links) {
      const item = link.closest("li");
      if (item !== null)
        item.hidden = !link.textContent.toLocaleLowerCase(currentLocale(doc)).includes(query);
    }
    empty.hidden = visibleLinks().length > 0;
    updateActive(0);
  };
  const open = (): void => {
    search.value = "";
    filter();
    dialog.showModal();
    search.focus();
  };
  const closeDialog = (): void => {
    dialog.close();
  };

  for (const trigger of doc.querySelectorAll<HTMLButtonElement>("[data-command-open]")) {
    trigger.addEventListener("click", open);
  }
  close.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  for (const link of links) link.addEventListener("click", closeDialog);
  search.addEventListener("input", filter);
  doc.addEventListener("loomrail:localechange", filter);

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      updateActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      updateActive(activeIndex - 1);
    } else if (event.key === "Enter" && event.target === search) {
      event.preventDefault();
      visibleLinks()[activeIndex]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
  });

  doc.addEventListener("keydown", (event) => {
    if (event.key.toLocaleLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (dialog.open) closeDialog();
      else open();
    }
  });
}

export function initializeLanding(doc: Document, win: Window): void {
  if (doc.documentElement.dataset["landingReady"] === "true") return;
  doc.documentElement.dataset["landingReady"] = "true";
  setupLocale(doc, win);
  setupTheme(doc, win);
  setupCopyButtons(doc, win);
  setupCommandPalette(doc);
}

initializeLanding(document, window);
