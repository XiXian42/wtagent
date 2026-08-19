import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  assertNativeRuntimeSupported,
  collectDoctorReport,
  detectWsl,
  findExecutableOnPath,
  getNativeWindowsSupport,
  getWslSupport,
  isSupportedNodeVersion,
} from "../src/platform/windows-diagnostics.js";

test("node version support requires 20.17.0 or newer", () => {
  assert.equal(isSupportedNodeVersion("v20.16.9"), false);
  assert.equal(isSupportedNodeVersion("v20.17.0"), true);
  assert.equal(isSupportedNodeVersion("v22.1.0"), true);
});

test("detects WSL from environment and kernel release", () => {
  assert.equal(detectWsl({
    platform: "linux",
    env: { WSL_INTEROP: "/run/WSL" },
    osRelease: "6.6.0",
  }), true);
  assert.equal(detectWsl({
    platform: "linux",
    env: {},
    osRelease: "6.6.0-microsoft-standard-WSL2",
  }), true);
  assert.equal(detectWsl({
    platform: "linux",
    env: {},
    osRelease: "6.6.0-generic",
  }), false);
});

test("WSL runtime is supported with a Linux graphical display", () => {
  const context = {
    platform: "linux",
    env: {
      WSL_DISTRO_NAME: "Ubuntu",
      WAYLAND_DISPLAY: "wayland-0",
    },
    osRelease: "6.6.0-microsoft-standard-WSL2",
  };

  const support = getWslSupport(context);
  assert.equal(support.supported, true);
  assert.equal(support.preview, true);
  assert.match(support.reason, /inside the WSL distribution/i);
  assert.doesNotThrow(() => assertNativeRuntimeSupported(context));
});

test("WSL runtime requires WSLg or another Linux graphical display", () => {
  const context = {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    osRelease: "6.6.0-microsoft-standard-WSL2",
  };

  const support = getWslSupport(context);
  assert.equal(support.supported, false);
  assert.match(support.reason, /WSLg|X server/i);
  assert.throws(
    () => assertNativeRuntimeSupported(context),
    /WSLg|X server/i,
  );
});

test("native Windows support enforces the release and architecture contract", () => {
  assert.equal(getNativeWindowsSupport({
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.17763",
  }).supported, true);
  assert.equal(getNativeWindowsSupport({
    platform: "win32",
    arch: "arm64",
    osRelease: "10.0.26100",
  }).preview, true);
  assert.match(getNativeWindowsSupport({
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.17134",
  }).reason, /build 17763/);
  assert.equal(getNativeWindowsSupport({
    platform: "win32",
    arch: "ia32",
    osRelease: "10.0.26100",
  }).supported, false);
});

test("findExecutableOnPath returns the first resolved path", async () => {
  const result = await findExecutableOnPath("rg", {
    platform: "linux",
    execFileImpl: async () => ({
      stdout: "/usr/bin/rg\n/usr/local/bin/rg\n",
    }),
  });
  assert.equal(result, "/usr/bin/rg");
});

test("findExecutableOnPath skips bundled Codex tool paths", async () => {
  const result = await findExecutableOnPath("rg", {
    platform: "linux",
    reject: (value) => value.includes("/@openai/codex/"),
    execFileImpl: async () => ({
      stdout: [
        "/opt/homebrew/lib/node_modules/@openai/codex/vendor/rg",
        "/usr/local/bin/rg",
      ].join("\n"),
    }),
  });
  assert.equal(result, "/usr/local/bin/rg");
});

test("doctor report accepts WSL when Linux GUI Chrome is available", async () => {
  const paths = {
    appDataDir: path.join("/tmp", "wtagent-home"),
    sessionsDir: path.join("/tmp", "wtagent-home", "sessions"),
    profileDir: path.join("/tmp", "wtagent-home", "chrome-profile"),
  };
  const report = await collectDoctorReport(
    { paths, chromePath: undefined },
    {
      platform: "linux",
      arch: "x64",
      version: "v20.17.0",
      env: {
        WSL_DISTRO_NAME: "Ubuntu",
        WAYLAND_DISPLAY: "wayland-0",
      },
      osRelease: "6.6.0-microsoft-standard-WSL2",
      access: async () => {},
      stat: async () => ({ isDirectory: () => true }),
      discoverChrome: () => "/usr/bin/google-chrome",
      inspectProfile: async () => ({
        status: "pass",
        detail: "no saved CDP state",
      }),
      findExecutable: async () => null,
    },
  );

  assert.equal(report.exitCode, 0);
  assert.equal(report.items.find((item) => item.id === "host").status, "pass");
  assert.equal(report.items.find((item) => item.id === "chrome").status, "pass");
  assert.equal(
    report.items.some((item) => item.id === "command-bridge"),
    false,
  );
});

test("doctor report distinguishes required failures, degraded checks, and optional tools", async () => {
  const paths = {
    appDataDir: path.join("/tmp", "wtagent-home"),
    sessionsDir: path.join("/tmp", "wtagent-home", "sessions"),
    profileDir: path.join("/tmp", "wtagent-home", "chrome-profile"),
  };
  const access = async (target) => {
    if (target === "/tmp") {
      return;
    }
    if (target === path.join("/tmp", "wtagent-home")) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  const stat = async (target) => {
    if (target === "/tmp") {
      return { isDirectory: () => true };
    }
    if (target === path.join("/tmp", "wtagent-home")) {
      return { isDirectory: () => true };
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };

  const report = await collectDoctorReport(
    { paths, chromePath: undefined },
    {
      platform: "win32",
      arch: "x64",
      version: "v20.17.0",
      env: {},
      osRelease: "10.0.26100",
      access,
      stat,
      discoverChrome: () => "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      execFileImpl: async (program) => {
        if (program.toLowerCase() === "powershell.exe") {
          throw new Error("Access denied");
        }
        return { stdout: "10.9.0\n" };
      },
      inspectProfile: async () => ({
        status: "degraded",
        detail: "stale profile lock references dead pid=42",
      }),
      findExecutable: async (name) => {
        if (name === "npm.cmd") {
          return "C:\\Program Files\\nodejs\\npm.cmd";
        }
        return null;
      },
    },
  );

  assert.equal(report.exitCode, 1);
  assert.equal(report.items.find((item) => item.id === "command-bridge").status, "pass");
  assert.equal(report.items.find((item) => item.id === "cim").status, "degraded");
  assert.equal(report.items.find((item) => item.id === "profile-parent").status, "fail");
  assert.equal(report.items.find((item) => item.id === "git").status, "info");
});
