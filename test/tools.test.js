import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { ProcessManager } from "../src/tools/process-manager.js";

function context(root) {
  return {
    projectRoot: root,
    allowOutside: false,
  };
}

test("writes, reads, and atomically edits a file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createDefaultToolRegistry({
    processManager: new ProcessManager(),
  });

  const write = registry.validate({
    id: "1",
    name: "fs.write",
    args: { path: "src/a.js", content: "const a = 1;" },
  });
  assert.equal((await registry.execute(write, context(root))).ok, true);

  const edit = registry.validate({
    id: "2",
    name: "fs.edit",
    args: {
      path: "src/a.js",
      edits: [{
        old_text: "const a = 1;",
        new_text: "const a = 2;",
        replace_all: "false",
      }],
    },
  });
  assert.equal((await registry.execute(edit, context(root))).ok, true);

  const read = registry.validate({
    id: "3",
    name: "fs.read",
    args: { path: "src/a.js" },
  });
  const result = await registry.execute(read, context(root));
  assert.equal(result.data.content, "const a = 2;");
});

test("executes a structured command", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createDefaultToolRegistry();
  const call = registry.validate({
    id: "cmd",
    name: "terminal.exec",
    args: {
      program: process.execPath,
      argv: ["-e", "process.stdout.write('ok')"],
      cwd: ".",
      timeout_ms: "5000",
    },
  });
  const streamed = [];
  const result = await registry.execute(call, {
    ...context(root),
    onToolOutput: async (output) => {
      streamed.push(output);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
  assert.equal(streamed.map((item) => item.chunk).join(""), "ok");
});

test("accepts single and JSON-encoded command argument lists", () => {
  const registry = createDefaultToolRegistry();
  const single = registry.validate({
    id: "single",
    name: "terminal.exec",
    args: { program: "npm", argv: "install", cwd: "." },
  });
  const encoded = registry.validate({
    id: "encoded",
    name: "terminal.exec",
    args: { program: "npm", argv: '["run","build"]', cwd: "." },
  });

  assert.deepEqual(single.args.argv, ["install"]);
  assert.deepEqual(encoded.args.argv, ["run", "build"]);
});
