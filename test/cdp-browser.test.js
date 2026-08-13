import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { launchAndConnectCdpChrome } from "../src/browser/cdp-browser.js";

function reusableState() {
  return {
    pid: 4242,
    port: 9333,
    endpoint: "http://127.0.0.1:9333",
    profileDir: "/tmp/wtagent-test-profile",
    webSocketDebuggerUrl:
      "ws://127.0.0.1:9333/devtools/browser/reused",
  };
}

function fakeBrowserHarness({
  existingPages = [{
    name: "existing",
    url: () => "https://chatgpt.com/c/a",
  }],
} = {}) {
  const existingPage = existingPages[0];
  const freshPage = { name: "fresh" };
  let closeCommandSent = false;
  let transportClosed = false;
  const context = {
    pages: () => existingPages,
    newPage: async () => freshPage,
  };
  const browser = {
    contexts: () => [context],
    newBrowserCDPSession: async () => ({
      send: async (command) => {
        assert.equal(command, "Browser.close");
        closeCommandSent = true;
      },
      detach: async () => {},
    }),
    close: async () => {
      transportClosed = true;
    },
  };
  return {
    browser,
    context,
    existingPage,
    freshPage,
    get closeCommandSent() {
      return closeCommandSent;
    },
    get transportClosed() {
      return transportClosed;
    },
  };
}

function reusableDependencies(harness, {
  discoverReusable,
  spawnChrome = () => {
    throw new Error("Chrome should not be spawned");
  },
} = {}) {
  let released = false;
  let stateRemoved = false;
  return {
    dependencies: {
      acquireProfileLock: async () => async () => {
        released = true;
      },
      connectOverCDP: async () => harness.browser,
      discoverReusable,
      fetchVersion: async () => ({
        webSocketDebuggerUrl:
          "ws://127.0.0.1:9333/devtools/browser/reused",
      }),
      removeState: async (_profileDir, expected) => {
        if (expected) {
          stateRemoved = true;
        }
      },
      spawnChrome,
      waitForExit: async () => true,
    },
    get released() {
      return released;
    },
    get stateRemoved() {
      return stateRemoved;
    },
  };
}

test("reuses a healthy CDP browser and creates a fresh page", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, controls.dependencies);

  assert.equal(connection.reused, true);
  assert.equal(connection.page, harness.freshPage);
  assert.notEqual(connection.page, harness.existingPage);

  await connection.close();
  assert.equal(harness.closeCommandSent, true);
  assert.equal(harness.transportClosed, true);
  assert.equal(controls.stateRemoved, true);
  assert.equal(controls.released, true);
});

test("adopts the existing browser after Chrome singleton handoff", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  let discoveryCount = 0;
  const child = new EventEmitter();
  child.pid = 8181;
  child.exitCode = null;
  child.signalCode = null;
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => {
      discoveryCount += 1;
      return discoveryCount === 1 ? null : state;
    },
    spawnChrome: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  controls.dependencies.reserveCdpPort = async () => 9444;
  controls.dependencies.waitForReady = async () => {
    child.exitCode = 0;
    throw new Error(
      "Chrome exited before CDP became ready (exit=0, signal=null).",
    );
  };

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, controls.dependencies);

  assert.equal(discoveryCount, 2);
  assert.equal(connection.reused, true);
  assert.equal(connection.endpoint, state.endpoint);
  await connection.close();
});

test("does not kill a reused PID after the spawned Chrome has exited", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const child = new EventEmitter();
  child.pid = state.pid;
  child.exitCode = null;
  child.signalCode = null;
  let killed = false;
  let released = false;

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, {
    acquireProfileLock: async () => async () => {
      released = true;
    },
    connectOverCDP: async () => harness.browser,
    discoverReusable: async () => null,
    fetchVersion: async () => ({
      webSocketDebuggerUrl: state.webSocketDebuggerUrl,
    }),
    killTree: async () => {
      killed = true;
    },
    matchesState: async () => false,
    removeState: async () => {},
    reserveCdpPort: async () => state.port,
    saveState: async () => state,
    spawnChrome: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    waitForExit: async () => false,
    waitForReady: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: state.webSocketDebuggerUrl,
    }),
  });
  child.exitCode = 0;

  await assert.rejects(connection.close(), /did not exit/);
  assert.equal(killed, false);
  assert.equal(released, true);
});

