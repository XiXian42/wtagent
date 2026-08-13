import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/policy/approval-store.js";

test("round-trips always-allowed tools through the approvals file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-approvals-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "approvals.json");

  const store = new ApprovalStore({ filePath });
  await store.ensureLoaded();
  assert.equal(store.isAlwaysAllowed("fs.write"), false);

  store.setAlwaysAllowedTool("fs.write");
  await store.save();

  const reloaded = new ApprovalStore({ filePath });
  await reloaded.ensureLoaded();
  assert.equal(reloaded.isAlwaysAllowed("fs.write"), true);
  assert.equal(reloaded.isAlwaysAllowed("fs.edit"), false);
  assert.equal(reloaded.allowAll, false);
});

test("allow-all survives a reload and covers every tool", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-approvals-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "approvals.json");

  const store = new ApprovalStore({ filePath });
  await store.ensureLoaded();
  store.setAlwaysAllowAll();
  await store.save();

  const reloaded = new ApprovalStore({ filePath });
  await reloaded.ensureLoaded();
  assert.equal(reloaded.allowAll, true);
  assert.equal(reloaded.isAlwaysAllowed("terminal.exec"), true);
  assert.equal(reloaded.isAlwaysAllowed("anything-else"), true);
});

test("a missing approvals file means no saved approvals", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-approvals-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new ApprovalStore({
    filePath: path.join(dir, "approvals.json"),
  });
  await store.ensureLoaded();
  assert.equal(store.allowAll, false);
  assert.equal(store.isAlwaysAllowed("fs.write"), false);
});

test("an unreadable approvals file is ignored instead of crashing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-approvals-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "approvals.json");
  await fs.writeFile(filePath, "not-json{{", "utf8");

  const store = new ApprovalStore({ filePath });
  await store.ensureLoaded();
  assert.equal(store.isAlwaysAllowed("fs.write"), false);
});
