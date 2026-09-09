import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { TaskSession } from "../src/session/task-session.js";
import { AgentSession } from "../src/session/agent-session.js";

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-session-"));
  const tasksDir = path.join(base, "tasks");
  const projectRoot = path.join(base, "project");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, tasksDir, projectRoot };
}

function persistenceMutexPorts(directory) {
  const resolved = path.resolve(directory);
  const ports = new Set();
  for (let index = 0; ports.size < 5; index += 1) {
    const digest = createHash("sha256")
      .update(`${resolved}\0state-lock\0${index}`)
      .digest();
    ports.add(41_000 + (digest.readUInt16BE(0) % 20_000));
  }
  return [...ports];
}

async function listen(server, options) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen(options);
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
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

test("persists the provider and reloads it", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const created = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "deepseek task",
    projectRoot,
    provider: "deepseek",
    mode: null,
  });
  assert.equal(created.state.provider, "deepseek");

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  assert.equal(reloaded.state.provider, "deepseek");
});

test("serializes concurrent session snapshots without losing checkpoints", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "serialize state",
    projectRoot,
    provider: "chatgpt",
    mode: null,
  });

  const originalValidate = session.validateDirectory.bind(session);
  let validationCalls = 0;
  let activeValidations = 0;
  let maxActiveValidations = 0;
  let releaseFirst;
  let reportFirstEntered;
  const firstEntered = new Promise((resolve) => {
    reportFirstEntered = resolve;
  });
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  session.validateDirectory = async () => {
    validationCalls += 1;
    const call = validationCalls;
    activeValidations += 1;
    maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
    try {
      if (call === 1) {
        reportFirstEntered();
        await firstRelease;
      }
      await originalValidate();
    } finally {
      activeValidations -= 1;
    }
  };

  const identitySave = session.update({
    conversationUrl: "https://chatgpt.com/c/canonical",
  });
  await firstEntered;
  const pendingOutbound = {
    kind: "tool_result",
    status: "commit-unknown",
  };
  const checkpointSave = session.update({ pendingOutbound });
  await new Promise((resolve) => setImmediate(resolve));

  const observedConcurrency = maxActiveValidations;
  releaseFirst();
  await Promise.all([identitySave, checkpointSave]);
  assert.equal(observedConcurrency, 1);

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(
    reloaded.state.conversationUrl,
    "https://chatgpt.com/c/canonical",
  );
  assert.deepEqual(reloaded.state.pendingOutbound, pendingOutbound);
});

test("a separately loaded stale session cannot overwrite a newer handoff", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const created = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "persisted state CAS",
    projectRoot,
    provider: "chatgpt",
    mode: null,
  });
  const outboundId = "11111111-1111-4111-8111-111111111111";
  await created.update({
    pendingOutbound: {
      outboundId,
      kind: "bootstrap",
      transcriptItems: [],
    },
  });
  const first = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  const stale = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });

  await first.commitPendingOutboundHandoff({
    outboundId,
    handoff: {
      conversationUrl: "https://chatgpt.com/c/cas-winner",
      conversationTargetId: "target-cas-winner",
    },
  });
  await assert.rejects(
    stale.update({
      phase: "stale-writer",
      pendingOutbound: null,
    }),
    (error) => error.code === "SESSION_STATE_CONFLICT",
  );

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  assert.equal(reloaded.state.phase, "idle");
  assert.equal(reloaded.state.pendingOutbound, null);
  assert.equal(
    reloaded.state.pendingAssistantTurn.sourceOutboundId,
    outboundId,
  );
  assert.equal(
    reloaded.state.pendingAssistantTurn.conversationTargetId,
    "target-cas-winner",
  );
});

test("a queued save cannot overwrite an earlier queued update", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "queued save ordering",
    projectRoot,
    mode: null,
  });
  const pendingOutbound = {
    outboundId: "11111111-1111-4111-8111-111111111111",
    kind: "bootstrap",
    transcriptItems: [],
  };

  await Promise.all([
    session.update({ pendingOutbound }),
    session.save(),
  ]);

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.deepEqual(reloaded.state.pendingOutbound, pendingOutbound);
});

