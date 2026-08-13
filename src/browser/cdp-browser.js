import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { killProcessTree } from "../tools/process-utils.js";
import {
  acquireCdpProfileLock,
  discoverReusableCdpState,
  fetchCdpVersion,
  processMatchesCdpState,
  reapStaleProfileChrome,
  removeCdpState,
  saveCdpState,
  waitForProcessExit,
} from "./cdp-state.js";

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Races a promise against a timeout. On timeout the returned promise rejects
// with a TIMEOUT-tagged error. Used to bound connectOverCDP + the first CDP
// round-trip: a Chrome whose profile is locked by a stale instance answers the
// WS handshake but never finishes protocol init, so an unbounded connect hangs
// for the full Playwright default (30s) before failing.
class CdpTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "CdpTimeoutError";
    this.code = "CDP_CONNECT_TIMEOUT";
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CdpTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp({
  endpoint,
  child,
  timeoutMs = 15_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `Chrome exited before CDP became ready (exit=${child.exitCode}, signal=${child.signalCode}).`,
      );
    }

    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        const version = await response.json();
        if (version.webSocketDebuggerUrl) {
          return version;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Chrome CDP did not become ready at ${endpoint}: ${lastError?.message ?? "timeout"}`,
  );
}

// Sets the OS window state (e.g. "minimized" / "normal") of the window hosting
// `page` via the CDP Browser domain. On macOS the Chromium launch flags for
// minimizing (--start-minimized) and off-screen positioning are ignored or
// clamped, but Browser.setWindowBounds works reliably and does not throttle the
// page (ChatGPT still renders while minimized). Best-effort: any failure is
// swallowed so window chrome never breaks the run.
async function setWindowState(context, page, windowState) {
  try {
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const { windowId } = await session.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    });
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState },
    });
    await session.detach().catch(() => null);
    return true;
  } catch {
    return false;
  }
}

function sameOriginPath(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin
      && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

export async function launchAndConnectCdpChrome({
  executablePath,
  profileDir,
  url = "about:blank",
  minimized = false,
  preferredUrl = null,
}, {
  acquireProfileLock = acquireCdpProfileLock,
  connectOverCDP = (endpoint) => chromium.connectOverCDP(endpoint),
  discoverReusable = discoverReusableCdpState,
  fetchVersion = fetchCdpVersion,
  killTree = killProcessTree,
  matchesState = processMatchesCdpState,
  reapStale = reapStaleProfileChrome,
  removeState = removeCdpState,
  reserveCdpPort = reservePort,
  saveState = saveCdpState,
  spawnChrome = spawn,
  waitForExit = waitForProcessExit,
  waitForReady = waitForCdp,
  connectTimeoutMs = 20_000,
} = {}) {
  const releaseProfileLock = await acquireProfileLock(profileDir);
  let child = null;
  let state = null;
  let browser = null;
  let closePromise = null;
  let reused = false;

  async function findReusable() {
    return await discoverReusable(profileDir, { fetchVersion });
  }

  try {
    state = await findReusable();
    if (state) {
      reused = true;
    } else {
      await removeState(profileDir);
      // A prior instance may have died leaving renderer children (and Chrome's
      // SingletonLock) still holding this profile. Reap those stale holders
      // before launching, or the new Chrome hangs during profile init and
      // connectOverCDP times out.
      await reapStale(profileDir, { fetchVersion, killTree }).catch(() => null);
      const port = await reserveCdpPort();
      const endpoint = `http://127.0.0.1:${port}`;
      child = spawnChrome(
        executablePath,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profileDir}`,
          "--profile-directory=Default",
          "--no-first-run",
          "--no-default-browser-check",
          url,
        ],
        {
          detached: process.platform !== "win32",
          stdio: "ignore",
          windowsHide: false,
        },
      );

      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      try {
        const version = await waitForReady({ endpoint, child });
        state = await saveState(profileDir, {
          pid: child.pid,
          port,
          endpoint,
          profileDir,
          browser: version.Browser ?? null,
          webSocketDebuggerUrl: version.webSocketDebuggerUrl,
        });
      } catch (error) {
        // Chrome may forward the URL to an existing process using the same
        // profile and then exit successfully. Re-scan after that handoff and
        // adopt the verified live CDP instance instead of reporting a false
        // launch failure.
        if (child.exitCode === 0 && child.signalCode == null) {
          state = await findReusable();
          if (state) {
            reused = true;
          }
        }
        if (!state) {
          throw error;
        }
      }
    }

    // Bound the connect + first CDP round-trip. If Chrome's profile is held by
    // a stale instance, the WS connects but protocol init never completes;
    // without this guard Playwright hangs ~30s and leaves a dirty CDP state.
    let context;
    try {
      browser = await withTimeout(
        connectOverCDP(state.endpoint),
        connectTimeoutMs,
        `Timed out connecting to Chrome CDP at ${state.endpoint} after ${connectTimeoutMs}ms.`,
      );
      // contexts() forces a real protocol round-trip, so it hangs too when the
      // browser main thread is stuck — keep it inside the timeout budget.
      const contexts = await withTimeout(
        Promise.resolve().then(() => browser.contexts()),
        connectTimeoutMs,
        `Timed out reading Chrome browser context at ${state.endpoint}.`,
      );
      context = contexts[0];
    } catch (error) {
      if (error instanceof CdpTimeoutError) {
        // The verified-but-unusable instance we launched is a dead end. Kill it
        // (only if we own it) and drop its CDP state so the next run starts
        // clean instead of trying to reuse a hung endpoint.
        await browser?.close().catch(() => null);
        if (!reused && child?.pid) {
          await killTree(child.pid).catch(() => null);
        }
        await removeState(profileDir, state).catch(() => null);
        throw new Error(
          `${error.message} The Chrome profile may be held by another instance. `
          + "Close other windows using this profile, or run `wtagent logout` to reset it, then retry.",
        );
      }
      throw error;
    }
    if (!context) {
      throw new Error("Chrome CDP connection did not expose a browser context.");
    }

    // A reused browser may still contain the previous conversation. Keep it
    // intact and, when a preferred URL is given, reuse an existing tab already
    // showing that conversation (origin + path) so resumed runs do not pile up
    // tabs; otherwise create a fresh target for this CLI session.
    let page;
    if (reused) {
      const matchingTab = preferredUrl
        ? context.pages().find((candidate) =>
          sameOriginPath(candidate.url?.() ?? "", preferredUrl)
        ) ?? null
        : null;
      page = matchingTab ?? await context.newPage();
    } else {
      page = context.pages()[0] ?? await context.newPage();
    }
    if (minimized) {
      await setWindowState(context, page, "minimized");
    }

    return {
      browser,
      context,
      child,
      endpoint: state.endpoint,
      page,
      pid: state.pid,
      reused,
      // Minimize / restore the visible window on demand. The runtime restores
      // the window when it needs the user (manual login, CAPTCHA) and
      // re-minimizes afterward. Uses the live current page each time so it
      // targets the window the user is actually looking at.
      async minimize() {
        return await setWindowState(context, page, "minimized");
      },
      async restore() {
        return await setWindowState(context, page, "normal");
      },
      // Drops only the Playwright transport. Unlike close(), never asks Chrome
      // to exit and never kills the process: used to recover from a dead CDP
      // connection (e.g. after the Mac slept) while Chrome itself is alive.
      async disconnect() {
        await settleWithin(browser.close(), 1_500);
      },
      async close() {
        if (closePromise) {
          return await closePromise;
        }
        closePromise = (async () => {
          let exited = false;
          try {
            // browser.close() on a connectOverCDP browser only disconnects the
            // Playwright transport. Browser.close asks Chrome itself to exit.
            const session = await browser.newBrowserCDPSession()
              .catch(() => null);
            if (session) {
              await settleWithin(session.send("Browser.close"), 1_500);
              await settleWithin(session.detach(), 500);
            }
            exited = await waitForExit(state.pid, 3_000);
            await settleWithin(browser.close(), 1_500);

            if (!exited) {
              const childStillOwnsPid = child?.pid === state.pid
                && child.exitCode == null
                && child.signalCode == null;
              const safeToKill = childStillOwnsPid
                || await matchesState(state);
              if (safeToKill) {
                await killTree(state.pid);
                exited = await waitForExit(state.pid, 3_000);
              }
            }

            if (exited) {
              await removeState(profileDir, state);
              return;
            }
            throw new Error(
              `Chrome pid=${state.pid} did not exit; its verified CDP state `
              + "was kept so the next WTAgent run can reuse it.",
            );
          } finally {
            await releaseProfileLock();
          }
        })();
        return await closePromise;
      },
    };
  } catch (error) {
    await browser?.close().catch(() => null);
    if (
      child
      && child.exitCode == null
      && child.signalCode == null
    ) {
      await killTree(child.pid);
    }
    await releaseProfileLock();
    throw error;
  }
}
