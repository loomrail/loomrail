import "./styles.css";

type Theme = "light" | "dark";

const themeStorageKey = "loomrail-landing-theme";

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark";
}

function readStoredTheme(storage: Storage): Theme | null {
  try {
    const value = storage.getItem(themeStorageKey);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(storage: Storage, theme: Theme): void {
  try {
    storage.setItem(themeStorageKey, theme);
  } catch {
    // A blocked storage backend must not block the theme control itself.
  }
}

function resolvedTheme(root: HTMLElement, media: MediaQueryList): Theme {
  const explicit = root.dataset["theme"];
  if (isTheme(explicit)) return explicit;
  return media.matches ? "dark" : "light";
}

function setThemeLabel(button: HTMLButtonElement, label: HTMLElement, theme: Theme): void {
  const next = theme === "dark" ? "light" : "dark";
  label.textContent = theme === "dark" ? "Dark" : "Light";
  button.setAttribute("aria-label", `Switch to ${next} theme`);
}

function setupTheme(doc: Document, win: Window): void {
  const button = doc.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const label = doc.querySelector<HTMLElement>("[data-theme-label]");
  if (button === null || label === null) return;

  const media = win.matchMedia("(prefers-color-scheme: dark)");
  const stored = readStoredTheme(win.localStorage);
  if (stored !== null) doc.documentElement.dataset["theme"] = stored;
  setThemeLabel(button, label, resolvedTheme(doc.documentElement, media));

  button.addEventListener("click", () => {
    const next: Theme = resolvedTheme(doc.documentElement, media) === "dark" ? "light" : "dark";
    doc.documentElement.dataset["theme"] = next;
    writeStoredTheme(win.localStorage, next);
    setThemeLabel(button, label, next);
  });

  media.addEventListener("change", () => {
    if (doc.documentElement.dataset["theme"] === undefined) {
      setThemeLabel(button, label, resolvedTheme(doc.documentElement, media));
    }
  });
}

function setCopyState(button: HTMLButtonElement, state: "idle" | "loading" | "success" | "error"): void {
  button.dataset["state"] = state;
  button.disabled = state === "loading";
  button.textContent =
    state === "loading"
      ? "Copying…"
      : state === "success"
        ? "Copied"
        : state === "error"
          ? "Copy failed"
          : "Copy";
}

function setupCopyButtons(doc: Document, win: Window): void {
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    button.addEventListener("click", () => {
      const value = button.dataset["copy"];
      if (value === undefined) return;

      setCopyState(button, "loading");
      const clipboard = (win.navigator as unknown as { readonly clipboard?: Clipboard }).clipboard;
      if (clipboard === undefined) {
        setCopyState(button, "error");
        win.setTimeout(() => {
          setCopyState(button, "idle");
        }, 2200);
        return;
      }
      void clipboard.writeText(value).then(
        () => {
          setCopyState(button, "success");
          win.setTimeout(() => {
            setCopyState(button, "idle");
          }, 1600);
        },
        () => {
          setCopyState(button, "error");
          win.setTimeout(() => {
            setCopyState(button, "idle");
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

  const open = (): void => {
    search.value = "";
    for (const link of links) {
      const item = link.closest("li");
      if (item !== null) item.hidden = false;
    }
    empty.hidden = true;
    updateActive(0);
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

  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const link of links) {
      const item = link.closest("li");
      if (item !== null) item.hidden = !link.textContent.toLocaleLowerCase().includes(query);
    }
    empty.hidden = visibleLinks().length > 0;
    updateActive(0);
  });

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
  setupTheme(doc, win);
  setupCopyButtons(doc, win);
  setupCommandPalette(doc);
}

initializeLanding(document, window);
