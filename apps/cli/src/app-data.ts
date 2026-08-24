import { homedir, platform as runtimePlatform } from "node:os";
import { posix, win32 } from "node:path";

type SupportedPlatform = "darwin" | "win32" | "linux" | "other";

type ResolveAppDataOptions = {
  platform?: SupportedPlatform;
  homeDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
};

const normalizePlatform = (value: NodeJS.Platform): SupportedPlatform =>
  value === "darwin" || value === "win32" || value === "linux" ? value : "other";

export const resolveLoomrailDataDirectory = (options: ResolveAppDataOptions = {}): string => {
  const platform = options.platform ?? normalizePlatform(runtimePlatform());
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const override = environment["LOOMRAIL_DATA_DIR"]?.trim();
  if (override) return override;

  if (platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"]?.trim();
    const baseDirectory = localAppData?.length ? localAppData : win32.join(homeDirectory, "AppData", "Local");
    return win32.join(baseDirectory, "Loomrail");
  }
  if (platform === "darwin") {
    return posix.join(homeDirectory, "Library", "Application Support", "Loomrail");
  }
  if (platform === "linux") {
    const xdgDataHome = environment["XDG_DATA_HOME"]?.trim();
    const baseDirectory = xdgDataHome?.length ? xdgDataHome : posix.join(homeDirectory, ".local", "share");
    return posix.join(baseDirectory, "loomrail");
  }
  return posix.join(homeDirectory, ".loomrail");
};
