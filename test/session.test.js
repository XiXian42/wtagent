import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskSession } from "../src/session/task-session.js";

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-session-"));
  const tasksDir = path.join(base, "tasks");
  const projectRoot = path.join(base, "project");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, tasksDir, projectRoot };
}

async function createDirectorySymlink(t, target, linkPath) {
  try {
    await fs.symlink(
      target,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      process.platform === "win32"
      && (error.code === "EPERM" || error.code === "EACCES")
    ) {
      t.skip("Creating directory symlinks requires additional privileges.");
      return false;
    }
    throw error;
  }
  return true;
}

test("rejects loading a task directory symlink outside tasksDir", async (t) => {
  const { base, tasksDir, projectRoot } = await makeFixture(t);
  await fs.mkdir(tasksDir);

  const taskId = "task_escape_read";
  const outside = path.join(base, "outside-read");
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, "task.json"),
    `${JSON.stringify({
      taskId,
      task: "unsafe",
      projectRoot,
      mode: "Pro",
    })}\n`,
    "utf8",
  );

  const linked = await createDirectorySymlink(
    t,
    outside,
    path.join(tasksDir, taskId),
  );
  if (!linked) {
    return;
  }

  await assert.rejects(
    TaskSession.load({ tasksDir, taskId }),
    /symbolic link|escapes tasks directory/i,
  );
});

test("rejects saving after a task directory is replaced by a symlink", async (t) => {
  const { base, tasksDir, projectRoot } = await makeFixture(t);
  const session = await TaskSession.create({
    tasksDir,
    task: "safe task",
    projectRoot,
    mode: "Pro",
  });

  const originalDirectory = session.directory;
  const movedDirectory = `${originalDirectory}.moved`;
  const outside = path.join(base, "outside-write");
  await fs.mkdir(outside);
  await fs.rename(originalDirectory, movedDirectory);

  const linked = await createDirectorySymlink(t, outside, originalDirectory);
  if (!linked) {
    await fs.rename(movedDirectory, originalDirectory);
    return;
  }

  await assert.rejects(
    session.save(),
    /symbolic link|identity changed|escapes tasks directory/i,
  );

  await assert.rejects(
    fs.access(path.join(outside, "task.json")),
    { code: "ENOENT" },
  );
});

test(
  "creates session state and one Codex rollout with owner-only permissions",
  { skip: process.platform === "win32" },
  async (t) => {
    const { tasksDir, projectRoot } = await makeFixture(t);
    const session = await TaskSession.create({
      tasksDir,
      task: "check modes",
      projectRoot,
      mode: "Pro",
    });
    await session.appendToolOutput({ stdout: "ok" });

    for (const name of [
      "session.json",
      "events.jsonl",
      "tool-output.jsonl",
      session.state.rolloutFile,
    ]) {
      const stats = await fs.stat(path.join(session.directory, name));
      assert.equal(
        stats.mode & 0o777,
        0o600,
        `${name} should only be accessible by its owner`,
      );
    }

    const directoryStats = await fs.stat(session.directory);
    assert.equal(directoryStats.mode & 0o777, 0o700);

    const rollout = await fs.readFile(
      path.join(session.directory, session.state.rolloutFile),
      "utf8",
    );
    const first = JSON.parse(rollout.trim().split("\n")[0]);
    assert.equal(first.type, "session_meta");
    assert.equal(first.payload.id, session.sessionId);
    assert.equal(first.payload.originator, "wtagent");
    assert.equal(first.payload.source, "wtagent");
  },
);