test("a stale handoff transaction appends no transcript after a competing state change", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const created = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "transactional handoff CAS",
    projectRoot,
    mode: null,
  });
  const oldOutboundId = "11111111-1111-4111-8111-111111111111";
  const newerOutbound = {
    outboundId: "22222222-2222-4222-8222-222222222222",
    kind: "follow_up",
    transcriptItems: [],
  };
  await created.update({
    pendingOutbound: {
      outboundId: oldOutboundId,
      kind: "bootstrap",
      transcriptItems: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "must not append" }],
      }],
    },
  });
  const stale = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  const winner = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });

  await winner.update({ pendingOutbound: newerOutbound });
  await assert.rejects(
    stale.commitPendingOutboundHandoff({ outboundId: oldOutboundId }),
    (error) => error.code === "SESSION_STATE_CONFLICT",
  );

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  assert.deepEqual(reloaded.state.pendingOutbound, newerOutbound);
  assert.deepEqual((await reloaded.readTranscript()).items, []);
});

test("a malformed persistence lock is never removed without a verifiable owner", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "malformed lock",
    projectRoot,
    mode: null,
  });
  const lockPath = path.join(session.directory, ".wtagent-state.lock");
  await fs.writeFile(lockPath, "", { mode: 0o600 });

  await assert.rejects(
    session.update({ phase: "must-not-save" }),
    (error) => error.code === "SESSION_STATE_LOCKED",
  );
  assert.equal((await fs.stat(lockPath)).isFile(), true);

  await fs.rm(lockPath);
  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(reloaded.state.phase, "idle");
});

test("a state lock owns a majority of its recorded mutex ports", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "state-lock mutex ownership",
    projectRoot,
    mode: null,
  });
  const originalValidate = session.validateDirectory.bind(session);
  let releaseValidation;
  let reportValidation;
  const validationEntered = new Promise((resolve) => {
    reportValidation = resolve;
  });
  const validationReleased = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  session.validateDirectory = async () => {
    reportValidation();
    await validationReleased;
    await originalValidate();
  };

  const update = session.update({ phase: "mutex-held" });
  await validationEntered;
  const lockPath = path.join(session.directory, ".wtagent-state.lock");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lock.mutexPorts.length, 5);
  assert.equal(lock.heldMutexPorts.length, 3);
  const heldPort = lock.heldMutexPorts[0];
  const contender = net.createServer();
  await assert.rejects(
    listen(contender, {
      host: "127.0.0.1",
      port: heldPort,
      exclusive: true,
    }),
    (error) => error.code === "EADDRINUSE",
  );

  releaseValidation();
  await update;
  await listen(contender, {
    host: "127.0.0.1",
    port: heldPort,
    exclusive: true,
  });
  await closeServer(contender);
});

test("lock acquisition retries when the previous owner releases after EEXIST", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "lock release race",
    projectRoot,
    mode: null,
  });
  const lockPath = path.join(session.directory, ".wtagent-state.lock");
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "previous-owner",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const originalLink = fs.link.bind(fs);
  let releasedAfterCollision = false;
  t.mock.method(fs, "link", async (source, destination) => {
    try {
      return await originalLink(source, destination);
    } catch (error) {
      if (
        !releasedAfterCollision
        && error.code === "EEXIST"
        && destination === lockPath
      ) {
        releasedAfterCollision = true;
        await fs.rm(lockPath);
      }
      throw error;
    }
  });

  await session.update({ phase: "released-race-recovered" });

  assert.equal(releasedAfterCollision, true);
  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(reloaded.state.phase, "released-race-recovered");
});

