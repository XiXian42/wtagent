import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { ApprovalStore } from "../src/policy/approval-store.js";
import { resolveCanonicalWriteTarget } from "../src/policy/path-guard.js";

async function evaluateCommand(root, program, argv = []) {
  const engine = new PolicyEngine();
  return await engine.evaluate(
    {
      name: "terminal.exec",
      args: {
        program,
        argv,
        cwd: ".",
      },
    },
    { projectRoot: root },
  );
}

test("allows routine project-local writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new PolicyEngine();
  const decision = await engine.evaluate(
    { name: "fs.write", args: { path: "src/main.js" } },
    { projectRoot: root },
  );
  assert.equal(decision.action, "allow");
});

test("allows normal Codex-like program and argv execution", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(root, "npm", ["run", "build"]);

  assert.equal(decision.action, "allow");
  assert.deepEqual(decision.reasons, []);
});

test("requires approval outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new PolicyEngine();
  const decision = await engine.evaluate(
    { name: "fs.read", args: { path: path.dirname(root) } },
    { projectRoot: root },
  );
  assert.equal(decision.action, "confirm");
  assert.equal(decision.grants.allowOutside, true);
});

test("requires approval for pushes and sensitive environment inheritance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new PolicyEngine();
  const decision = await engine.evaluate(
    {
      name: "terminal.exec",
      args: {
        program: "git",
        argv: ["push"],
        cwd: ".",
        inherit_sensitive_env: true,
      },
    },
    { projectRoot: root },
  );
  assert.equal(decision.action, "confirm");
  assert.equal(decision.reasons.length, 2);
});

test("normalizes absolute destructive executable basenames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(root, "/bin/rm", ["-rf", "dist"]);

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("destructive command rm"));
});

test("requires approval for shell inline commands", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(root, "sh", ["-c", "echo ok"]);

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("inline shell command through sh"));
});

test("requires approval for interpreter inline code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(root, "python", ["-c", "print('ok')"]);

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("inline interpreter code through python"));
});

test("unwraps env before classifying the executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(
    root,
    "/usr/bin/env",
    ["SAFE=1", "/bin/rm", "-rf", "dist"],
  );

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("destructive command rm"));
});

test("finds git push after global options", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(
    root,
    "/usr/bin/git",
    ["-C", ".", "push"],
  );

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("pushing code to a remote"));
});

test("classifies Windows cmd shims by their logical executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const decision = await evaluateCommand(
    root,
    String.raw`C:\Program Files\nodejs\npm.cmd`,
    ["publish"],
  );

  assert.equal(decision.action, "confirm");
  assert.ok(decision.reasons.includes("publishing a package"));
});

test("write guard rejects a parent replaced by an outside symlink", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-write-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-write-outside-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));

  const parent = path.join(root, "safe");
  const target = path.join(parent, "result.txt");
  await fs.mkdir(parent);
  await fs.rm(parent, { recursive: true });
  await fs.symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    resolveCanonicalWriteTarget(root, target),
    /moved outside project root/,
  );
});

test("always-allowed tools skip confirmation and grant outside-project paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ApprovalStore({
    filePath: path.join(root, "approvals.json"),
  });
  store.setAlwaysAllowedTool("terminal.exec");
  const engine = new PolicyEngine({ store });

  // Without the store the same command needs confirmation.
  const withoutStore = await evaluateCommand(root, "rm", ["-rf", "dist"]);
  assert.equal(withoutStore.action, "confirm");

  const decision = await engine.evaluate(
    {
      name: "terminal.exec",
      args: { program: "rm", argv: ["-rf", "dist"], cwd: "." },
    },
    { projectRoot: root },
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.grants.allowOutside, true);
  assert.deepEqual(decision.reasons, []);
});

test("allow-all bypasses confirmation for every tool", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ApprovalStore({
    filePath: path.join(root, "approvals.json"),
  });
  store.setAlwaysAllowAll();
  const engine = new PolicyEngine({ store });

  const decision = await engine.evaluate(
    {
      name: "terminal.exec",
      args: { program: "sudo", argv: ["rm", "-rf", "/"], cwd: "." },
    },
    { projectRoot: root },
  );
  assert.equal(decision.action, "allow");
});
