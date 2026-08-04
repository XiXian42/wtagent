import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { killProcessTree } from "../src/tools/process-utils.js";

function createSpawnStub() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 1234;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  return { calls, spawnImpl };
}

test("killProcessTree on win32 invokes taskkill with /T /F", async () => {
  const { calls, spawnImpl } = createSpawnStub();

  await killProcessTree(4242, "SIGTERM", {
    platform: "win32",
    spawnImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/pid", "4242", "/T", "/F"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, "ignore");
});

test("killProcessTree on win32 is a no-op for falsy pid", async () => {
  const { calls, spawnImpl } = createSpawnStub();

  await killProcessTree(0, "SIGTERM", {
    platform: "win32",
    spawnImpl,
  });

  assert.equal(calls.length, 0);
});

test("killProcessTree on win32 resolves even if taskkill errors", async () => {
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1234;
    queueMicrotask(() => child.emit("error", new Error("boom")));
    return child;
  };

  await killProcessTree(4242, "SIGTERM", {
    platform: "win32",
    spawnImpl,
  });
});

test("killProcessTree on non-win32 uses process.kill with the process group", async () => {
  const killed = [];
  const originalKill = process.kill;
  process.kill = (target, signal) => {
    killed.push({ target, signal });
    if (target === -4242) {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
  };

  try {
    await killProcessTree(4242, "SIGTERM", { platform: "linux" });
    assert.deepEqual(killed, [
      { target: -4242, signal: "SIGTERM" },
      { target: 4242, signal: "SIGTERM" },
    ]);
  } finally {
    process.kill = originalKill;
  }
});
