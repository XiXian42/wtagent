import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  compareVersions,
  fetchLatestVersion,
  installLatest,
  isRemoteNewer,
  npmRegistryLatestUrl,
  parseVersion,
  runSelfUpdate,
} from "../src/cli/self-update.js";
import { fetchJson } from "../src/shared/fetch-json.js";
import path from "node:path";
import { resolveLaunchPlan } from "../src/platform/command-launcher.js";

test("self-update resolves Windows npm without an explicit cwd", async () => {
  const npmPath = "C:\\Program Files\\nodejs\\npm.cmd";
  let spawned;
  const result = await installLatest({
    planCommandImpl: (program, argv) => resolveLaunchPlan({
      program,
      argv,
      platform: "win32",
      env: { Path: "C:\\Program Files\\nodejs", PATHEXT: ".CMD" },
      existsSync: (candidate) => candidate === npmPath,
      statSync: () => ({ isFile: () => true }),
      readBatchPrefixImpl: () => "node npm-cli.js %*",
    }),
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.command, "cmd.exe");
  assert.match(spawned.args[3], /npm\.cmd/);
  assert.equal(spawned.options.windowsVerbatimArguments, true);
});

test("self-update uses the host's real default planner before spawning", async () => {
  let spawned;
  const result = await installLatest({
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.equal(result.ok, true);
  if (process.platform === "win32") {
    assert.equal(path.win32.basename(spawned.command).toLowerCase(), "cmd.exe");
    assert.equal(spawned.options.windowsVerbatimArguments, true);
  } else {
    assert.equal(spawned.command, "npm");
  }
});

test("npm registry URL targets the published latest document", () => {
  assert.equal(
    npmRegistryLatestUrl("wtagent"),
    "https://registry.npmjs.org/wtagent/latest",
  );
});

test("version comparison treats a higher stable release as newer", () => {
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(isRemoteNewer("0.1.1", "0.1.0"), true);
  assert.equal(isRemoteNewer("0.1.0", "0.1.0"), false);
  assert.equal(isRemoteNewer("0.0.9", "0.1.0"), false);
});

test("stable releases are newer than a matching prerelease", () => {
  assert.equal(compareVersions("0.1.0-alpha", "0.1.0"), -1);
  assert.equal(isRemoteNewer("0.1.0", "0.1.0-alpha"), true);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(compareVersions("latest", "0.1.0"), null);
});

test("fetchLatestVersion reads the npm latest version and ignores failures", async () => {
  const latest = await fetchLatestVersion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: "1.2.3" }),
    }),
  });
  assert.equal(latest, "1.2.3");

  const failed = await fetchLatestVersion({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(failed, null);

  const invalid = await fetchLatestVersion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ name: "wtagent" }),
    }),
  });
  assert.equal(invalid, null);
});

test("fetchJson times out and returns null instead of throwing", async () => {
  const result = await fetchJson("https://example.test/slow", {
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  assert.equal(result, null);
});

test("installLatest uses the official registry and treats a zero exit as success", async () => {
  const calls = [];
  const result = await installLatest({
    planCommandImpl: (program, argv) => {
      calls.push({ program, argv });
      return { command: program, args: argv, shell: false };
    },
    spawnImpl: (_command, _args, _options) => {
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    program: "npm",
    argv: [
      "install",
      "-g",
      "wtagent@latest",
      "--registry=https://registry.npmjs.org/",
      "--ignore-scripts",
    ],
  }]);
});

test("installLatest reports spawn and non-zero failures", async () => {
  const missing = await installLatest({
    planCommandImpl: () => ({ command: "npm", args: [], shell: false }),
    spawnImpl: () => {
      throw new Error("npm not found");
    },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /npm not found/);

  const failed = await installLatest({
    planCommandImpl: () => ({ command: "npm", args: [], shell: false }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 1);
});

test("wtagent update installs when npm has a newer version", async () => {
  const lines = [];
  const errors = [];
  let installed = false;
  const result = await runSelfUpdate({
    currentVersion: "0.1.0",
    fetchLatest: async () => "0.2.0",
    install: async () => {
      installed = true;
      return { ok: true };
    },
    write: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
  });
  assert.equal(result.status, "updated");
  assert.equal(installed, true);
  assert.match(lines.join("\n"), /0\.1\.0 → 0\.2\.0/);
  assert.match(lines.join("\n"), /Updated to 0\.2\.0/);
  assert.deepEqual(errors, []);
});

test("wtagent update is a no-op when already current", async () => {
  const lines = [];
  const result = await runSelfUpdate({
    currentVersion: "0.2.0",
    fetchLatest: async () => "0.2.0",
    install: async () => {
      throw new Error("should not install");
    },
    write: (line) => lines.push(line),
    writeError: () => {
      throw new Error("should not error");
    },
  });
  assert.equal(result.status, "current");
  assert.match(lines.join("\n"), /Already up to date \(0\.2\.0\)/);
});

test("wtagent update prints a manual command when the check or install fails", async () => {
  const errors = [];
  const offline = await runSelfUpdate({
    fetchLatest: async () => null,
    write: () => {},
    writeError: (line) => errors.push(line),
  });
  assert.equal(offline.status, "error");
  assert.match(
    errors.join("\n"),
    /npm install -g wtagent@latest --registry=https:\/\/registry\.npmjs\.org\/ --ignore-scripts/,
  );

  errors.length = 0;
  const failed = await runSelfUpdate({
    currentVersion: "0.1.0",
    fetchLatest: async () => "0.2.0",
    install: async () => ({ ok: false }),
    write: () => {},
    writeError: (line) => errors.push(line),
  });
  assert.equal(failed.status, "error");
  assert.match(errors.join("\n"), /Update failed/);
  assert.match(
    errors.join("\n"),
    /npm install -g wtagent@latest --registry=https:\/\/registry\.npmjs\.org\/ --ignore-scripts/,
  );
});
