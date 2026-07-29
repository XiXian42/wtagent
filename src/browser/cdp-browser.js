import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { killProcessTree } from "../tools/process-utils.js";

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
          return;
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

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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

export async function launchAndConnectCdpChrome({
  executablePath,
  profileDir,
  url = "about:blank",
  minimized = false,
}) {
  const port = await reservePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(
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
    await waitForCdp({ endpoint, child });
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome CDP connection did not expose a browser context.");
    }

    const page = context.pages()[0] ?? await context.newPage();
    if (minimized) {
      await setWindowState(context, page, "minimized");
    }

    return {
      browser,
      context,
      child,
      endpoint,
      // Minimize / restore the visible window on demand. The runtime restores
      // the window when it needs the user (manual login, CAPTCHA) and
      // re-minimizes afterward. Uses the live current page each time so it
      // targets the window the user is actually looking at.
      async minimize() {
        return await setWindowState(context, context.pages()[0] ?? page, "minimized");
      },
      async restore() {
        return await setWindowState(context, context.pages()[0] ?? page, "normal");
      },
      async close() {
        await browser.close().catch(() => null);
        if (!await waitForExit(child, 2_000)) {
          await killProcessTree(child.pid);
          await waitForExit(child, 2_000);
        }
      },
    };
  } catch (error) {
    await killProcessTree(child.pid);
    throw error;
  }
}
