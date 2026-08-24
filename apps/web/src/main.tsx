import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@loomrail/ui/styles.css";
import "./styles.css";

import { App } from "./App";
import { applyThemePreference, readThemePreference } from "./theme";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Loomrail root element is missing");
}

applyThemePreference(readThemePreference());

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
