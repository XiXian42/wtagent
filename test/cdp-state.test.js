import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  acquireCdpProfileLock,
  discoverReusableCdpState,
  inspectCdpProfileState,
  readCdpState,
  reapStaleProfileChrome,
  saveCdpState,
} from "../src/browser/cdp-state.js";

async function createProfile(t) {
  const profileDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wtagent-cdp-state-"),
  );
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  return profileDir;
}

async function createCdpServer(t) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/json/version") {
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl:
        `ws://127.0.0.1:${address.port}/devtools/browser/test`,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("discovers and refreshes a healthy saved CDP browser", async (t) => {
  const profileDir = await createProfile(t);
  const port = await createCdpServer(t);
  await saveCdpState(profileDir, {
    pid: process.pid,
    port,
    profileDir,
  });

  const state = await discoverReusableCdpState(profileDir, {
    listProcesses: async () => [],
    platform: "linux",
  });

  assert.equal(state.pid, process.pid);
  assert.equal(state.port, port);
  assert.match(state.webSocketDebuggerUrl, /devtools\/browser\/test$/);
  assert.deepEqual(await readCdpState(profileDir), state);
});

test("ignores stale saved CDP state", async (t) => {
  const profileDir = await createProfile(t);
  await saveCdpState(profileDir, {
    pid: 2_147_483_647,
    port: 65_534,
    profileDir,
  });

  assert.equal(
    await discoverReusableCdpState(profileDir, {
      listProcesses: async () => [],
    }),
    null,
  );
});

test("rejects saved state when the CDP browser identity changed", async (t) => {
  const profileDir = await createProfile(t);
  await saveCdpState(profileDir, {
    pid: process.pid,
    port: 9333,
    profileDir,
    webSocketDebuggerUrl:
      "ws://127.0.0.1:9333/devtools/browser/original",
  });

  const state = await discoverReusableCdpState(profileDir, {
    fetchVersion: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl:
        "ws://127.0.0.1:9333/devtools/browser/replaced",
    }),
    listProcesses: async () => [],
  });

  assert.equal(state, null);
});

test("discovers a legacy CDP Chrome from its verified process arguments", async (t) => {
  const profileDir = await createProfile(t);
  const state = await discoverReusableCdpState(profileDir, {
    isAlive: () => true,
    fetchVersion: async (endpoint) => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl:
        `${endpoint.replace("http:", "ws:")}/devtools/browser/legacy`,
    }),
    listProcesses: async () => [{
      pid: 4242,
      command: [
        "/Applications/Google Chrome",
        "--remote-debugging-port=9444",
        `--user-data-dir=${profileDir}`,
        "--profile-directory=Default",
      ].join(" "),
    }],
  });

  assert.equal(state.pid, 4242);
  assert.equal(state.port, 9444);
  assert.match(state.webSocketDebuggerUrl, /devtools\/browser\/legacy$/);
});

test("win32 refuses to reuse saved CDP state when the process table cannot verify it", async (t) => {
  const profileDir = await createProfile(t);
  await saveCdpState(profileDir, {
    pid: process.pid,
    port: 9333,
    profileDir,
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/original",
  });

  const state = await discoverReusableCdpState(profileDir, {
    platform: "win32",
    fetchVersion: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/original",
    }),
    listProcesses: async () => {
      throw new Error("CIM blocked");
    },
  });

  assert.equal(state, null);
});

test("win32 verifies saved CDP state with quoted and case-shifted profile paths", async (t) => {
  const profileDir = await createProfile(t);
  await saveCdpState(profileDir, {
    pid: 4242,
    port: 9555,
    profileDir,
    webSocketDebuggerUrl: "ws://127.0.0.1:9555/devtools/browser/live",
  });
  const win32Profile = profileDir.replaceAll("/", "\\").toUpperCase();

  const state = await discoverReusableCdpState(profileDir, {
    platform: "win32",
    isAlive: () => true,
    fetchVersion: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: "ws://127.0.0.1:9555/devtools/browser/live",
    }),
    listProcesses: async () => [{
      pid: 4242,
      command: "chrome.exe --remote-debugging-port=9555 "
        + `--user-data-dir="${win32Profile}"`,
    }],
  });

  assert.equal(state.pid, 4242);
  assert.equal(state.port, 9555);
});

test("profile lock rejects a second live WTAgent session", async (t) => {
  const profileDir = await createProfile(t);
  const release = await acquireCdpProfileLock(profileDir);
  t.after(release);

  await assert.rejects(
    acquireCdpProfileLock(profileDir),
    /Another WTAgent session/,
  );
});

