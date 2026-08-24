try {
  const preference = globalThis.localStorage.getItem("loomrail-theme");
  if (preference === "dark" || preference === "light") {
    globalThis.document.documentElement.dataset.theme = preference;
  }
} catch {
  // Theme persistence is an enhancement; the system preference remains the safe fallback.
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
