import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { replaceFileAtomic } from "../shared/atomic-write.js";

const execFileAsync = promisify(execFile);
const CDP_STATE_FILE = ".wtagent-cdp.json";
const PROFILE_LOCK_FILE = ".wtagent-session.lock";
const STATE_VERSION = 1;
const LOCK_INITIALIZATION_GRACE_MS = 5_000;

function statePath(profileDir) {
  return path.join(profileDir, CDP_STATE_FILE);
}

function lockPath(profileDir) {
  return path.join(profileDir, PROFILE_LOCK_FILE);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600 },
    );
    await replaceFileAtomic(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readInitializedLock(filePath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const value = await readJson(filePath);
    if (
      Number.isSafeInteger(Number(value?.pid))
      && Number(value.pid) > 0
      && typeof value.token === "string"
      && value.token
    ) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function waitForProcessExit(
  pid,
  timeoutMs,
  { isAlive = isProcessAlive } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

export async function fetchCdpVersion(endpoint, timeoutMs = 1_500) {
  const response = await fetch(`${endpoint}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`CDP health check returned HTTP ${response.status}.`);
  }
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error("CDP health check did not return a WebSocket endpoint.");
  }
  return version;
}

function normalizeCandidate(candidate, profileDir) {
  const pid = Number(candidate?.pid);
  const port = Number(candidate?.port);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(port)
    || port <= 0
    || port > 65_535
  ) {
    return null;
  }
  if (
    candidate.profileDir
    && !profileDirsMatch(candidate.profileDir, profileDir)
  ) {
    return null;
  }
  return {
    stateVersion: STATE_VERSION,
    pid,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    profileDir,
    startedAt: candidate.startedAt ?? null,
  };
}

function normalizeProfilePath(value, platform = process.platform) {
  const input = String(value ?? "");
  const resolved = platform === "win32"
    ? path.win32.resolve(input)
    : path.resolve(input);
  if (platform !== "win32") {
    return resolved;
  }
  return path.win32.normalize(resolved).replaceAll("/", "\\").toLowerCase();
}

function profileDirsMatch(left, right, platform = process.platform) {
  return normalizeProfilePath(left, platform) === normalizeProfilePath(right, platform);
}

async function probeCandidate(candidate, profileDir, {
  isAlive = isProcessAlive,
  fetchVersion = fetchCdpVersion,
} = {}) {
  const normalized = normalizeCandidate(candidate, profileDir);
  if (!normalized || !isAlive(normalized.pid)) {
    return null;
  }
  try {
    const version = await fetchVersion(normalized.endpoint);
    if (
      candidate.webSocketDebuggerUrl
      && candidate.webSocketDebuggerUrl !== version.webSocketDebuggerUrl
    ) {
      return null;
    }
    return {
      ...normalized,
      browser: version.Browser ?? null,
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    };
  } catch {
    return null;
  }
}

export async function readCdpState(profileDir) {
  return await readJson(statePath(path.resolve(profileDir)));
}

export async function saveCdpState(profileDir, state) {
  const resolvedProfile = path.resolve(profileDir);
  const normalized = normalizeCandidate(state, resolvedProfile);
  if (!normalized) {
    throw new Error("Refusing to save invalid WTAgent CDP state.");
  }
  const value = {
    ...normalized,
    browser: state.browser ?? null,
    webSocketDebuggerUrl: state.webSocketDebuggerUrl ?? null,
    startedAt: state.startedAt ?? new Date().toISOString(),
  };
  await writeJsonAtomic(statePath(resolvedProfile), value);
  return value;
}

export async function removeCdpState(profileDir, expected = null) {
  const filePath = statePath(path.resolve(profileDir));
  if (expected) {
    const current = await readJson(filePath);
    if (
      current
      && (
        Number(current.pid) !== Number(expected.pid)
        || Number(current.port) !== Number(expected.port)
      )
    ) {
      return false;
    }
  }
  await fs.rm(filePath, { force: true });
  return true;
}

async function readProcessTable() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.ProcessId),
      command: String(entry.CommandLine ?? ""),
    }));
  }

  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,command="],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match
      ? [{ pid: Number(match[1]), command: match[2].trim() }]
      : [];
  });
}

function commandUsesProfile(command, profileDir, platform = process.platform) {
  const inline = command.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const separated = command.match(/--user-data-dir\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const raw = inline?.[1] ?? inline?.[2] ?? inline?.[3]
    ?? separated?.[1] ?? separated?.[2] ?? separated?.[3]
    ?? null;
  return raw ? profileDirsMatch(raw, profileDir, platform) : false;
}

function candidateFromProcess(entry, profileDir, platform = process.platform) {
  if (
    !entry.command
    || entry.command.includes("--type=")
    || !commandUsesProfile(entry.command, profileDir, platform)
  ) {
    return null;
  }
  const port = entry.command.match(/--remote-debugging-port=(\d+)/)?.[1];
  return port
    ? { pid: entry.pid, port: Number(port), profileDir }
    : null;
}

function profileHolderFromProcess(entry, profileDir, platform = process.platform) {
  if (!entry.command || !commandUsesProfile(entry.command, profileDir, platform)) {
    return null;
  }
  const pid = Number(entry.pid);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, command: entry.command }
    : null;
}

async function singletonOwnerPid(profileDir) {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const target = await fs.readlink(path.join(profileDir, "SingletonLock"));
    const pid = Number(target.match(/-(\d+)$/)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function processMatchesCdpState(state, {
  listProcesses = readProcessTable,
  platform = process.platform,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const profileDir = pathApi.resolve(state.profileDir);
  const port = Number(state.port);
  try {
    const processes = await listProcesses();
    return processes.some((entry) => {
      const candidate = candidateFromProcess(entry, profileDir, platform);
      return (
        candidate?.pid === Number(state.pid)
        && candidate.port === port
      );
    });
  } catch {
    return false;
  }
}

function processTableContainsState(
  processes,
  state,
  profileDir,
  platform = process.platform,
) {
  const port = Number(state.port);
  const pid = Number(state.pid);
  return processes.some((entry) => {
    const candidate = candidateFromProcess(entry, profileDir, platform);
    return candidate?.pid === pid && candidate.port === port;
  });
}

export async function discoverReusableCdpState(profileDir, {
  isAlive = isProcessAlive,
  fetchVersion = fetchCdpVersion,
  listProcesses = readProcessTable,
  platform = process.platform,
} = {}) {
  const resolvedProfile = path.resolve(profileDir);
  const requireVerifiedProcessTable = platform === "win32";
  const saved = await readCdpState(resolvedProfile);
  let processes;
  try {
    processes = await listProcesses();
  } catch {
    if (requireVerifiedProcessTable) {
      return null;
    }
    processes = null;
  }

  const savedHealthy = await probeCandidate(saved, resolvedProfile, {
    isAlive,
    fetchVersion,
  });
  if (
    savedHealthy
    && (!requireVerifiedProcessTable || processTableContainsState(
      processes ?? [],
      savedHealthy,
      resolvedProfile,
      platform,
    ))
  ) {
    return await saveCdpState(resolvedProfile, savedHealthy);
  }

  if (!processes) {
    return null;
  }

  const rawCandidates = processes
    .map((entry) => candidateFromProcess(entry, resolvedProfile, platform))
    .filter(Boolean);
  const uniqueCandidates = [...new Map(
    rawCandidates.map((candidate) => [
      `${candidate.pid}:${candidate.port}`,
      candidate,
    ]),
  ).values()];
  const healthy = (await Promise.all(
    uniqueCandidates.map((candidate) =>
      probeCandidate(candidate, resolvedProfile, {
        isAlive,
        fetchVersion,
      })
    ),
  )).filter(Boolean);

  if (healthy.length === 0) {
    return null;
  }
  if (healthy.length === 1) {
    return await saveCdpState(resolvedProfile, healthy[0]);
  }

  const ownerPid = await singletonOwnerPid(resolvedProfile);
  const singleton = healthy.find((candidate) => candidate.pid === ownerPid);
  if (singleton) {
    return await saveCdpState(resolvedProfile, singleton);
  }

  throw new Error(
    `Multiple live CDP Chrome instances use ${resolvedProfile}; `
    + "close the extra instances before starting WTAgent.",
  );
}

// Kills Chrome processes bound to this profile whose CDP endpoint is dead, and
// clears Chrome's singleton guard files. A half-dead prior instance (main
// process gone or unresponsive, but renderer children still holding the
// profile) makes a freshly launched Chrome hang during profile initialization:
// the new CDP port answers HTTP/WS, but the browser main thread never becomes
// usable, so connectOverCDP times out. Reaping those stale holders first
// prevents the hang. Only ever touches processes that use THIS profile dir, and
// never a live/healthy CDP instance. Best-effort.
export async function reapStaleProfileChrome(profileDir, {
  isAlive = isProcessAlive,
  fetchVersion = fetchCdpVersion,
  listProcesses = readProcessTable,
  killTree = null,
  platform = process.platform,
} = {}) {
  const resolvedProfile = path.resolve(profileDir);
  let processes;
  try {
    processes = await listProcesses();
  } catch {
    return { killed: [] };
  }

  const holders = processes
    .map((entry) => profileHolderFromProcess(entry, resolvedProfile, platform))
    .filter(Boolean);
  const candidates = processes
    .map((entry) => candidateFromProcess(entry, resolvedProfile, platform))
    .filter(Boolean);

  // A healthy main browser owns every helper/renderer using this profile.
  // Never reap individual children from a verified live instance.
  let hasHealthyCdpOwner = false;
  for (const candidate of candidates) {
    try {
      await fetchVersion(`http://127.0.0.1:${candidate.port}`);
      hasHealthyCdpOwner = true;
      break;
    } catch {
      // Continue until one verified owner is found.
    }
  }
  if (hasHealthyCdpOwner) {
    return { killed: [] };
  }

  const killed = [];
  for (const holder of holders) {
    if (isAlive(holder.pid) && typeof killTree === "function") {
      await killTree(holder.pid).catch(() => {});
    }
    killed.push(holder.pid);
  }

  // Chrome's singleton profile guard is a symlink; a crashed instance can leave
  // it dangling and block the next launch. Clear it when we reaped holders or
  // when it points at a dead pid.
  const ownerPid = await singletonOwnerPid(resolvedProfile);
  if (killed.length > 0 || (ownerPid && !isAlive(ownerPid))) {
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await fs.rm(path.join(resolvedProfile, name), { force: true })
        .catch(() => {});
    }
  }

  return { killed };
}

export async function inspectCdpProfileState(profileDir, {
  isAlive = isProcessAlive,
  fetchVersion = fetchCdpVersion,
  listProcesses = readProcessTable,
  platform = process.platform,
} = {}) {
  const resolvedProfile = path.resolve(profileDir);
  const diagnostics = [];

  const lock = await readJson(lockPath(resolvedProfile));
  if (lock?.pid) {
    const alive = isAlive(Number(lock.pid));
    diagnostics.push(
      alive
        ? `profile lock held by live pid=${lock.pid}`
        : `stale profile lock references dead pid=${lock.pid}`,
    );
  } else {
    diagnostics.push("no WTAgent profile lock");
  }

  const saved = await readJson(statePath(resolvedProfile));
  if (!saved) {
    diagnostics.push("no saved CDP state");
    return {
      status: "pass",
      detail: diagnostics.join("; "),
    };
  }

  const savedHealthy = await probeCandidate(saved, resolvedProfile, {
    isAlive,
    fetchVersion,
  });
  if (!savedHealthy) {
    diagnostics.push(`saved CDP state for pid=${saved.pid} is stale or unhealthy`);
    return {
      status: "degraded",
      detail: diagnostics.join("; "),
    };
  }

  if (platform !== "win32") {
    diagnostics.push(`saved CDP state is healthy for pid=${savedHealthy.pid}`);
    return {
      status: "pass",
      detail: diagnostics.join("; "),
    };
  }

  let processes;
  try {
    processes = await listProcesses();
  } catch (error) {
    diagnostics.push(`cannot verify saved CDP state against PowerShell CIM: ${error.message}`);
    return {
      status: "degraded",
      detail: diagnostics.join("; "),
    };
  }

  if (!processTableContainsState(processes, savedHealthy, resolvedProfile, platform)) {
    diagnostics.push(`saved CDP state for pid=${savedHealthy.pid} could not be verified against the current process table`);
    return {
      status: "degraded",
      detail: diagnostics.join("; "),
    };
  }

  diagnostics.push(`saved CDP state is verified for pid=${savedHealthy.pid}`);
  return {
    status: "pass",
    detail: diagnostics.join("; "),
  };
}

export async function acquireCdpProfileLock(profileDir, {
  ownerPid = process.pid,
  isAlive = isProcessAlive,
} = {}) {
  const resolvedProfile = path.resolve(profileDir);
  const filePath = lockPath(resolvedProfile);
  const token = randomUUID();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: ownerPid,
            token,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
      } finally {
        await handle.close();
      }

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        const current = await readJson(filePath);
        if (current?.token === token) {
          await fs.rm(filePath, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const existing = await readInitializedLock(filePath);
      if (existing && isAlive(Number(existing.pid))) {
        throw new Error(
          `Another WTAgent session (pid=${existing.pid}) is already using `
          + `${resolvedProfile}.`,
        );
      }
      if (!existing) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (
          stat
          && Date.now() - stat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS
        ) {
          throw new Error(
            `The WTAgent profile lock at ${filePath} is still being initialized.`,
          );
        }
      }
      await fs.rm(filePath, { force: true });
    }
  }

  throw new Error(`Could not acquire the WTAgent profile lock at ${filePath}.`);
}
