export const densityPreferences = ["comfortable", "compact"] as const;
export type DensityPreference = (typeof densityPreferences)[number];

const DENSITY_STORAGE_KEY = "loomrail-density";

export const isDensityPreference = (value: string | null): value is DensityPreference =>
  value !== null && densityPreferences.some((density) => density === value);

export const readDensityPreference = (): DensityPreference => {
  const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
  return isDensityPreference(stored) ? stored : "comfortable";
};

/**
 * Applies the row density to the document.
 *
 * Comfortable is the default, so it clears the attribute rather than writing one: the stylesheet
 * carries the comfortable sizes as its base and only overrides them under `data-density="compact"`.
 */
export const applyDensityPreference = (preference: DensityPreference): void => {
  if (preference === "comfortable") {
    document.documentElement.removeAttribute("data-density");
    window.localStorage.removeItem(DENSITY_STORAGE_KEY);
    return;
  }

  document.documentElement.dataset["density"] = preference;
  window.localStorage.setItem(DENSITY_STORAGE_KEY, preference);
};
