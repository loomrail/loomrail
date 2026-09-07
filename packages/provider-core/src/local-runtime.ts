const LOCAL_RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const;

/**
 * Enough environment for official cached-login discovery and portable process startup, without
 * provider API keys, project secrets, proxy credentials or arbitrary owner variables.
 */
export const localProviderRuntimeEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    LOCAL_RUNTIME_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
