import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runProgram } from "../src/tools/terminal-exec.js";
import { ProcessManager } from "../src/tools/process-manager.js";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "windows",
);
const scriptFixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "windows-fixtures",
);

function quoteForCmd(argument) {
  return `"${String(argument).replace(/"/g, "\"\"")}"`;
}

test("windows fixture files are present for CI and local E2E", async () => {
  const expected = [
    "echo-argv.cmd",
    "echo-argv.bat",
    path.join("package-smoke", "package.json"),
  ];

  const helperScripts = [
    "echo-argv.js",
    path.join("package-smoke", "server.js"),
  ];

  await Promise.all(expected.map(async (relativePath) => {
    const absolutePath = path.join(fixturesRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    assert.equal(stat.isFile(), true, `${relativePath} must exist`);
  }));

  await Promise.all(helperScripts.map(async (relativePath) => {
    const absolutePath = path.join(scriptFixturesRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    assert.equal(stat.isFile(), true, `${relativePath} helper must exist`);
  }));
});

test("windows package smoke fixture exposes test and dev scripts", async () => {
  const fixtureRoot = path.join(fixturesRoot, "package-smoke");
  const devScript = path.join(
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "windows-fixtures",
    "package-smoke",
    "server.js",
  );
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, "package.json"),
      "utf8",
    ),
  );

  assert.equal(manifest.name, "wtagent-windows-smoke");
  assert.equal(manifest.scripts.test, "node -e \"process.stdout.write('fixture-test-ok')\"");
  assert.equal(
    manifest.scripts.dev,
    "node ../../../../scripts/windows-fixtures/package-smoke/server.js",
  );
  assert.equal(
    (await fs.stat(path.resolve(fixtureRoot, devScript))).isFile(),
    true,
    "the dev script target must resolve from the npm package directory",
  );
});

test("windows argv fixtures preserve arguments when executed through cmd", {
  skip: process.platform !== "win32",
}, async () => {
  const commandProcessor = process.env.ComSpec ?? "cmd.exe";
  const fixture = path.join(fixturesRoot, "echo-argv.cmd");
  const args = [
    "plain",
    "with spaces",
    "中文目录",
    "quote\"inside",
  ];
  const command = `${quoteForCmd(fixture)} ${args.map(quoteForCmd).join(" ")}`;
  const { stdout } = await execFileAsync(commandProcessor, [
    "/d",
    "/s",
    "/c",
    command,
  ]);

  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.argv, args);
});

test("Windows launcher preserves hostile argv and cannot append a second command", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(
    process.env.TEMP ?? process.cwd(),
    "wtagent windows 中文 ",
  ));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const helper = path.join(root, "echo argv.js");
  const shim = path.join(root, "echo argv.cmd");
  const sentinel = path.join(root, "SENTINEL-MUST-NOT-EXIST.txt");
  await fs.copyFile(path.join(scriptFixturesRoot, "echo-argv.js"), helper);
  await fs.writeFile(
    shim,
    `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`,
    "utf8",
  );

  const args = [
    "",
    "plain",
    "with spaces",
    "中文参数",
    "quote\"inside",
    "tail\\",
    "%PATH%",
    "!WTAGENT_DELAYED!",
    "caret^value",
    `& type nul > "${sentinel}"`,
  ];
  const result = await runProgram({
    program: shim,
    argv: args,
    cwd: root,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024,
  });

  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, args);
  await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
});

test("Windows runs npm test and manages an npm dev process through cmd shims", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = path.join(fixturesRoot, "package-smoke");
  const tested = await runProgram({
    program: "npm",
    argv: ["run", "test"],
    cwd: fixture,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
  });
  assert.equal(tested.ok, true, tested.stderr);
  assert.match(tested.stdout, /fixture-test-ok/);

  const manager = new ProcessManager();
  t.after(() => manager.stopAll());
  const started = manager.start({
    program: "npm",
    argv: ["run", "dev"],
    cwd: fixture,
    inheritSensitiveEnv: false,
  });

  const deadline = Date.now() + 15_000;
  let snapshot = manager.read(started.processId);
  while (!snapshot.stdout.includes("fixture-dev-ok") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = manager.read(started.processId);
  }
  assert.match(snapshot.stdout, /fixture-dev-ok/);

  await manager.stop(started.processId);
  const stopDeadline = Date.now() + 15_000;
  while (
    manager.read(started.processId).status !== "exited"
    && Date.now() < stopDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(manager.read(started.processId).status, "exited");
});
