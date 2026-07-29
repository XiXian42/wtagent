import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function existingFile(candidate) {
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

function findOnPath(names, platform) {
  const finder = platform === "win32" ? "where" : "which";
  for (const name of names) {
    const result = spawnSync(finder, [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      const first = result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) {
        return first;
      }
    }
  }
  return null;
}

export function discoverChromeExecutable(explicitPath, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const configured = explicitPath
    ?? env.WTAGENT_CHROME_PATH
    ?? env.WEBAGENT_CHROME_PATH;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configured Chrome executable does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (platform === "win32") {
    const programFiles = [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(
        path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(base, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found) {
      return found;
    }
  }

  const fromPath = findOnPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ], platform);

  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    "Chrome/Chromium was not found. Install Chrome or set WTAGENT_CHROME_PATH.",
  );
}
