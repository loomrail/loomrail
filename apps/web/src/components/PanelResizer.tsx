import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { applyPanelWidth, clampPanelWidth, panelBounds, readPanelWidth, type PanelName } from "../layout";

const KEYBOARD_STEP = 16;

export type PanelResizerProps = {
  /** Which edge the handle sits on, which decides how pointer movement maps to width. */
  edge: "start" | "end";
  panel: PanelName;
};

/**
 * A draggable divider for a resizable panel.
 *
 * Implemented as a real `separator` with a value, so the panel can be resized from the keyboard as
 * well as by pointer. Width is written straight to the CSS custom property while dragging, which
 * keeps the panel following the pointer without re-rendering the board on every frame.
 */
export const PanelResizer = ({ edge, panel }: PanelResizerProps): React.JSX.Element => {
  const { t } = useI18n();
  const [width, setWidth] = useState(() => readPanelWidth(panel));
  const [dragging, setDragging] = useState(false);
  const { max, min } = panelBounds[panel];

  useEffect(() => {
    if (!dragging) return undefined;

    const move = (event: PointerEvent): void => {
      const next = edge === "start" ? event.clientX : window.innerWidth - event.clientX;
      const clamped = clampPanelWidth(panel, next);
      setWidth(clamped);
      applyPanelWidth(panel, clamped);
    };
    const stop = (): void => {
      setDragging(false);
    };

    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging, edge, panel]);

  const nudge = (delta: number): void => {
    const clamped = clampPanelWidth(panel, width + delta);
    setWidth(clamped);
    applyPanelWidth(panel, clamped);
  };

  return (
    <div
      aria-label={t(`layout.resize.${panel}`)}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={width}
      className="panel-resizer"
      onDoubleClick={() => {
        const { defaultWidth } = panelBounds[panel];
        setWidth(defaultWidth);
        applyPanelWidth(panel, defaultWidth);
      }}
      onKeyDown={(event) => {
        const towardsWider = edge === "start" ? "ArrowRight" : "ArrowLeft";
        const towardsNarrower = edge === "start" ? "ArrowLeft" : "ArrowRight";
        if (event.key !== towardsWider && event.key !== towardsNarrower) return;
        event.preventDefault();
        nudge(event.key === towardsWider ? KEYBOARD_STEP : -KEYBOARD_STEP);
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        setWidth(readPanelWidth(panel));
        setDragging(true);
      }}
      role="separator"
      tabIndex={0}
    />
  );
};
