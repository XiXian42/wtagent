import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ensureCdpPageTarget,
  launchAndConnectCdpChrome,
} from "../src/browser/cdp-browser.js";

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
    targetId: "target-existing",
    url: () => "https://chatgpt.com/c/a",
  }],
} = {}) {
  const existingPage = existingPages[0];
  const freshPage = { name: "fresh", targetId: "target-fresh" };
  let closeCommandSent = false;
  let transportClosed = false;
  const context = {
    pages: () => existingPages,
    newPage: async () => freshPage,
    newCDPSession: async (page) => ({
      send: async (command) => {
        assert.equal(command, "Target.getTargetInfo");
        return { targetInfo: { targetId: page.targetId ?? null } };
      },
      detach: async () => {},
    }),
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
  ensurePageTarget = async () => false,
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
      ensurePageTarget,
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

test("creates a blank CDP page target when a reused Chrome has no windows", async () => {
  const calls = [];
  const created = await ensureCdpPageTarget("http://127.0.0.1:9333", {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET" });
      if (url.endsWith("/json/list")) {
        return { ok: true, async json() { return []; } };
      }
      return {
        ok: true,
        async json() {
          return {
            type: "page",
            webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/new",
          };
        },
      };
    },
  });

  assert.equal(created, true);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:9333/json/list", method: "GET" },
    {
      url: "http://127.0.0.1:9333/json/new?about%3Ablank",
      method: "PUT",
    },
  ]);
});

test("keeps existing CDP page targets untouched", async () => {
  let requests = 0;
  const created = await ensureCdpPageTarget("http://127.0.0.1:9333", {
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        async json() {
          return [{ type: "page", url: "https://gemini.google.com/app" }];
        },
      };
    },
  });

  assert.equal(created, false);
  assert.equal(requests, 1);
});

test("repairs a no-window reused Chrome before Playwright connects", async () => {
  const harness = fakeBrowserHarness({ existingPages: [] });
  const state = reusableState();
  const order = [];
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
    ensurePageTarget: async (endpoint) => {
      assert.equal(endpoint, state.endpoint);
      order.push("ensure-page");
      return true;
    },
  });
  controls.dependencies.connectOverCDP = async () => {
    order.push("connect");
    return harness.browser;
  };

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, controls.dependencies);

  assert.deepEqual(order, ["ensure-page", "connect"]);
  assert.equal(connection.page, harness.freshPage);
  await connection.close();
});

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

test("detach drops the transport and lock but leaves Chrome reusable", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
  }, controls.dependencies);

  await connection.detach();

  assert.equal(harness.transportClosed, true);
  assert.equal(harness.closeCommandSent, false);
  assert.equal(controls.stateRemoved, false);
  assert.equal(controls.released, true);
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
  assert.equal(connection.preferredTabMatched, true);
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
  assert.equal(connection.preferredTabMatched, false);
});

test("reused browser follows a saved target through provisional canonicalization", async () => {
  const canonicalPage = {
    name: "canonical",
    targetId: "target-conversation",
    url: () => "https://chatgpt.com/c/canonical",
  };
  const harness = fakeBrowserHarness({ existingPages: [canonicalPage] });
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
    preferredUrl: "https://chatgpt.com/c/WEB:provisional",
    preferredTargetId: "target-conversation",
  }, controls.dependencies);

  assert.equal(connection.page, canonicalPage);
  assert.equal(connection.targetId, "target-conversation");
  assert.equal(connection.preferredTargetMatched, true);
  assert.equal(connection.preferredTabMatched, false);
});

