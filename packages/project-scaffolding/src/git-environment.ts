import process from "node:process";
import { join } from "node:path";

const PASSTHROUGH_KEYS = [
  "COMSPEC",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
] as const;

/**
 * Gives scaffold Git commands enough OS environment to launch, but no ambient repository,
 * template, hook or credential authority from the owner's shell.
 */
export const scaffoldGitEnvironment = (targetPath: string): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["HOME"] = targetPath;
  environment["USERPROFILE"] = targetPath;
  environment["XDG_CONFIG_HOME"] = join(targetPath, ".loomrail", "git-config-home");
  return Object.freeze(environment);
};
