import { spawn } from "node:child_process";
import { resolveLaunchPlan } from "../platform/command-launcher.js";
import { fetchJson, NETWORK_TIMEOUT_MS } from "../shared/fetch-json.js";
import { getPackageName, getPackageVersion } from "../shared/package-info.js";

export const UPDATE_CHECK_TIMEOUT_MS = NETWORK_TIMEOUT_MS;
export const UPDATE_COMMAND_TIMEOUT_MS = 10_000;
export const INSTALL_TIMEOUT_MS = 120_000;
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
export const MANUAL_INSTALL_COMMAND =
  `npm install -g wtagent@latest --registry=${OFFICIAL_NPM_REGISTRY}`;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function npmRegistryLatestUrl(name = getPackageName()) {
  return `${OFFICIAL_NPM_REGISTRY}${encodeURIComponent(name)}/latest`;
}

export function parseVersion(value) {
  const match = String(value ?? "").trim().match(VERSION_RE);
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

export function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index] < parsedRight.core[index] ? -1 : 1;
    }
  }
  if (!parsedLeft.pre && !parsedRight.pre) {
    return 0;
  }
  if (!parsedLeft.pre) {
    return 1;
  }
  if (!parsedRight.pre) {
    return -1;
  }
  if (parsedLeft.pre === parsedRight.pre) {
    return 0;
  }
  return parsedLeft.pre < parsedRight.pre ? -1 : 1;
}

export function isRemoteNewer(remote, local = getPackageVersion()) {
  const comparison = compareVersions(local, remote);
  return comparison != null && comparison < 0;
}

export async function fetchLatestVersion({
  fetchImpl,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  packageName = getPackageName(),
} = {}) {
  const document = await fetchJson(npmRegistryLatestUrl(packageName), {
    fetchImpl,
    timeoutMs,
  });
  return typeof document?.version === "string" && document.version.trim()
    ? document.version.trim()
    : null;
}

export async function installLatest({
  spawnImpl = spawn,
  planCommandImpl = (program, argv) => resolveLaunchPlan({ program, argv }),
  timeoutMs = INSTALL_TIMEOUT_MS,
  stdio = "inherit",
} = {}) {
  const plan = planCommandImpl("npm", [
    "install",
    "-g",
    "wtagent@latest",
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
  ]);
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnImpl(plan.command, plan.args, {
        stdio,
        shell: plan.shell,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (error) {
      finish({ ok: false, error });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: new Error("npm install timed out.") });
    }, timeoutMs);

    child.once("error", (error) => {
      finish({ ok: false, error });
    });
    child.once("exit", (code) => {
      finish({ ok: code === 0, code });
    });
  });
}

export async function runSelfUpdate({
  fetchLatest = fetchLatestVersion,
  install = installLatest,
  write = console.log,
  writeError = console.error,
  currentVersion = getPackageVersion(),
} = {}) {
  const latest = await fetchLatest({ timeoutMs: UPDATE_COMMAND_TIMEOUT_MS });
  if (!latest) {
    writeError("Could not check npm for the latest WTAgent version.");
    writeError(`Install it manually: ${MANUAL_INSTALL_COMMAND}`);
    return { status: "error" };
  }
  if (!isRemoteNewer(latest, currentVersion)) {
    write(`Already up to date (${currentVersion}).`);
    return { status: "current", currentVersion, latest };
  }

  write(`Updating WTAgent ${currentVersion} → ${latest} ...`);
  const result = await install();
  if (!result.ok) {
    writeError("Update failed.");
    writeError(`Install it manually: ${MANUAL_INSTALL_COMMAND}`);
    return { status: "error", currentVersion, latest };
  }
  write(`Updated to ${latest}. Run wtagent again to use the new version.`);
  return { status: "updated", currentVersion, latest };
}
