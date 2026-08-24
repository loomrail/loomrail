export const themePreferences = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof themePreferences)[number];

const THEME_STORAGE_KEY = "loomrail-theme";

export const isThemePreference = (value: string | null): value is ThemePreference =>
  value !== null && themePreferences.some((theme) => theme === value);

export const readThemePreference = (): ThemePreference => {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
};

export const applyThemePreference = (preference: ThemePreference): void => {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    return;
  }

  document.documentElement.dataset["theme"] = preference;
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
};
