try {
  const preference = globalThis.localStorage.getItem("loomrail-theme");
  if (preference === "dark" || preference === "light") {
    globalThis.document.documentElement.dataset.theme = preference;
  }
} catch {
  // Theme persistence is an enhancement; the system preference remains the safe fallback.
}

try {
  const density = globalThis.localStorage.getItem("loomrail-density");
  if (density === "compact") {
    globalThis.document.documentElement.dataset.density = density;
  }
} catch {
  // Density is an enhancement; the comfortable spacing in the stylesheet remains the fallback.
}

try {
  // Bounds mirror `panelBounds` in src/layout.ts; a unit test fails if the two ever disagree.
  const panels = [
    { key: "loomrail-panel-sidebar", max: 360, min: 200, property: "--lr-size-sidebar" },
    { key: "loomrail-panel-inspector", max: 520, min: 280, property: "--lr-size-inspector" },
  ];
  for (const panel of panels) {
    const stored = Number(globalThis.localStorage.getItem(panel.key));
    if (!Number.isFinite(stored) || stored === 0) continue;
    const width = Math.min(panel.max, Math.max(panel.min, Math.round(stored)));
    globalThis.document.documentElement.style.setProperty(panel.property, `${width}px`);
  }
} catch {
  // Panel widths are an enhancement; the token defaults remain the safe fallback.
}

try {
  const storedLocale = globalThis.localStorage.getItem("loomrail.locale");
  const locale =
    storedLocale === "ru" || storedLocale === "en"
      ? storedLocale
      : globalThis.navigator.language.toLowerCase().startsWith("ru")
        ? "ru"
        : "en";
  globalThis.document.documentElement.lang = locale;
} catch {
  // The static document language remains the safe fallback when storage is unavailable.
}