test("strict recovery follows only the exact target without mutating Chrome", async () => {
  const canonicalPage = {
    name: "canonical",
    targetId: "target-recovery",
    url: () => "https://chatgpt.com/c/canonicalized",
  };
  const harness = fakeBrowserHarness({ existingPages: [canonicalPage] });
  const state = reusableState();
  let newPageCalls = 0;
  let ensureCalls = 0;
  let killCalls = 0;
  let reapCalls = 0;
  harness.context.newPage = async () => {
    newPageCalls += 1;
    throw new Error("strict recovery must not create a page");
  };
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
    ensurePageTarget: async () => {
      ensureCalls += 1;
      throw new Error("strict recovery must not create a CDP target");
    },
  });
  controls.dependencies.killTree = async () => {
    killCalls += 1;
  };
  controls.dependencies.reapStale = async () => {
    reapCalls += 1;
  };

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
    minimized: true,
    preferredUrl: "https://chatgpt.com/c/WEB:old-provisional",
    preferredTargetId: "target-recovery",
    exactTargetOnly: true,
  }, controls.dependencies);

  assert.equal(connection.page, canonicalPage);
  assert.equal(connection.targetId, "target-recovery");
  assert.equal(connection.preferredTargetMatched, true);
  assert.equal(connection.preferredTabMatched, false);
  assert.equal(connection.exactTargetOnly, true);
  assert.equal(newPageCalls, 0);
  assert.equal(ensureCalls, 0);
  assert.equal(killCalls, 0);
  assert.equal(reapCalls, 0);
  assert.equal(await connection.minimize(), false);
  assert.equal(await connection.restore(), false);

  await connection.close();
  assert.equal(harness.transportClosed, true);
  assert.equal(harness.closeCommandSent, false);
  assert.equal(controls.stateRemoved, false);
  assert.equal(controls.released, true);
  assert.equal(killCalls, 0);
});

test("strict recovery rejects a URL-matching substitute target", async () => {
  const preferredUrl = "https://chatgpt.com/c/recovery";
  const substitute = {
    name: "substitute",
    targetId: "target-substitute",
    url: () => preferredUrl,
  };
  const harness = fakeBrowserHarness({ existingPages: [substitute] });
  const state = reusableState();
  let newPageCalls = 0;
  let ensureCalls = 0;
  let killCalls = 0;
  let reapCalls = 0;
  harness.context.newPage = async () => {
    newPageCalls += 1;
    return harness.freshPage;
  };
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
    ensurePageTarget: async () => {
      ensureCalls += 1;
      return true;
    },
  });
  controls.dependencies.killTree = async () => {
    killCalls += 1;
  };
  controls.dependencies.reapStale = async () => {
    reapCalls += 1;
  };

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: state.profileDir,
      preferredUrl,
      preferredTargetId: "target-missing",
      exactTargetOnly: true,
    }, controls.dependencies),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  assert.equal(newPageCalls, 0);
  assert.equal(ensureCalls, 0);
  assert.equal(killCalls, 0);
  assert.equal(reapCalls, 0);
  assert.equal(controls.stateRemoved, false);
  assert.equal(controls.released, true);
  assert.equal(harness.transportClosed, true);
  assert.equal(harness.closeCommandSent, false);
});

test("strict recovery timeout preserves Chrome and its reusable state", async () => {
  const state = reusableState();
  let removeCalls = 0;
  let killCalls = 0;
  let released = false;

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: state.profileDir,
      preferredTargetId: "target-existing",
      exactTargetOnly: true,
    }, {
      acquireProfileLock: async () => async () => {
        released = true;
      },
      connectOverCDP: () => new Promise(() => {}),
      discoverReusable: async () => state,
      removeState: async () => {
        removeCalls += 1;
      },
      killTree: async () => {
        killCalls += 1;
      },
      connectTimeoutMs: 20,
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  assert.equal(removeCalls, 0);
  assert.equal(killCalls, 0);
  assert.equal(released, true);
});

test("a late strict CDP connection is disconnected after timeout", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  let resolveConnect;
  const lateConnection = new Promise((resolve) => {
    resolveConnect = resolve;
  });
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });
  controls.dependencies.connectOverCDP = () => lateConnection;
  controls.dependencies.connectTimeoutMs = 20;
  controls.dependencies.transportCloseTimeoutMs = 20;

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: state.profileDir,
      preferredTargetId: "target-existing",
      exactTargetOnly: true,
    }, controls.dependencies),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  resolveConnect(harness.browser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.transportClosed, true);
  assert.equal(controls.released, true);
  assert.equal(controls.stateRemoved, false);
});