test("a recycled live pid does not make a crashed state lock permanent", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "recycled state lock pid",
    projectRoot,
    mode: null,
  });
  const lockPath = path.join(session.directory, ".wtagent-state.lock");
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "crashed-owner",
    createdAt: "2000-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });

  await session.update({ phase: "recycled-pid-recovered" });

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(reloaded.state.phase, "recycled-pid-recovered");
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("unrelated listeners cannot block a state-lock mutex quorum", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "unrelated state-lock listeners",
    projectRoot,
    mode: null,
  });
  const occupiedPorts = persistenceMutexPorts(session.directory).slice(0, 2);
  const servers = occupiedPorts.map(() => net.createServer());
  await Promise.all(servers.map((server, index) => listen(server, {
    host: "127.0.0.1",
    port: occupiedPorts[index],
    exclusive: true,
  })));
  t.after(() => Promise.all(servers.map((server) => closeServer(server))));
  await fs.writeFile(
    path.join(session.directory, ".wtagent-state.lock"),
    `${JSON.stringify({
      pid: 2_147_483_647,
      token: "prior-format-stale-lock",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );

  await session.update({ phase: "quorum-with-collisions" });

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(reloaded.state.phase, "quorum-with-collisions");
});

test("keyed transcript appends are idempotent across loaded session instances", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const created = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "cross-instance transcript key",
    projectRoot,
    provider: "chatgpt",
    mode: null,
  });
  const first = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  const second = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  const item = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "once" }],
  };

  const [left, right] = await Promise.all([
    first.appendTranscriptItemOnce(item, { idempotencyKey: "shared:key" }),
    second.appendTranscriptItemOnce(item, { idempotencyKey: "shared:key" }),
  ]);

  assert.deepEqual(left, right);
  const transcript = await created.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.idempotencyKey === "shared:key").length,
    1,
  );
});

test("defaults the provider to chatgpt for pre-provider sessions", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const created = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "legacy task",
    projectRoot,
    mode: null,
  });
  // Simulate a session saved before the provider field existed.
  delete created.state.provider;
  delete created.state.pendingAssistantTurn;
  await created.save();

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: created.sessionId,
  });
  assert.equal(reloaded.state.provider, "chatgpt");
  assert.equal(reloaded.state.pendingAssistantTurn, null);
});

test("keyed transcript appends are serialized and idempotent", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "idempotent transcript",
    projectRoot,
    mode: null,
  });
  const item = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "same payload" }],
  };

  const [first, second] = await Promise.all([
    session.appendTranscriptItemOnce(item, { idempotencyKey: "assistant:h1" }),
    session.appendTranscriptItemOnce(item, { idempotencyKey: "assistant:h1" }),
  ]);

  assert.deepEqual(second, first);
  const transcript = await session.readTranscript();
  assert.equal(transcript.items.length, 1);
  assert.equal(transcript.items[0].idempotencyKey, "assistant:h1");
  assert.deepEqual(transcript.items[0].item, item);
  const raw = await fs.readFile(
    path.join(session.directory, session.state.rolloutFile),
    "utf8",
  );
  const keyed = raw.trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.wtagent?.idempotencyKey === "assistant:h1");
  assert.equal(keyed.length, 1);
});

test("a reused transcript key rejects a different payload or kind", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "transcript collision",
    projectRoot,
    mode: null,
  });
  await session.appendTranscriptItemOnce({ value: 1 }, {
    idempotencyKey: "collision:key",
  });

  await assert.rejects(
    session.appendTranscriptItemOnce({ value: 2 }, {
      idempotencyKey: "collision:key",
    }),
    /idempotency key collision/i,
  );
  await assert.rejects(
    session.appendTranscriptItemOnce({ value: 1 }, {
      idempotencyKey: "collision:key",
      kind: "other_record",
    }),
    /idempotency key collision/i,
  );
  assert.equal((await session.readTranscript()).items.length, 1);
});

test("keyed append repairs only an incomplete trailing rollout record", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "repair partial rollout",
    projectRoot,
    mode: null,
  });
  const transcriptPath = path.join(
    session.directory,
    session.state.rolloutFile,
  );
  await session.appendTranscriptItem({ type: "message", role: "user" });
  await fs.appendFile(transcriptPath, '{"timestamp":"partial', "utf8");

  await session.appendTranscriptItemOnce({ type: "message", role: "assistant" }, {
    idempotencyKey: "after:partial",
  });

  const raw = await fs.readFile(transcriptPath, "utf8");
  assert.doesNotMatch(raw, /\{"timestamp":"partial/);
  assert.doesNotThrow(() => raw.trim().split("\n").map(JSON.parse));
  const transcript = await session.readTranscript();
  assert.equal(transcript.items.length, 2);
  assert.equal(transcript.items[1].idempotencyKey, "after:partial");
});

test("transcript reads fail closed on an incomplete crash tail", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "read partial rollout",
    projectRoot,
    mode: null,
  });
  const transcriptPath = path.join(
    session.directory,
    session.state.rolloutFile,
  );
  await session.appendTranscriptItem({ type: "message", role: "user" });
  await fs.appendFile(transcriptPath, '{"timestamp":"partial', "utf8");

  await assert.rejects(
    session.readTranscript(),
    (error) => error.code === "TRANSCRIPT_INCOMPLETE",
  );
  const diagnostic = await session.readTranscript({
    allowTrailingPartial: true,
  });
  assert.equal(diagnostic.trailingPartial, true);
  assert.equal(diagnostic.items.length, 1);
});

test("keyed append preserves a valid final JSON record without a newline", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "preserve valid rollout tail",
    projectRoot,
    mode: null,
  });
  const transcriptPath = path.join(
    session.directory,
    session.state.rolloutFile,
  );
  const legacy = {
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "message", role: "user", content: [] },
  };
  await fs.appendFile(transcriptPath, JSON.stringify(legacy), "utf8");

  await session.appendTranscriptItemOnce({ type: "message", role: "assistant" }, {
    idempotencyKey: "after:valid-tail",
  });

  const transcript = await session.readTranscript();
  assert.equal(transcript.items.length, 2);
  assert.deepEqual(transcript.items[0].item, legacy.payload);
  assert.equal(transcript.items[1].idempotencyKey, "after:valid-tail");
});

test("pending outbound handoff appends transcript before its CAS transition", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "durable handoff",
    projectRoot,
    mode: null,
  });
  const outboundId = "11111111-1111-4111-8111-111111111111";
  const transcriptItems = [
    { type: "message", role: "user", content: [] },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ];
  await session.update({
    pendingOutbound: {
      outboundId,
      kind: "tool_result",
      transcriptItems,
    },
  });

  const handoff = await session.commitPendingOutboundHandoff({
    outboundId,
    handoff: {
      runtimeTurn: 4,
      conversationUrl: "https://chatgpt.com/c/recovered",
      conversationTargetId: "target-recovered",
      userMessageId: "user-recovered",
      userTurn: 7,
      assistantBaseline: { ids: ["assistant-old"], maxTurn: 6 },
      pendingToolAcknowledgement: { callId: "call_1" },
    },
  });

  assert.equal(session.state.pendingOutbound, null);
  assert.deepEqual(session.state.pendingAssistantTurn, handoff);
  assert.equal(handoff.handoffId, `outbound:${outboundId}`);
  assert.equal(handoff.sourceOutboundId, outboundId);
  assert.equal(handoff.outboundKind, "tool_result");
  assert.equal(handoff.status, "waiting");
  assert.equal(session.state.conversationUrl, handoff.conversationUrl);
  assert.equal(session.state.conversationTargetId, handoff.conversationTargetId);
  assert.equal(session.state.lastUserMessageId, handoff.userMessageId);
  const transcript = await session.readTranscript();
  assert.deepEqual(transcript.items.map((entry) => entry.item), transcriptItems);
  assert.deepEqual(
    transcript.items.map((entry) => entry.idempotencyKey),
    [
      `outbound:${outboundId}:transcript:0`,
      `outbound:${outboundId}:transcript:1`,
    ],
  );

  assert.deepEqual(
    await session.commitPendingOutboundHandoff({ outboundId }),
    handoff,
  );
  assert.equal((await session.readTranscript()).items.length, 2);
});

test("pending outbound handoff never clears a newer checkpoint", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "handoff CAS",
    projectRoot,
    mode: null,
  });
  const newer = {
    outboundId: "22222222-2222-4222-8222-222222222222",
    kind: "runtime_message",
    transcriptItems: [],
  };
  await session.update({ pendingOutbound: newer });

  await assert.rejects(
    session.commitPendingOutboundHandoff({
      outboundId: "11111111-1111-4111-8111-111111111111",
    }),
    /pending outbound changed/i,
  );
  assert.deepEqual(session.state.pendingOutbound, newer);
  assert.equal(session.state.pendingAssistantTurn, null);
});

test("assistant completion is durable, idempotent, and collision-safe", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "complete handoff",
    projectRoot,
    mode: null,
  });
  const outboundId = "11111111-1111-4111-8111-111111111111";
  await session.update({
    pendingOutbound: {
      outboundId,
      kind: "bootstrap",
      transcriptItems: [],
    },
  });
  const waiting = await session.commitPendingOutboundHandoff({ outboundId });
  const rawResponse = "<agent_response><done>true</done></agent_response>";

  const complete = await session.completePendingAssistantTurn({
    handoffId: waiting.handoffId,
    assistantMessageId: "assistant-recovered",
    assistantTurn: 2,
    rawResponse,
  });

  assert.equal(complete.status, "complete");
  assert.equal(
    complete.responseHash,
    createHash("sha256").update(rawResponse).digest("hex"),
  );
  assert.equal(session.state.lastAssistantMessageId, "assistant-recovered");
  assert.deepEqual(
    await session.completePendingAssistantTurn({
      handoffId: waiting.handoffId,
      assistantMessageId: "assistant-recovered",
      assistantTurn: 2,
      rawResponse,
    }),
    complete,
  );
  await assert.rejects(
    session.completePendingAssistantTurn({
      handoffId: waiting.handoffId,
      assistantMessageId: "assistant-other",
      assistantTurn: 2,
      rawResponse,
    }),
    /completion collision/i,
  );
  await assert.rejects(
    session.clearPendingAssistantTurn("outbound:other"),
    /changed before clearing/i,
  );
  const reloadedComplete = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.deepEqual(reloadedComplete.state.pendingAssistantTurn, complete);

  await session.clearPendingAssistantTurn(waiting.handoffId, {
    phase: "idle",
    lastMessage: "done",
  });
  assert.equal(session.state.pendingAssistantTurn, null);
  assert.equal(session.state.lastMessage, "done");

  const reloaded = await AgentSession.load({
    sessionsDir: tasksDir,
    sessionId: session.sessionId,
  });
  assert.equal(reloaded.state.pendingAssistantTurn, null);
});

test("a verified restore can refresh a complete handoff target without changing raw content", async (t) => {
  const { tasksDir, projectRoot } = await makeFixture(t);
  const session = await AgentSession.create({
    sessionsDir: tasksDir,
    task: "relocate complete handoff",
    projectRoot,
    mode: null,
  });
  const outboundId = "11111111-1111-4111-8111-111111111111";
  await session.update({
    pendingOutbound: {
      outboundId,
      kind: "bootstrap",
      transcriptItems: [],
    },
  });
  const waiting = await session.commitPendingOutboundHandoff({
    outboundId,
    handoff: {
      conversationUrl: "https://chatgpt.com/c/old",
      conversationTargetId: "target-old",
    },
  });
  const rawResponse = "<agent_response><done>true</done><message>done</message></agent_response>";
  const complete = await session.completePendingAssistantTurn({
    handoffId: waiting.handoffId,
    assistantMessageId: "assistant-complete",
    assistantTurn: 2,
    rawResponse,
  });

  const refreshed = await session.refreshPendingAssistantTurn(
    complete.handoffId,
    {
      conversationUrl: "https://chatgpt.com/c/new",
      conversationTargetId: "target-new",
    },
  );

  assert.equal(refreshed.status, "complete");
  assert.equal(refreshed.rawResponse, rawResponse);
  assert.equal(refreshed.responseHash, complete.responseHash);
  assert.equal(refreshed.conversationTargetId, "target-new");
  assert.equal(session.state.conversationTargetId, "target-new");
});
