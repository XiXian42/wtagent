import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverChromeExecutable } from "./chrome-discovery.js";
import { resolveLaunchPlan } from "./command-launcher.js";
import { inspectCdpProfileState } from "../browser/cdp-state.js";

const execFileAsync = promisify(execFile);

function parseMajorMinorPatch(version) {
  const match = String(version ?? "").replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((value) => Number(value));
}

export function isSupportedNodeVersion(version = process.version) {
  const parsed = parseMajorMinorPatch(version);
  if (!parsed) {
    return false;
  }
  const [major, minor, patch] = parsed;
  if (major > 20) {
    return true;
  }
  if (major < 20) {
    return false;
  }
  if (minor > 17) {
    return true;
  }
  if (minor < 17) {
    return false;
  }
  return patch >= 0;
}

export function detectWsl({
  platform = process.platform,
  env = process.env,
  osRelease = os.release(),
} = {}) {
  if (platform !== "linux") {
    return false;
  }
  return Boolean(
    env.WSL_INTEROP
      || env.WSL_DISTRO_NAME
      || /\b(microsoft|wsl)\b/i.test(osRelease),
  );
}

export function getWslSupport({
  platform = process.platform,
  env = process.env,
  osRelease = os.release(),
} = {}) {
  if (!detectWsl({ platform, env, osRelease })) {
    return { supported: true, preview: false, reason: null };
  }

  const display = env.WAYLAND_DISPLAY || env.DISPLAY;
  if (!display) {
    return {
      supported: false,
      preview: false,
      reason:
        "WSL is detected, but no Linux graphical display is available. Enable WSLg (or an X server), install Chrome/Chromium inside the WSL distribution, and retry.",
    };
  }

  return {
    supported: true,
    preview: true,
    reason:
      `WSL is detected with ${env.WAYLAND_DISPLAY ? "Wayland" : "X11"} display support. `
      + "WTAgent uses Chrome/Chromium installed inside the WSL distribution; Windows-host Chrome is not used.",
  };
}

export function getNativeWindowsSupport({
  platform = process.platform,
  arch = process.arch,
  osRelease = os.release(),
} = {}) {
  if (platform !== "win32") {
    return { supported: true, preview: false, reason: null };
  }

  const [major = 0, minor = 0, build = 0] = String(osRelease)
    .split(".")
    .map((value) => Number.parseInt(value, 10));
  const supportedRelease = major > 10
    || (major === 10 && (minor > 0 || build >= 17_763));
  if (!supportedRelease) {
    return {
      supported: false,
      preview: false,
      reason: `Windows ${osRelease} is unsupported; WTAgent requires Windows 10 1809 (build 17763) or newer.`,
    };
  }
  if (arch === "x64") {
    return { supported: true, preview: false, reason: null };
  }
  if (arch === "arm64") {
    return {
      supported: true,
      preview: true,
      reason: "Windows ARM64 support is preview and is not an x64 release gate.",
    };
  }
  return {
    supported: false,
    preview: false,
    reason: `Windows architecture ${arch} is unsupported; use x64 (GA) or ARM64 (preview).`,
  };
}

export function assertNativeRuntimeSupported(context = {}) {
  const version = context.version ?? process.version;
  if (!isSupportedNodeVersion(version)) {
    throw new Error(
      `WTAgent requires Node.js 20.17.0 or newer; current runtime is ${version}.`,
    );
  }

  const wsl = getWslSupport(context);
  if (!wsl.supported) {
    throw new Error(wsl.reason);
  }

  const windows = getNativeWindowsSupport(context);
  if (!windows.supported) {
    throw new Error(windows.reason);
  }
}

