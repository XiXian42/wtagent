import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolveLaunchPlan, __internal } from "../src/platform/command-launcher.js";
import { runProgram } from "../src/tools/terminal-exec.js";
import { ProcessManager } from "../src/tools/process-manager.js";

function createFsProbe(paths) {
  const normalized = new Set(paths.map((value) => value.toLowerCase()));
  return {
    existsSync(candidate) {
      return normalized.has(String(candidate).toLowerCase());
    },
    statSync(candidate) {
      if (!normalized.has(String(candidate).toLowerCase())) {
        throw new Error(`missing: ${candidate}`);
      }
      return { isFile: () => true };
    },
  };
}

function createSpawnStub({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (stdout) {
        child.stdout.write(stdout);
      }
      if (stderr) {
        child.stderr.write(stderr);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("resolveLaunchPlan uses cmd bridge for bare .cmd shims on win32", () => {
  const probe = createFsProbe(["C:\\Program Files\\nodejs\\npm.cmd"]);
  const plan = resolveLaunchPlan({
    program: "npm",
    argv: ["run", "test"],
    cwd: "C:\\repo",
    platform: "win32",
    env: {
      Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    ...probe,
  });

  assert.equal(plan.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(plan.args[3], /^"C:\\Program\^ Files\\nodejs\\npm\.cmd .+run.+test.+"$/);
  assert.equal(plan.logicalProgram, "npm");
  assert.deepEqual(plan.logicalArgv, ["run", "test"]);
  assert.equal(plan.resolvedProgram, "C:\\Program Files\\nodejs\\npm.cmd");
  assert.equal(plan.bridge, "cmd");
  assert.equal(plan.usesCmdBridge, true);
  assert.equal(plan.windowsVerbatimArguments, true);
});

test("resolveLaunchPlan keeps direct executables shell-free on win32", () => {
  const probe = createFsProbe(["C:\\Program Files\\nodejs\\node.exe"]);
  const plan = resolveLaunchPlan({
    program: "node",
    argv: ["--version"],
    cwd: "C:\\repo",
    platform: "win32",
    env: {
      PATH: "C:\\Program Files\\nodejs",
      PATHEXT: ".EXE;.CMD",
    },
    ...probe,
  });

  assert.equal(plan.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(plan.args, ["--version"]);
  assert.equal(plan.bridge, "direct");
  assert.equal(plan.shell, false);
});

test("cmd encoder escapes metacharacters as data", () => {
  const encoded = __internal.buildBatchCommand("C:\\repo\\echo.cmd", [
    "plain text",
    "100%",
    "look!here",
    "a&b|c<d>e(f)",
    "quote\"inside",
    "tail\\",
  ]);

  assert.match(encoded, /^"C:\\repo\\echo\.cmd /);
  assert.match(encoded, /\^"plain\^ text\^"/);
  assert.match(encoded, /\^"100\^%\^"/);
  assert.match(encoded, /\^"look\^!here\^"/);
  assert.match(encoded, /\^"a\^&b\^\|c\^<d\^>e\^\(f\^\)\^"/);
  assert.match(encoded, /quote\\\^"inside/);
  assert.match(encoded, /tail\\\\\^"/);
});

test("custom percent-star batch shims receive proxy-safe escaping", () => {
  const probe = createFsProbe(["C:\\repo\\custom.cmd"]);
  const plan = resolveLaunchPlan({
    program: "C:\\repo\\custom.cmd",
    argv: ["%PATH%", "a&b"],
    cwd: "C:\\repo",
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    readBatchPrefixImpl: () => "@echo off\r\nnode helper.js %*\r\n",
    ...probe,
  });

  assert.equal(
    plan.args[3],
    __internal.buildBatchCommand("C:\\repo\\custom.cmd", ["%PATH%", "a&b"], {
      doubleEscapeMetaChars: true,
    }),
  );
});

test("command planner rejects NUL bytes before spawning", () => {
  assert.throws(
    () => resolveLaunchPlan({
      program: "npm\0publish",
      argv: [],
      cwd: "C:\\repo",
      platform: "win32",
    }),
    /NUL byte/,
  );
  assert.throws(
    () => resolveLaunchPlan({
      program: "npm",
      argv: ["run\0test"],
      cwd: "C:\\repo",
      platform: "win32",
    }),
    /NUL byte/,
  );
});

test("runProgram uses the resolved launch plan without changing logical command inputs", async () => {
  const { calls, spawnImpl } = createSpawnStub({ stdout: "ok" });
  const launchPlan = {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "\"C:\\repo\\npm.cmd\" \"run\" \"test\""],
    shell: false,
    logicalProgram: "npm",
    logicalArgv: ["run", "test"],
    resolvedProgram: "C:\\repo\\npm.cmd",
    bridge: "cmd",
    windowsVerbatimArguments: true,
  };

  const result = await runProgram({
    program: "npm",
    argv: ["run", "test"],
    cwd: "C:\\repo",
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    platform: "win32",
    spawnImpl,
    resolveLaunchPlanImpl: () => launchPlan,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, launchPlan.command);
  assert.deepEqual(calls[0].args, launchPlan.args);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("ProcessManager shares the same launch planner for background processes", async () => {
  const { calls, spawnImpl } = createSpawnStub({ stdout: "ready\n" });
  const launchPlan = {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "\"C:\\repo\\node_modules\\.bin\\vite.cmd\""],
    shell: false,
    logicalProgram: "vite",
    logicalArgv: [],
    resolvedProgram: "C:\\repo\\node_modules\\.bin\\vite.cmd",
    bridge: "cmd",
    windowsVerbatimArguments: true,
  };
  const manager = new ProcessManager({
    platform: "win32",
    spawnImpl,
    resolveLaunchPlanImpl: () => launchPlan,
  });

  const snapshot = manager.start({
    program: "vite",
    argv: [],
    cwd: "C:\\repo",
    inheritSensitiveEnv: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const final = manager.read(snapshot.processId);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, launchPlan.command);
  assert.deepEqual(calls[0].args, launchPlan.args);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(final.status, "exited");
  assert.equal(final.stdout, "ready\n");
  assert.equal(final.program, "vite");
  assert.deepEqual(final.argv, []);
});

test("ProcessManager never overwrites an exited state after tree termination", async () => {
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 9876;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  };
  const manager = new ProcessManager({
    platform: "win32",
    spawnImpl,
    resolveLaunchPlanImpl: () => ({
      command: "node.exe",
      args: [],
      shell: false,
    }),
    killProcessTreeImpl: async () => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    },
  });
  const started = manager.start({
    program: "node",
    argv: [],
    cwd: "C:\\repo",
    inheritSensitiveEnv: false,
  });

  await manager.stop(started.processId);

  assert.equal(manager.read(started.processId).status, "exited");
});

test("getWindowsSearchDirs strips surrounding quotes from PATH entries", () => {
  const dirs = __internal.getWindowsSearchDirs("C:\\repo", {
    PATH: '"C:\\Program Files\\nodejs";C:\\Windows\\System32;"C:\\tools"',
  });
  assert.deepEqual(dirs, [
    "C:\\repo",
    "C:\\Program Files\\nodejs",
    "C:\\Windows\\System32",
    "C:\\tools",
  ]);
});

test("resolveLaunchPlan uses cmd bridge for .bat files on win32", () => {
  const probe = createFsProbe(["C:\\repo\\build.bat"]);
  const plan = resolveLaunchPlan({
    program: "build.bat",
    argv: ["--target", "release"],
    cwd: "C:\\repo",
    platform: "win32",
    env: {
      PATH: "C:\\repo",
      PATHEXT: ".EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    ...probe,
  });

  assert.equal(plan.bridge, "cmd");
  assert.equal(plan.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.resolvedProgram, "C:\\repo\\build.bat");
  assert.equal(plan.logicalProgram, "build.bat");
  assert.deepEqual(plan.logicalArgv, ["--target", "release"]);
});

test("resolveLaunchPlan double-escapes proxy .cmd shims detected by content", () => {
  const probe = createFsProbe(["C:\\repo\\my-shim.cmd"]);
  const plan = resolveLaunchPlan({
    program: "my-shim.cmd",
    argv: ["%PATH%", "a&b"],
    cwd: "C:\\repo",
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    readBatchPrefixImpl: () => "@echo off\r\nnode runner.js %*\r\n",
    ...probe,
  });

  const singleEscaped = __internal.buildBatchCommand("C:\\repo\\my-shim.cmd", ["%PATH%", "a&b"], {
    doubleEscapeMetaChars: false,
  });
  const doubleEscaped = __internal.buildBatchCommand("C:\\repo\\my-shim.cmd", ["%PATH%", "a&b"], {
    doubleEscapeMetaChars: true,
  });

  assert.equal(plan.args[3], doubleEscaped);
  assert.notEqual(plan.args[3], singleEscaped);
});

test("resolveLaunchPlan does not double-escape non-proxy batch files", () => {
  const probe = createFsProbe(["C:\\repo\\plain.cmd"]);
  const plan = resolveLaunchPlan({
    program: "plain.cmd",
    argv: ["hello"],
    cwd: "C:\\repo",
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    readBatchPrefixImpl: () => "@echo off\r\necho hello\r\n",
    ...probe,
  });

  const singleEscaped = __internal.buildBatchCommand("C:\\repo\\plain.cmd", ["hello"], {
    doubleEscapeMetaChars: false,
  });

  assert.equal(plan.args[3], singleEscaped);
});
