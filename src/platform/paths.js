import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_NAME = "wtagent";
const LEGACY_APP_NAME = "webagent";

function platformAppDataDir(appName, {
  env,
  platform,
  homeDir,
}) {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", appName);
  }

  if (platform === "win32") {
    const base = env.APPDATA
      ?? path.join(homeDir, "AppData", "Roaming");
    return path.join(base, appName);
  }

  const base = env.XDG_DATA_HOME
    ?? path.join(homeDir, ".local", "share");
  return path.join(base, appName);
}

function looksLikeLegacyDataDir(directory, exists) {
  return ["chrome-profile", "sessions", "tasks"]
    .some((entry) => exists(path.join(directory, entry)));
}

export function getAppDataDir(appName = APP_NAME, {
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  exists = existsSync,
} = {}) {
  const configured = env.WTAGENT_HOME ?? env.WEBAGENT_HOME;
  if (configured) {
    return path.resolve(configured);
  }

  const current = platformAppDataDir(appName, { env, platform, homeDir });
  if (appName !== APP_NAME || exists(current)) {
    return current;
  }

  const legacy = platformAppDataDir(LEGACY_APP_NAME, {
    env,
    platform,
    homeDir,
  });
  return looksLikeLegacyDataDir(legacy, exists) ? legacy : current;
}

export function getChromeProfileDir(appDataDir = getAppDataDir()) {
  return path.join(appDataDir, "chrome-profile");
}

export function getTasksDir(appDataDir = getAppDataDir()) {
  return path.join(appDataDir, "tasks");
}

export function getSessionsDir(appDataDir = getAppDataDir()) {
  return path.join(appDataDir, "sessions");
}

export async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
  return directoryPath;
}
