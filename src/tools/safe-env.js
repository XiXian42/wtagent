const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "TERM",
  "COLORTERM",
  "CI",
  "NODE_ENV",
  "NO_COLOR",
  "FORCE_COLOR",
  // Windows-specific locations that common tools (npm, git, node, ...)
  // need to locate config, caches, and the user profile.
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PUBLIC",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
]);

const SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|COOKIE|CREDENTIAL|AUTH)/i;

export function buildToolEnvironment({ inheritSensitive = false } = {}) {
  if (inheritSensitive) {
    return { ...process.env };
  }

  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value == null || SENSITIVE_NAME.test(name)) {
      continue;
    }
    // Environment variable names are case-insensitive on Windows; normalize
    // to upper case for the allow-list lookup while preserving the original
    // key in the returned object.
    const upper = name.toUpperCase();
    if (
      SAFE_ENV_NAMES.has(upper)
      || name.startsWith("npm_")
      || name.startsWith("NPM_")
      || name.startsWith("XDG_")
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

