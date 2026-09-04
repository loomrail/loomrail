import { createContext, useContext } from "react";

export const OpenAppSettingsContext = createContext<(() => void) | null>(null);

export const useOpenAppSettings = (): (() => void) => {
  const openSettings = useContext(OpenAppSettingsContext);
  if (openSettings === null) throw new Error("useOpenAppSettings must be used inside AppFrame");
  return openSettings;
};
