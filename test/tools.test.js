import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { ProcessManager } from "../src/tools/process-manager.js";
import { DEFAULT_LIMITS } from "../src/shared/limits.js";

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

test("reads files in UTF-8-safe chunks of at most 16 KiB", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = `start-${"中".repeat(7_000)}-end`;
  await fs.writeFile(path.join(root, "large.txt"), content, "utf8");
  const registry = createDefaultToolRegistry();

  assert.throws(
    () => registry.validate({
      id: "too-large",
      name: "fs.read",
      args: { path: "large.txt", max_bytes: 16 * 1024 + 1 },
    }),
    /Invalid arguments/,
  );

  const firstCall = registry.validate({
    id: "first",
    name: "fs.read",
    args: { path: "large.txt" },
  });
  const first = await registry.execute(firstCall, context(root));
  assert.ok(first.data.bytesRead <= 16 * 1024);
  assert.equal(first.data.truncated, true);
  assert.doesNotMatch(first.data.content, /�/);

  const secondCall = registry.validate({
    id: "second",
    name: "fs.read",
    args: { path: "large.txt", offset: first.data.nextOffset },
  });
  const second = await registry.execute(secondCall, context(root));
  assert.equal(first.data.content + second.data.content, content);
  assert.equal(second.data.truncated, false);
});

test("moves an arbitrary file offset to the next UTF-8 boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "utf8.txt"), "A中B", "utf8");
  const registry = createDefaultToolRegistry();
  const call = registry.validate({
    id: "utf8-offset",
    name: "fs.read",
    args: { path: "utf8.txt", offset: 2 },
  });
  const result = await registry.execute(call, context(root));

  assert.equal(result.data.offset, 4);
  assert.equal(result.data.content, "B");
  assert.doesNotMatch(result.data.content, /�/);
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

test("limits combined command output to 4 KiB and preserves its head and tail", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createDefaultToolRegistry();
  const call = registry.validate({
    id: "large-command",
    name: "terminal.exec",
    args: {
      program: process.execPath,
      argv: [
        "-e",
        "process.stdout.write('START\\n' + '中'.repeat(5000) + '\\nEND')",
      ],
      cwd: ".",
    },
  });
  const result = await registry.execute(call, context(root));

  assert.ok(
    Buffer.byteLength(result.stdout, "utf8")
      + Buffer.byteLength(result.stderr ?? "", "utf8")
      <= 4 * 1024,
  );
  assert.match(result.stdout, /^START/);
  assert.match(result.stdout, /WTAgent omitted/);
  assert.match(result.stdout, /END$/);
  assert.doesNotMatch(result.stdout, /�/);
  assert.equal(result.data.truncated, true);
  assert.ok(result.data.stdoutBytes > result.data.includedOutputBytes);
});

test("caps the locally streamed command log independently", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createDefaultToolRegistry({
    limits: {
      ...DEFAULT_LIMITS,
      maxLocalToolLogBytes: 128,
    },
  });
  const call = registry.validate({
    id: "large-log",
    name: "terminal.exec",
    args: {
      program: process.execPath,
      argv: ["-e", "process.stdout.write('中'.repeat(1000))"],
      cwd: ".",
    },
  });
  const streamed = [];
  const result = await registry.execute(call, {
    ...context(root),
    onToolOutput: async ({ chunk }) => streamed.push(chunk),
  });

  assert.ok(Buffer.byteLength(streamed.join(""), "utf8") <= 128);
  assert.equal(result.data.logTruncated, true);
  assert.doesNotMatch(streamed.join(""), /�/);
});

test("bounds managed-process reads and omits logs from process lists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  const processManager = new ProcessManager();
  t.after(async () => {
    await processManager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  const registry = createDefaultToolRegistry({ processManager });
  const startCall = registry.validate({
    id: "process-start",
    name: "process.start",
    args: {
      program: process.execPath,
      argv: [
        "-e",
        "process.stdout.write('START\\n'+'中'.repeat(5000)+'\\nEND');process.stderr.write('ERR'.repeat(2000))",
      ],
      cwd: ".",
    },
  });
  const started = await registry.execute(startCall, context(root));

  let read;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const readCall = registry.validate({
      id: `process-read-${attempt}`,
      name: "process.read",
      args: { process_id: started.data.processId },
    });
    read = await registry.execute(readCall, context(root));
    if (read.data.status === "exited") break;
    await delay(10);
  }

  assert.equal(read.data.status, "exited");
  assert.ok(
    Buffer.byteLength(read.data.stdout, "utf8")
      + Buffer.byteLength(read.data.stderr, "utf8")
      <= 4 * 1024,
  );
  assert.equal(read.data.truncated, true);
  assert.doesNotMatch(read.data.stdout + read.data.stderr, /�/);

  const listCall = registry.validate({
    id: "process-list",
    name: "process.list",
    args: {},
  });
  const listed = await registry.execute(listCall, context(root));
  assert.equal("stdout" in listed.data.processes[0], false);
  assert.equal("stderr" in listed.data.processes[0], false);
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

test("terminal tool guidance tells the model to bound output without shell operators", () => {
  const terminal = createDefaultToolRegistry().list()
    .find((tool) => tool.name === "terminal.exec");

  assert.match(terminal.description, /4096 UTF-8 bytes/);
  assert.match(terminal.description, /fs\.search\/fs\.read/);
  assert.match(terminal.description, /test-runner filters/);
  assert.match(terminal.description, /Pipes, redirections/);
  assert.match(terminal.description, /not supported/);
});

test("fs.search excludes paths given in the exclude argument", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.js"), "const needle = 1;", "utf8");
  await fs.writeFile(path.join(root, "vendor", "b.js"), "const needle = 2;", "utf8");

  const registry = createDefaultToolRegistry({
    processManager: new ProcessManager(),
  });
  const call = registry.validate({
    id: "search-exclude",
    name: "fs.search",
    args: { query: "needle", exclude: "vendor" },
  });
  const result = await registry.execute(call, context(root));
  assert.equal(result.ok, true);
  assert.match(result.data.matches, /src[\\/]a\.js/);
  assert.doesNotMatch(result.data.matches, /vendor/);
});

test("fs.search splits comma-separated exclude patterns", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.mkdir(path.join(root, "generated"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.js"), "const needle = 1;", "utf8");
  await fs.writeFile(path.join(root, "vendor", "b.js"), "const needle = 2;", "utf8");
  await fs.writeFile(path.join(root, "generated", "c.js"), "const needle = 3;", "utf8");

  const registry = createDefaultToolRegistry({
    processManager: new ProcessManager(),
  });
  const call = registry.validate({
    id: "search-exclude-many",
    name: "fs.search",
    args: { query: "needle", exclude: "vendor, generated" },
  });
  const result = await registry.execute(call, context(root));
  assert.equal(result.ok, true);
  assert.match(result.data.matches, /src[\\/]a\.js/);
  assert.doesNotMatch(result.data.matches, /vendor/);
  assert.doesNotMatch(result.data.matches, /generated/);
});