async function nearestExistingAncestor(targetPath, {
  stat = fs.stat,
} = {}) {
  let current = path.resolve(targetPath);
  for (;;) {
    const currentStat = await stat(current).catch(() => null);
    if (currentStat) {
      return { path: current, stat: currentStat };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function assessDirectoryTarget(targetPath, {
  access = fs.access,
  stat = fs.stat,
} = {}) {
  const resolved = path.resolve(targetPath);
  const existing = await stat(resolved).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) {
      return {
        status: "fail",
        detail: `${resolved} exists but is not a directory.`,
      };
    }
    try {
      await access(resolved, fsConstants.W_OK);
      return {
        status: "pass",
        detail: `${resolved} exists and is writable.`,
      };
    } catch (error) {
      return {
        status: "fail",
        detail: `${resolved} is not writable: ${error.message}`,
      };
    }
  }

  const ancestor = await nearestExistingAncestor(resolved, { stat });
  if (!ancestor) {
    return {
      status: "fail",
      detail: `No existing ancestor found for ${resolved}.`,
    };
  }
  if (!ancestor.stat.isDirectory()) {
    return {
      status: "fail",
      detail: `Nearest existing ancestor is not a directory: ${ancestor.path}`,
    };
  }
  try {
    await access(ancestor.path, fsConstants.W_OK);
    return {
      status: "pass",
      detail: `${resolved} does not exist yet; ${ancestor.path} is writable so WTAgent can create it.`,
    };
  } catch (error) {
    return {
      status: "fail",
      detail: `Cannot create ${resolved}: ${ancestor.path} is not writable (${error.message}).`,
    };
  }
}

async function probeLoopback({
  host = "127.0.0.1",
} = {}) {
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    return { status: "pass", detail: `Loopback bind on ${host} succeeded.` };
  } catch (error) {
    return {
      status: "fail",
      detail: `Loopback bind on ${host} failed: ${error.message}`,
    };
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function probePowerShellCim({
  execFileImpl = execFileAsync,
} = {}) {
  try {
    await execFileImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -First 1 ProcessId | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 1024 * 1024, windowsHide: true },
    );
    return {
      status: "pass",
      detail: "PowerShell CIM process inspection is available.",
    };
  } catch (error) {
    return {
      status: "degraded",
      detail: `PowerShell CIM process inspection failed: ${error.message}. Verified Chrome reuse and stale-state recovery will be disabled until this is fixed.`,
    };
  }
}

async function probeWindowsCommandBridge({
  execFileImpl = execFileAsync,
  findExecutable,
  env = process.env,
  nodePath = process.execPath,
  resolveLaunchPlanImpl = resolveLaunchPlan,
} = {}) {
  try {
    await execFileImpl(nodePath, ["--version"], {
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    return {
      status: "fail",
      detail: `Node executable smoke failed: ${error.message}`,
    };
  }

  const npmPath = await findExecutable("npm.cmd");
  if (!npmPath) {
    return {
      status: "fail",
      detail: "npm.cmd was not found on PATH. Install the official Node.js Windows package so npm shims are available.",
    };
  }

  try {
    const launchPlan = resolveLaunchPlanImpl({
      program: npmPath,
      argv: ["--version"],
      cwd: process.cwd(),
      env,
      platform: "win32",
    });
    await execFileImpl(
      launchPlan.command,
      launchPlan.args,
      {
        maxBuffer: 256 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: launchPlan.windowsVerbatimArguments === true,
      },
    );
    return {
      status: "pass",
      detail: `Node and npm shim launch succeeded (${npmPath}).`,
    };
  } catch (error) {
    return {
      status: "fail",
      detail: `npm.cmd launch smoke failed: ${error.message}`,
    };
  }
}

function isDisallowedBundledToolPath(candidate) {
  const normalized = path.resolve(String(candidate ?? ""))
    .replaceAll("\\", "/")
    .toLowerCase();
  return (
    normalized.includes("/@openai/codex/")
    || normalized.includes("/codex-path/")
    || normalized.includes("/claude-code/")
    || normalized.includes("/.codex/")
  );
}

export async function findExecutableOnPath(name, {
  env = process.env,
  platform = process.platform,
  execFileImpl = execFileAsync,
  reject = null,
} = {}) {
  const finder = platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileImpl(
      finder,
      [name],
      { maxBuffer: 1024 * 1024, windowsHide: true, env },
    );
    return stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && !reject?.(value))
      ?? null;
  } catch {
    return null;
  }
}

