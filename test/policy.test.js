import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PolicyEngine } from "../src/policy/policy-engine.js";

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
