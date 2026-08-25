export const panels = ["sidebar", "inspector"] as const;
export type PanelName = (typeof panels)[number];

type PanelBounds = { defaultWidth: number; max: number; min: number; property: string };

/**
 * Width limits for the resizable panels.
 *
 * `defaultWidth` mirrors the design token of the same name; a unit test reads `tokens.css` and
 * fails if the two ever disagree, so the stylesheet stays the single source for the default.
 */
export const panelBounds: Record<PanelName, PanelBounds> = {
  sidebar: { defaultWidth: 240, max: 360, min: 200, property: "--lr-size-sidebar" },
  inspector: { defaultWidth: 344, max: 520, min: 280, property: "--lr-size-inspector" },
};

const storageKey = (panel: PanelName): string => `loomrail-panel-${panel}`;

export const clampPanelWidth = (panel: PanelName, width: number): number => {
  const { max, min } = panelBounds[panel];
  if (!Number.isFinite(width)) return panelBounds[panel].defaultWidth;
  return Math.min(max, Math.max(min, Math.round(width)));
};

export const readPanelWidth = (panel: PanelName): number => {
  const stored = window.localStorage.getItem(storageKey(panel));
  if (stored === null) return panelBounds[panel].defaultWidth;
  return clampPanelWidth(panel, Number(stored));
};

/**
 * Applies a panel width as a CSS custom property.
 *
 * The default clears the property and the stored value, so the stylesheet keeps ownership of the
 * default — including the narrower one it uses on smaller desktops.
 */
export const applyPanelWidth = (panel: PanelName, width: number): void => {
  const { defaultWidth, property } = panelBounds[panel];
  const clamped = clampPanelWidth(panel, width);
  if (clamped === defaultWidth) {
    document.documentElement.style.removeProperty(property);
    window.localStorage.removeItem(storageKey(panel));
    return;
  }

  document.documentElement.style.setProperty(property, `${clamped.toString()}px`);
  window.localStorage.setItem(storageKey(panel), clamped.toString());
};

export const resetPanelWidths = (): void => {
  for (const panel of panels) applyPanelWidth(panel, panelBounds[panel].defaultWidth);
};

export const hasCustomPanelWidths = (): boolean =>
  panels.some((panel) => window.localStorage.getItem(storageKey(panel)) !== null);