export async function collectDoctorReport({
  paths,
  chromePath,
}, {
  platform = process.platform,
  arch = process.arch,
  version = process.version,
  env = process.env,
  osRelease = os.release(),
  discoverChrome = discoverChromeExecutable,
  execFileImpl = execFileAsync,
  inspectProfile = inspectCdpProfileState,
  access = fs.access,
  stat = fs.stat,
  findExecutable = (name) => findExecutableOnPath(name, {
    env,
    platform,
    execFileImpl,
    reject: isDisallowedBundledToolPath,
  }),
} = {}) {
  const items = [];
  const add = (id, label, status, detail, { required = false } = {}) => {
    items.push({ id, label, status, detail, required });
  };

  add(
    "node",
    "Node runtime",
    isSupportedNodeVersion(version) ? "pass" : "fail",
    `Node ${version} on ${platform} ${arch}.`,
    { required: true },
  );

  const isWsl = detectWsl({ platform, env, osRelease });
  if (isWsl) {
    const wsl = getWslSupport({ platform, env, osRelease });
    add(
      "host",
      "Runtime host",
      wsl.supported ? "pass" : "fail",
      wsl.reason,
      { required: true },
    );
  } else {
    const windows = getNativeWindowsSupport({ platform, arch, osRelease });
    add(
      "host",
      "Runtime host",
      windows.supported ? "pass" : "fail",
      platform === "win32"
        ? windows.reason ?? `Native Windows ${osRelease} host detected (${arch}).`
        : `Native ${platform} host detected.`,
      { required: true },
    );
  }

  const appDataResult = await assessDirectoryTarget(paths.appDataDir, { access, stat });
  add("appdata", "Application data directory", appDataResult.status, appDataResult.detail, { required: true });

  const sessionsResult = await assessDirectoryTarget(paths.sessionsDir, { access, stat });
  add("sessions", "Sessions directory", sessionsResult.status, sessionsResult.detail, { required: true });

  const profileParentResult = await assessDirectoryTarget(path.dirname(paths.profileDir), {
    access,
    stat,
  });
  add("profile-parent", "Chrome profile parent", profileParentResult.status, profileParentResult.detail, { required: true });

  try {
    const resolvedChrome = discoverChrome(chromePath, { env, platform });
    add("chrome", "Chrome discovery", "pass", resolvedChrome, { required: true });
  } catch (error) {
    add("chrome", "Chrome discovery", "fail", error.message, { required: true });
  }

  const loopback = await probeLoopback();
  add("loopback", "Loopback/CDP bind", loopback.status, loopback.detail, { required: true });

  if (platform === "win32") {
    const bridge = await probeWindowsCommandBridge({
      execFileImpl,
      findExecutable,
      env,
    });
    add("command-bridge", "Node/npm Windows command shim", bridge.status, bridge.detail, { required: true });

    const cim = await probePowerShellCim({ execFileImpl });
    add("cim", "PowerShell CIM process inspection", cim.status, cim.detail);
  }

  const profileState = await inspectProfile(paths.profileDir).catch((error) => ({
    status: "degraded",
    detail: `Profile state inspection failed: ${error.message}`,
  }));
  add("profile-state", "Chrome profile state", profileState.status, profileState.detail);

  const gitPath = await findExecutable(platform === "win32" ? "git.exe" : "git");
  add(
    "git",
    "Optional Git",
    "info",
    gitPath ? `Found at ${gitPath}.` : "Not found; Git-backed commands remain unavailable but WTAgent can still run.",
  );
  const rgPath = await findExecutable(platform === "win32" ? "rg.exe" : "rg");
  add(
    "rg",
    "Optional ripgrep",
    "info",
    rgPath ? `Found at ${rgPath}.` : "Not found; WTAgent will use its built-in file search fallback.",
  );

  const exitCode = items.some((item) => item.required && item.status === "fail") ? 1 : 0;
  return { items, exitCode };
}