test("profile lock recovers after a dead owner", async (t) => {
  const profileDir = await createProfile(t);
  const lockFile = path.join(profileDir, ".wtagent-session.lock");
  await fs.writeFile(
    lockFile,
    JSON.stringify({ pid: 2_147_483_647, token: "stale" }),
  );

  const release = await acquireCdpProfileLock(profileDir);
  await release();

  await assert.rejects(fs.stat(lockFile), { code: "ENOENT" });
});

test("profile lock never removes a concurrently initializing lock", async (t) => {
  const profileDir = await createProfile(t);
  const lockFile = path.join(profileDir, ".wtagent-session.lock");
  await fs.writeFile(lockFile, "");

  await assert.rejects(
    acquireCdpProfileLock(profileDir),
    /still being initialized/,
  );
  assert.equal((await fs.stat(lockFile)).isFile(), true);
});

test("reaps a stale (dead-CDP) Chrome holding the profile and clears SingletonLock", async (t) => {
  const profileDir = await createProfile(t);
  await fs.symlink("HOST-4242", path.join(profileDir, "SingletonLock"));
  const killed = [];

  const result = await reapStaleProfileChrome(profileDir, {
    isAlive: () => true,
    // CDP endpoint is dead → the holder is stale and must be reaped.
    fetchVersion: async () => {
      throw new Error("connection refused");
    },
    listProcesses: async () => [{
      pid: 4242,
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome `
        + `--remote-debugging-port=57094 --user-data-dir=${profileDir}`,
    }],
    killTree: async (pid) => { killed.push(pid); },
  });

  assert.deepEqual(result.killed, [4242]);
  assert.deepEqual(killed, [4242]);
  // The dangling singleton guard is cleared so the next launch is not blocked.
  await assert.rejects(fs.lstat(path.join(profileDir, "SingletonLock")), {
    code: "ENOENT",
  });
});

test("reap leaves a healthy CDP Chrome and its SingletonLock untouched", async (t) => {
  const profileDir = await createProfile(t);
  await fs.symlink("HOST-4242", path.join(profileDir, "SingletonLock"));
  const killed = [];

  const result = await reapStaleProfileChrome(profileDir, {
    isAlive: () => true,
    // Healthy CDP → this is a live instance, do not touch it.
    fetchVersion: async () => ({ webSocketDebuggerUrl: "ws://x/y" }),
    listProcesses: async () => [{
      pid: 4242,
      command: `Google Chrome --remote-debugging-port=57094 --user-data-dir=${profileDir}`,
    }],
    killTree: async (pid) => { killed.push(pid); },
  });

  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
  assert.equal(
    (await fs.lstat(path.join(profileDir, "SingletonLock"))).isSymbolicLink(),
    true,
  );
});

test("reap removes profile-holding Chrome helpers without CDP ports", async (t) => {
  const profileDir = await createProfile(t);
  await fs.writeFile(path.join(profileDir, "SingletonLock"), "stale");
  const killed = [];

  const result = await reapStaleProfileChrome(profileDir, {
    platform: "win32",
    isAlive: () => true,
    fetchVersion: async () => {
      throw new Error("no live CDP owner");
    },
    listProcesses: async () => [{
      pid: 5252,
      command: `chrome.exe --type=renderer --user-data-dir="${profileDir}"`,
    }],
    killTree: async (pid) => { killed.push(pid); },
  });

  assert.deepEqual(result.killed, [5252]);
  assert.deepEqual(killed, [5252]);
  await assert.rejects(fs.stat(path.join(profileDir, "SingletonLock")), {
    code: "ENOENT",
  });
});

test("reap preserves helpers when one verified healthy CDP owner exists", async (t) => {
  const profileDir = await createProfile(t);
  const killed = [];

  const result = await reapStaleProfileChrome(profileDir, {
    platform: "win32",
    isAlive: () => true,
    fetchVersion: async () => ({ webSocketDebuggerUrl: "ws://healthy" }),
    listProcesses: async () => [
      {
        pid: 6262,
        command: `chrome.exe --remote-debugging-port=9333 --user-data-dir="${profileDir}"`,
      },
      {
        pid: 6263,
        command: `chrome.exe --type=renderer --user-data-dir="${profileDir}"`,
      },
    ],
    killTree: async (pid) => { killed.push(pid); },
  });

  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
});

test("profile inspection reports degraded win32 state when CIM verification is unavailable", async (t) => {
  const profileDir = await createProfile(t);
  await saveCdpState(profileDir, {
    pid: process.pid,
    port: 9333,
    profileDir,
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/original",
  });

  const result = await inspectCdpProfileState(profileDir, {
    platform: "win32",
    fetchVersion: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/original",
    }),
    listProcesses: async () => {
      throw new Error("Access denied");
    },
  });

  assert.equal(result.status, "degraded");
  assert.match(result.detail, /cannot verify saved CDP state against PowerShell CIM/i);
});