test("times out a hung connect, kills the spawned Chrome, and clears state", async (t) => {
  const state = reusableState();
  const child = new EventEmitter();
  child.pid = 7777;
  child.exitCode = null;
  child.signalCode = null;
  let killed = null;
  let stateCleared = false;
  let released = false;

  const connect = launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, {
    acquireProfileLock: async () => async () => { released = true; },
    // Simulate the real bug: the WS connects but protocol init never resolves.
    connectOverCDP: () => new Promise(() => {}),
    discoverReusable: async () => null,
    fetchVersion: async () => ({ webSocketDebuggerUrl: state.webSocketDebuggerUrl }),
    reapStale: async () => ({ killed: [] }),
    killTree: async (pid) => { killed = pid; },
    matchesState: async () => false,
    removeState: async (_dir, expected) => { if (expected) stateCleared = true; },
    reserveCdpPort: async () => state.port,
    saveState: async () => state,
    spawnChrome: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    waitForExit: async () => true,
    waitForReady: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: state.webSocketDebuggerUrl,
    }),
    connectTimeoutMs: 50,
  });

  await assert.rejects(connect, (error) => {
    assert.match(error.message, /Timed out connecting to Chrome CDP/);
    assert.match(error.message, /wtagent logout/);
    return true;
  });
  // The hung instance we launched was killed and its stale state removed.
  assert.equal(killed, child.pid);
  assert.equal(stateCleared, true);
  assert.equal(released, true);
});

test("reaps stale profile holders before launching a fresh Chrome", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const child = new EventEmitter();
  child.pid = 5150;
  child.exitCode = null;
  child.signalCode = null;
  const order = [];

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, {
    acquireProfileLock: async () => async () => {},
    connectOverCDP: async () => harness.browser,
    discoverReusable: async () => null,
    fetchVersion: async () => ({ webSocketDebuggerUrl: state.webSocketDebuggerUrl }),
    reapStale: async () => { order.push("reap"); return { killed: [999] }; },
    killTree: async () => {},
    matchesState: async () => false,
    removeState: async () => {},
    reserveCdpPort: async () => state.port,
    saveState: async () => state,
    spawnChrome: () => {
      order.push("spawn");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    waitForExit: async () => true,
    waitForReady: async () => ({
      Browser: "Chrome/Test",
      webSocketDebuggerUrl: state.webSocketDebuggerUrl,
    }),
  });

  // Reaping stale holders must happen before the fresh spawn, or the new
  // Chrome hangs on the locked profile.
  assert.deepEqual(order, ["reap", "spawn"]);
  await connection.close();
});

test("disconnect drops only the transport and leaves Chrome untouched", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, controls.dependencies);

  await connection.disconnect();

  // The Playwright transport is closed, but Chrome is neither asked to exit
  // (no Browser.close command) nor killed, and the CDP state + profile lock
  // stay intact so the next launch can reuse the same browser.
  assert.equal(harness.transportClosed, true);
  assert.equal(harness.closeCommandSent, false);
  assert.equal(controls.stateRemoved, false);
  assert.equal(controls.released, false);
});

test("reused browser prefers an existing tab on the preferred conversation", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
    preferredUrl: "https://chatgpt.com/c/a",
  }, controls.dependencies);

  assert.equal(connection.page, harness.existingPage);
  assert.notEqual(connection.page, harness.freshPage);
});

test("reused browser creates a fresh tab when no page matches the preferred URL", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
    preferredUrl: "https://chatgpt.com/c/other",
  }, controls.dependencies);

  assert.equal(connection.page, harness.freshPage);
});
