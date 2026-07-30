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

function fakeBrowserHarness() {
  const existingPage = { name: "existing" };
  const freshPage = { name: "fresh" };
  let closeCommandSent = false;
  let transportClosed = false;
  const context = {
    pages: () => [existingPage],
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