test("strict target probing is bounded and releases the profile lock", async () => {
  const harness = fakeBrowserHarness();
  const state = reusableState();
  let released = false;
  harness.context.newCDPSession = async () => ({
    send: async () => await new Promise(() => {}),
    detach: async () => {},
  });
  const startedAt = Date.now();

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: state.profileDir,
      preferredTargetId: "target-existing",
      exactTargetOnly: true,
    }, {
      acquireProfileLock: async () => async () => {
        released = true;
      },
      connectOverCDP: async () => harness.browser,
      discoverReusable: async () => state,
      connectTimeoutMs: 25,
      transportCloseTimeoutMs: 25,
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(released, true);
  assert.equal(harness.transportClosed, true);
});

test("a hung strict transport close cannot retain the profile lock", async () => {
  const harness = fakeBrowserHarness({
    existingPages: [{
      name: "other",
      targetId: "target-other",
      url: () => "https://chatgpt.com/c/other",
    }],
  });
  const state = reusableState();
  let released = false;
  harness.browser.close = async () => await new Promise(() => {});
  const startedAt = Date.now();

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: state.profileDir,
      preferredTargetId: "target-missing",
      exactTargetOnly: true,
    }, {
      acquireProfileLock: async () => async () => {
        released = true;
      },
      connectOverCDP: async () => harness.browser,
      discoverReusable: async () => state,
      connectTimeoutMs: 25,
      transportCloseTimeoutMs: 25,
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(released, true);
});

test("strict recovery never repairs or replaces missing CDP state", async () => {
  const harness = fakeBrowserHarness();
  let removeCalls = 0;
  let reapCalls = 0;
  let spawnCalls = 0;
  let connectCalls = 0;
  let released = false;

  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: "/tmp/wtagent-test-profile",
      preferredTargetId: "target-existing",
      exactTargetOnly: true,
    }, {
      acquireProfileLock: async () => async () => {
        released = true;
      },
      connectOverCDP: async () => {
        connectCalls += 1;
        return harness.browser;
      },
      discoverReusable: async () => null,
      removeState: async () => {
        removeCalls += 1;
      },
      reapStale: async () => {
        reapCalls += 1;
      },
      spawnChrome: () => {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );

  assert.equal(removeCalls, 0);
  assert.equal(reapCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(connectCalls, 0);
  assert.equal(released, true);
});

test("strict recovery validates its target before acquiring a profile lock", async () => {
  let lockCalls = 0;
  await assert.rejects(
    launchAndConnectCdpChrome({
      executablePath: "/fake/chrome",
      profileDir: "/tmp/wtagent-test-profile",
      exactTargetOnly: true,
    }, {
      acquireProfileLock: async () => {
        lockCalls += 1;
        return async () => {};
      },
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );
  assert.equal(lockCalls, 0);
});

test("duplicate exact-URL tabs are reported as ambiguous", async () => {
  const url = "https://chatgpt.com/c/WEB:duplicate";
  const harness = fakeBrowserHarness({
    existingPages: [
      { name: "first", targetId: "target-first", url: () => url },
      { name: "second", targetId: "target-second", url: () => url },
    ],
  });
  const state = reusableState();
  const controls = reusableDependencies(harness, {
    discoverReusable: async () => state,
  });

  const connection = await launchAndConnectCdpChrome({
    executablePath: "/fake/chrome",
    profileDir: state.profileDir,
    preferredUrl: url,
  }, controls.dependencies);

  assert.equal(connection.page, harness.freshPage);
  assert.equal(connection.preferredTabMatched, false);
  assert.equal(connection.preferredTabAmbiguous, true);
});
