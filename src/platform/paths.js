import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnvCaseInsensitive } from "./command-launcher.js";

const APP_NAME = "wtagent";
const LEGACY_APP_NAME = "webagent";

function platformAppDataDir(appName, {
  env,
  platform,
  homeDir,
}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") {
    return pathApi.join(homeDir, "Library", "Application Support", appName);
  }

  if (platform === "win32") {
    const base = getEnvCaseInsensitive(env, "APPDATA")
      ?? pathApi.join(homeDir, "AppData", "Roaming");
    return pathApi.join(base, appName);
  }

  const base = getEnvCaseInsensitive(env, "XDG_DATA_HOME")
    ?? pathApi.join(homeDir, ".local", "share");
  return pathApi.join(base, appName);
}

function looksLikeLegacyDataDir(directory, exists, pathApi) {
  return ["chrome-profile", "sessions", "tasks"]
    .some((entry) => exists(pathApi.join(directory, entry)));
}

export function getAppDataDir(appName = APP_NAME, {
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  exists = existsSync,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const configured = getEnvCaseInsensitive(env, "WTAGENT_HOME")
    ?? getEnvCaseInsensitive(env, "WEBAGENT_HOME");
  if (configured) {
    return pathApi.resolve(configured);
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
  return looksLikeLegacyDataDir(legacy, exists, pathApi) ? legacy : current;
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
