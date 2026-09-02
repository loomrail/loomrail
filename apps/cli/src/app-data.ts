import { homedir, platform as runtimePlatform } from "node:os";
import { posix, win32 } from "node:path";

type SupportedPlatform = "darwin" | "win32" | "linux" | "other";

type ResolveAppDataOptions = {
  platform?: SupportedPlatform;
  homeDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type LoomrailDataLocation = {
  directory: string;
  source: "DEFAULT" | "ENVIRONMENT_OVERRIDE";
};

const normalizePlatform = (value: NodeJS.Platform): SupportedPlatform =>
  value === "darwin" || value === "win32" || value === "linux" ? value : "other";

export const resolveLoomrailDataLocation = (options: ResolveAppDataOptions = {}): LoomrailDataLocation => {
  const platform = options.platform ?? normalizePlatform(runtimePlatform());
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const override = environment["LOOMRAIL_DATA_DIR"]?.trim();
  if (override) return { directory: override, source: "ENVIRONMENT_OVERRIDE" };

  if (platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"]?.trim();
    const baseDirectory = localAppData?.length ? localAppData : win32.join(homeDirectory, "AppData", "Local");
    return { directory: win32.join(baseDirectory, "Loomrail"), source: "DEFAULT" };
  }
  if (platform === "darwin") {
    return {
      directory: posix.join(homeDirectory, "Library", "Application Support", "Loomrail"),
      source: "DEFAULT",
    };
  }
  if (platform === "linux") {
    const xdgDataHome = environment["XDG_DATA_HOME"]?.trim();
    const baseDirectory = xdgDataHome?.length ? xdgDataHome : posix.join(homeDirectory, ".local", "share");
    return { directory: posix.join(baseDirectory, "loomrail"), source: "DEFAULT" };
  }
  return { directory: posix.join(homeDirectory, ".loomrail"), source: "DEFAULT" };
};

export const resolveLoomrailDataDirectory = (options: ResolveAppDataOptions = {}): string =>
  resolveLoomrailDataLocation(options).directory;
