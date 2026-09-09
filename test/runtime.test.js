import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { TaskSession } from "../src/session/task-session.js";
import {
  DEFAULT_LIMITS,
  resolveLimits,
} from "../src/shared/limits.js";
import { BrowserAdapterError } from "../src/shared/errors.js";

function outboundCorrelationId(message) {
  return String(message).match(
    /Opaque WTAgent transport correlation ID \(do not repeat\): ([0-9a-f-]{36})\./,
  )?.[1] ?? null;
}

function assertOneTrailingReminder(message) {
  assert.equal(
    [...message.matchAll(/<system_reminder>/g)].length,
    1,
    "outbound messages must contain exactly one system reminder",
  );
  assert.match(
    message,
    /<system_reminder>[\s\S]*<\/system_reminder>\s*$/,
    "the system reminder must be the final outbound block",
  );
}

function transcriptUser(text, { attachments = [] } = {}) {
  const item = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
  if (attachments.length > 0) {
    item.attachments = attachments;
  }
  return item;
}

async function createInterruptedResumeSession(t, {
  task = "Recover the original task",
  state = {},
  transcriptItems = [transcriptUser(task)],
} = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-resume-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await TaskSession.create({
    sessionsDir,
    task,
    projectRoot,
    mode: null,
  });
  for (const item of transcriptItems) {
    await session.appendTranscriptItem(item);
  }
  await session.update({
    phase: "interrupted",
    turn: 1,
    runCount: 1,
    conversationUrl: "https://chatgpt.com/c/WEB:expired",
    ...state,
  });
  return { base, projectRoot, sessionsDir, session };
}

function runtimeForResume(session, adapter, { events = [] } = {}) {
  return new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });
}

function fakeReconciliationOutcome(handoff) {
  return {
    status: handoff.status,
    conversationUrl: handoff.conversationUrl,
    conversationTargetId: handoff.conversationTargetId,
    userMessageId: handoff.userMessageId,
    userTurn: handoff.userTurn,
    preOutboundMarkerIds: handoff.preOutboundMarkerIds ?? [],
    assistantBaseline: handoff.assistantBaseline ?? null,
    assistantCandidateMessageId:
      handoff.assistantCandidateMessageId ?? handoff.assistantMessageId ?? null,
    assistantCandidateTurn:
      handoff.assistantCandidateTurn ?? handoff.assistantTurn ?? null,
    ...(handoff.status === "complete"
      ? {
        assistantMessageId: handoff.assistantMessageId,
        assistantTurn: handoff.assistantTurn,
        rawResponse: handoff.rawResponse,
        responseHash: handoff.responseHash,
      }
      : {}),
  };
}

const invalidDoneMessage = '<agent_response><done>true</done><message><![CDATA[<invoke name="fs.write" />]]></message></agent_response>';
const emptyDoneMessage = "<agent_response><done>true</done><message> </message></agent_response>";
const invalidEnvelope = "<agent_response><done>true</done><message>unclosed";

for (const [name, responses] of [
  ["tool requests inside final messages", [invalidDoneMessage, invalidDoneMessage]],
  ["empty final messages", [emptyDoneMessage, emptyDoneMessage]],
  ["mixed syntax and semantic errors", [invalidEnvelope, invalidDoneMessage]],
]) {
  test(`protocol retry budget terminates repeated ${name}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-protocol-budget-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const session = await TaskSession.create({ sessionsDir: path.join(root, "sessions"), projectRoot: root, task: "test" });
    const adapter = new FakeWebModelAdapter([...responses, "must not be read"]);
    const events = [];
    const runtime = new AgentRuntime({
      session, adapter, registry: createDefaultToolRegistry(), policy: new PolicyEngine(),
      approval: async () => false, onEvent: (event) => events.push(event),
      limits: { ...DEFAULT_LIMITS, maxProtocolErrors: 2 },
    });
    await assert.rejects(runtime.run(), /Protocol failed 2 consecutive times/);
    assert.deepEqual(events.filter((e) => e.type === "protocol.invalid").map((e) => e.payload.count), [1, 2]);
    assert.equal(adapter.responseNumber, 2);
    assert.equal(adapter.sentMessages.length, 2);
    assert.equal(session.state.lastMessage, null);
    const transcript = await session.readTranscript();
    assert.equal(transcript.items.filter(({ item }) => item.role === "assistant").length, 0);
  });
}

test("a fully valid tool turn resets the consecutive protocol retry budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-protocol-reset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "input.txt"), "test");
  const session = await TaskSession.create({ sessionsDir: path.join(root, "sessions"), projectRoot: root, task: "read" });
  const adapter = new FakeWebModelAdapter([
    invalidDoneMessage,
    '<agent_response><done>false</done><message>Read</message><tool_call name="fs.read"><args><path>input.txt</path></args></tool_call></agent_response>',
    emptyDoneMessage,
    '<agent_response><done>true</done><message>Done</message></agent_response>',
  ]);
  const events = [];
  const runtime = new AgentRuntime({
    session, adapter, registry: createDefaultToolRegistry(), policy: new PolicyEngine(), approval: async () => false,
    onEvent: (event) => events.push(event), limits: { ...DEFAULT_LIMITS, maxProtocolErrors: 2 },
  });
  assert.equal((await runtime.run()).message, "Done");
  assert.deepEqual(events.filter((e) => e.type === "protocol.invalid").map((e) => e.payload.count), [1, 1]);
});

test("runs a full model-tool-model loop", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <message>create</message>
      <tool_call id="call_1" name="fs.write">
        <args>
          <path>index.html</path>
          <content><![CDATA[<h1>Hello</h1>]]></content>
        </args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <message>verify</message>
      <tool_call name="fs.read">
        <args><path>index.html</path></args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Website created and verified.</message>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Create a website",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();
  assert.equal(result.message, "Website created and verified.");
  assert.equal(await fs.readFile(path.join(projectRoot, "index.html"), "utf8"), "<h1>Hello</h1>");
  assert.match(adapter.sentMessages[1], /<tool_result/);
  assert.equal(session.state.phase, "idle");
  assert.equal("status" in session.state, false);
  for (const message of adapter.sentMessages) {
    assertOneTrailingReminder(message);
  }
  const outboundIds = adapter.sentMessages.map(outboundCorrelationId);
  assert.equal(outboundIds.every(Boolean), true);
  assert.equal(new Set(outboundIds).size, adapter.sentMessages.length);
  assert.deepEqual(adapter.sentOutboundIds, outboundIds);

  // The opening web message wraps scaffolding in a strippable marker, with the
  // user task outside it.
  assert.match(adapter.sentMessages[0], /<agent_protocol>[\s\S]*<\/agent_protocol>/);
  assert.match(adapter.sentMessages[0], /## User task\nCreate a website/);

  // The canonical transcript records structured items from the first exchange.
  const transcript = await session.readTranscript();
  const types = transcript.items.map((entry) => {
    const item = entry.item;
    return `${item.type}${item.role ? "/" + item.role : ""}`;
  });
  assert.deepEqual(types, [
    "message/user",
    "message/assistant",
    "function_call",
    "function_call_output",
    "message/assistant",
    "function_call",
    "function_call_output",
    "message/assistant",
  ]);
  const functionItems = transcript.items
    .map((entry) => entry.item)
    .filter((item) => item.type.startsWith("function_call"));
  assert.match(functionItems[0].call_id, /^call_[a-f0-9]{16}$/);
  assert.notEqual(functionItems[0].call_id, "call_1");
  assert.equal(functionItems[1].call_id, functionItems[0].call_id);
});

function emptyAssistantResponse() {
  return new BrowserAdapterError(
    "ChatGPT completed an assistant turn without any content.",
    { code: "EMPTY_ASSISTANT_RESPONSE" },
  );
}

test("asks ChatGPT to continue after empty replies without resending the task", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    emptyAssistantResponse(),
    emptyAssistantResponse(),
    emptyAssistantResponse(),
    "<agent_response><done>true</done><message>Recovered.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "UNIQUE_ORIGINAL_TASK",
    projectRoot,
    mode: null,
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  const result = await runtime.run();

  assert.equal(result.message, "Recovered.");
  assert.equal(adapter.sentMessages.length, 4);
  assert.match(adapter.sentMessages[0], /UNIQUE_ORIGINAL_TASK/);
  for (const continuation of adapter.sentMessages.slice(1)) {
    assert.match(continuation, /previous assistant response was empty/i);
    assert.match(continuation, /Do not repeat any local tool operation/i);
    assert.doesNotMatch(continuation, /UNIQUE_ORIGINAL_TASK/);
    assert.doesNotMatch(continuation, /<tool_result/);
    assertOneTrailingReminder(continuation);
  }
  assert.deepEqual(
    events
      .filter((event) => event.type === "model.empty_response")
      .map((event) => event.payload.retry),
    [1, 2, 3],
  );
});

test("stops after three empty-response continuations and preserves a pending tool result", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="fs.write">
        <args><path>once.txt</path><content>once</content></args>
      </tool_call>
    </agent_response>`,
    emptyAssistantResponse(),
    emptyAssistantResponse(),
    emptyAssistantResponse(),
    emptyAssistantResponse(),
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Write once and finish",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(
    runtime.run(),
    (error) => {
      assert.equal(error.code, "EMPTY_ASSISTANT_RETRIES_EXHAUSTED");
      assert.equal(error.details.retries, 3);
      return true;
    },
  );

  assert.equal(await fs.readFile(path.join(projectRoot, "once.txt"), "utf8"), "once");
  assert.match(adapter.sentMessages[1], /<tool_result name="fs\.write"/);
  for (const continuation of adapter.sentMessages.slice(2)) {
    assert.doesNotMatch(continuation, /<tool_result name=/);
  }
  assert.equal(
    adapter.sentMessages.filter((message) => /previous assistant response was empty/i.test(message)).length,
    3,
  );
  assert.equal(session.state.pendingToolResult?.name, "fs.write");
});

test("in-place recovery continues without resending a persisted pending result", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const session = await TaskSession.create({
    tasksDir,
    task: "Recover in the same browser tab",
    projectRoot,
    mode: null,
  });
  await session.update({
    conversationUrl: "https://chatgpt.com/c/recover-in-place",
    pendingToolResult: {
      callId: "call_pending",
      name: "fs.write",
      ok: true,
      message: "Already delivered in the web conversation.",
    },
  });
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Continued.</message></agent_response>",
  ]);
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run({
    resume: true,
    inPlaceRecovery: true,
  });

  assert.equal(result.message, "Continued.");
  assert.equal(adapter.sentMessages.length, 1);
  assert.match(adapter.sentMessages[0], /previous assistant response was empty/i);
  assert.doesNotMatch(adapter.sentMessages[0], /<tool_result/);
  assert.equal(session.state.pendingToolResult, null);
});

test("continues beyond the former 36-step run limit", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "debug.step",
    description: "Advance a deterministic test step.",
    inputDescription: "<args><index>integer</index></args>",
    risk: "read",
    inputSchema: z.object({ index: z.coerce.number().int() }),
    execute: async ({ index }) => {
      executions += 1;
      return { ok: true, message: `step ${index}` };
    },
  });

  const responses = Array.from({ length: 37 }, (_, index) => `
    <agent_response>
      <done>false</done>
      <tool_call name="debug.step"><args><index>${index + 1}</index></args></tool_call>
    </agent_response>
  `);
  responses.push(
    "<agent_response><done>true</done><message>Finished after 37 tools.</message></agent_response>",
  );

  const adapter = new FakeWebModelAdapter(responses);
  const session = await TaskSession.create({
    tasksDir,
    task: "Run more than 36 steps",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry,
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Finished after 37 tools.");
  assert.equal(executions, 37);
  assert.equal(session.state.turn, 38);
});

test("runtime never invokes provider model selection", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Used current mode.</message></agent_response>",
  ]);
  adapter.selectMode = async () => {
    throw new Error("mode selection must not run");
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Use the model already selected in the browser",
    projectRoot,
    mode: "legacy-mode-value",
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  const result = await runtime.run();

  assert.equal(result.message, "Used current mode.");
  assert.equal(
    events.some((event) => event.type === "conversation.mode_selected"),
    false,
  );
  const started = events.find((event) => event.type === "conversation.started");
  assert.equal("mode" in started.payload, false);
  assert.equal("requestedMode" in started.payload, false);
  assert.equal(session.state.activeMode, null);
});

test("keeps the final browser tool-result message within 24 KiB", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const registry = new ToolRegistry();
  registry.register({
    name: "debug.large-output",
    description: "Return oversized structured data for transport testing.",
    inputDescription: "<args></args>",
    risk: "read",
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true,
      message: "Large output ready.",
      data: { content: `BEGIN-${"中".repeat(50_000)}-END` },
    }),
  });
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="debug.large-output"><args/></tool_call>
    </agent_response>`,
    `<agent_response><done>true</done><message>Done.</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Exercise a large tool result",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry,
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();

  const resultMessage = adapter.sentMessages[1];
  assert.ok(
    Buffer.byteLength(resultMessage, "utf8")
      <= DEFAULT_LIMITS.maxBrowserToolResultBytes,
  );
  assert.match(resultMessage, /<tool_result[^>]+truncated="true"/);
  assert.match(resultMessage, /WTAgent omitted/);
  assertOneTrailingReminder(resultMessage);
});

test("records @file attachments on the opening message and passes them to the adapter", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>Reviewed the attached file.</message>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "review @report.pdf",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const attach = [{ name: "report.pdf", path: path.join(projectRoot, "report.pdf") }];
  await runtime.run({ files: attach });

  // The adapter received the files alongside the first message.
  assert.deepEqual(adapter.sentAttachments[0], attach);
  // Later turns (none here) would not carry attachments.

  // The canonical transcript's opening user item records the attachment so
  // exports remain honest about what the user provided.
  const transcript = await session.readTranscript();
  const firstUser = transcript.items
    .map((entry) => entry.item)
    .find((item) => item.type === "message" && item.role === "user");
  assert.deepEqual(firstUser.attachments, [
    { name: "report.pdf", path: path.join(projectRoot, "report.pdf") },
  ]);
});

test("restores the window for manual login, then re-minimizes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Guest shell first: the grace-period login check throws, forcing the
  // explicit auth_required path that restores/minimizes the window.
  class LoginNeededAdapter extends FakeWebModelAdapter {
    constructor(responses) {
      super(responses);
      this.loginCalls = 0;
    }

    async getAuthState() {
      return "unauthenticated";
    }

    async waitForManualLogin() {
      this.loginCalls += 1;
      if (this.loginCalls === 1) {
        throw new Error("still guest");
      }
      // Second (real) call succeeds.
    }
  }

  const adapter = new LoginNeededAdapter([
    `<agent_response><done>true</done><message>Done.</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Do a thing",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();

  // The window is brought forward for login and sent back afterward.
  assert.deepEqual(adapter.windowStateCalls, ["restore", "minimize"]);
});

test("conversation.started stays model-agnostic for fresh and resumed sessions", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Adapter that cannot select Pro (limited, no known fallback label).
  const adapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>Done on the current mode.</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Do a thing",
    projectRoot,
    mode: "Pro",
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  await runtime.run();

  const started = events.find((e) => e.type === "conversation.started");
  assert.equal("mode" in started.payload, false);
  assert.equal("requestedMode" in started.payload, false);
  assert.equal(session.state.activeMode, null);

  const resumedEvents = [];
  const followUpAdapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>Still on the current mode.</message></agent_response>`,
  ]);
  const resumedRuntime = new AgentRuntime({
    adapter: followUpAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => resumedEvents.push(event),
  });
  await resumedRuntime.run({
    resume: true,
    instruction: "Continue",
  });

  const resumedStarted = resumedEvents.find(
    (event) => event.type === "conversation.started",
  );
  assert.equal("mode" in resumedStarted.payload, false);
  assert.equal("requestedMode" in resumedStarted.payload, false);
});

test("returns invalid tool calls to the model instead of executing them", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <message>try unknown tool</message>
      <tool_call id="bad_1" name="fs.missing"><args></args></tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <message>inspect after validation failure</message>
      <tool_call id="inspect_after_invalid" name="fs.list"><args/></tool_call>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Recovered.</message>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Recover from invalid tool",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();
  assert.equal(result.message, "Recovered.");
  assert.match(adapter.sentMessages[1], /Unknown tool: fs\.missing/);
  assert.equal(session.state.pendingToolResult, null);
});

test("returns policy path errors to the model instead of ending the CLI", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  let executionCount = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "terminal.test",
    risk: "execute",
    inputSchema: z.object({ cwd: z.string() }),
    execute: async () => {
      executionCount += 1;
      return { ok: true, message: "executed" };
    },
  });
  let policyCalls = 0;
  const policy = {
    evaluate: async () => {
      policyCalls += 1;
      if (policyCalls === 1) {
        throw new Error(
          "Path ends with a space or period, which is not allowed on Windows: bad.",
        );
      }
      return { action: "allow", reasons: [], grants: {} };
    },
  };
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <message>compile</message>
      <tool_call name="terminal.test"><args><cwd>bad.</cwd></args></tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <message>retry with a valid path</message>
      <tool_call name="terminal.test"><args><cwd>.</cwd></args></tool_call>
    </agent_response>`,
    `<agent_response><done>true</done><message>Recovered.</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Compile a C program",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry,
    policy,
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Recovered.");
  assert.equal(executionCount, 1);
  assert.match(
    adapter.sentMessages[1],
    /Tool request rejected before execution: Path ends with a space or period/,
  );
  assert.equal(session.state.pendingToolResult, null);
});

test("resumes the saved conversation with a follow-up instruction", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const conversationUrl = "https://chatgpt.com/c/existing";
  const session = await TaskSession.create({
    tasksDir,
    task: "Create a site",
    projectRoot,
    mode: "Pro",
  });
  await session.update({
    phase: "interrupted",
    turn: 3,
    conversationUrl,
  });
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="fs.write">
        <args><path>contact.html</path><content>Contact</content></args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <tool_call name="fs.read"><args><path>contact.html</path></args></tool_call>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Feature added.</message>
    </agent_response>`,
  ]);
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run({
    resume: true,
    instruction: "Add a contact page",
  });

  assert.equal(adapter.conversationUrl, conversationUrl);
  assert.doesNotMatch(adapter.sentMessages[0], /<agent_protocol>/);
  assert.doesNotMatch(adapter.sentMessages[0], /<session_id>/);
  assert.doesNotMatch(adapter.sentMessages[0], /Available tools:/);
  assert.match(adapter.sentMessages[0], /Add a contact page/);
  assertOneTrailingReminder(adapter.sentMessages[0]);
  assert.equal(session.state.turn, 6);
});

test("rebuilds the reported provisional-URL session on a verified fresh page", async (t) => {
  const task = "Research an AI fiction platform";
  const { session } = await createInterruptedResumeSession(t, { task });
  const events = [];
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Recovered safely.</message></agent_response>",
  ]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  const result = await runtimeForResume(session, adapter, { events }).run({
    resume: true,
  });

  assert.equal(result.message, "Recovered safely.");
  assert.equal(adapter.sentMessages.length, 1);
  assert.match(adapter.sentMessages[0], /<agent_protocol>/);
  assert.match(adapter.sentMessages[0], /<resume_context>/);
  assert.match(adapter.sentMessages[0], /Research an AI fiction platform/);
  assert.match(adapter.sentMessages[0], new RegExp(session.sessionId));
  assert.equal(
    events.some((event) => event.type === "conversation.rebuilding_fresh"),
    true,
  );
  assert.equal(
    events.find((event) => event.type === "model.message_sent")?.payload.kind,
    "fresh_rebuild",
  );
  const transcript = await session.readTranscript();
  assert.equal(transcript.items.length, 2);
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "user").length,
    1,
    "rebuilding transport must not duplicate the original canonical user item",
  );
});

test("fresh fallback refuses an ambiguous saved assistant marker", async (t) => {
  const { session } = await createInterruptedResumeSession(t, {
    state: { lastAssistantMessageId: "assistant-unrecorded" },
  });
  const adapter = new FakeWebModelAdapter([]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => {
      assert.equal(error.code, "CONVERSATION_REBUILD_UNSAFE");
      assert.match(error.message, /assistant response/);
      return true;
    },
  );

  assert.deepEqual(adapter.sentMessages, []);
  assert.equal(session.state.lastAssistantMessageId, "assistant-unrecorded");
});

test("fresh fallback refuses an incomplete canonical transcript tail", async (t) => {
  const { session } = await createInterruptedResumeSession(t);
  const transcriptPath = path.join(
    session.directory,
    session.state.rolloutFile,
  );
  await fs.appendFile(transcriptPath, '{"timestamp":"partial', "utf8");
  const adapter = new FakeWebModelAdapter([]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => error.code === "TRANSCRIPT_INCOMPLETE",
  );

  assert.deepEqual(adapter.sentMessages, []);
});

test("fresh fallback wraps a new instruction in the full resume context", async (t) => {
  const task = "Build the original project";
  const { session } = await createInterruptedResumeSession(t, { task });
  await session.appendInstruction("Now add a search page");
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Instruction recovered.</message></agent_response>",
  ]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await runtimeForResume(session, adapter).run({
    resume: true,
    instruction: "Now add a search page",
  });

  assert.match(adapter.sentMessages[0], /<agent_protocol>/);
  assert.match(adapter.sentMessages[0], /<initial_request><!\[CDATA\[Build the original project\]\]>/);
  assert.match(adapter.sentMessages[0], /<latest_instruction><!\[CDATA\[Now add a search page\]\]>/);
  assert.doesNotMatch(adapter.sentMessages[0], /^Now add a search page\n/);
  const transcript = await session.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "user").length,
    2,
  );
});

test("fresh fallback never uses the context-only in-place continuation", async (t) => {
  const { session } = await createInterruptedResumeSession(t);
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Rebuilt.</message></agent_response>",
  ]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await runtimeForResume(session, adapter).run({
    resume: true,
    inPlaceRecovery: true,
  });

  assert.match(adapter.sentMessages[0], /<resume_context>/);
  assert.doesNotMatch(
    adapter.sentMessages[0],
    /previous assistant response was empty/i,
  );
});

test("fresh fallback runs browser-side model setup for the new chat", async (t) => {
  const { session } = await createInterruptedResumeSession(t);
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Rebuilt.</message></agent_response>",
  ]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };
  let setupCalls = 0;
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    postAuthSetup: async () => {
      setupCalls += 1;
    },
  });

  await runtime.run({ resume: true });

  assert.equal(setupCalls, 1);
  assert.equal(adapter.startConversationCalls.length, 2);
});

test("browser-side setup is revalidated before a fresh bootstrap is sent", async (t) => {
  const { session } = await createInterruptedResumeSession(t);
  const adapter = new FakeWebModelAdapter([]);
  let restorationCalls = 0;
  adapter.startConversationOutcome = () => {
    restorationCalls += 1;
    return restorationCalls === 1
      ? {
        status: "verified-fresh",
        conversationUrl: "https://chatgpt.com/",
        targetId: "fake-target",
      }
      : {
        status: "restored-existing",
        conversationUrl: "https://chatgpt.com/c/user-selected-history",
        targetId: "fake-target",
      };
  };
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    postAuthSetup: async () => {
      adapter.conversationUrl = "https://chatgpt.com/c/user-selected-history";
    },
  });

  await assert.rejects(
    runtime.run({ resume: true }),
    (error) => error.code === "CONVERSATION_NOT_FRESH",
  );

  assert.equal(restorationCalls, 2);
  assert.deepEqual(adapter.sentMessages, []);
});

test("a pre-submit rebuild failure does not commit its instruction", async (t) => {
  const instruction = "Add the unsent search page";
  const { session } = await createInterruptedResumeSession(t);
  await session.appendInstruction(instruction);
  const firstAdapter = new FakeWebModelAdapter([]);
  firstAdapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };
  firstAdapter.sendMessage = async () => {
    firstAdapter.lastSendStatus = "not-submitted";
    throw new Error("composer failed before submission");
  };

  await assert.rejects(
    runtimeForResume(session, firstAdapter).run({
      resume: true,
      instruction,
    }),
    /composer failed before submission/,
  );
  let transcript = await session.readTranscript();
  assert.equal(transcript.items.length, 1);
  assert.equal(session.state.pendingOutbound, null);

  // A normal CLI retry records the same instruction again. Identical unsent
  // follow-up records are deduplicated by the rebuild safety gate.
  await session.appendInstruction(instruction);
  const retryAdapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Recovered.</message></agent_response>",
  ]);
  retryAdapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await runtimeForResume(session, retryAdapter).run({
    resume: true,
    instruction,
  });

  assert.match(retryAdapter.sentMessages[0], /Add the unsent search page/);
  transcript = await session.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "user").length,
    2,
  );
});

test("fresh fallback refuses an earlier commit-unknown outbound message", async (t) => {
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      conversationTargetId: "target-uncertain",
      pendingOutbound: {
        kind: "fresh_rebuild",
        status: "commit-unknown",
      },
    },
  });
  const adapter = new FakeWebModelAdapter([]);
  adapter.startConversationOutcome = {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  };

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(adapter.sentMessages, []);
  assert.equal(adapter.launched, false);
  assert.equal(
    session.state.conversationUrl,
    "https://chatgpt.com/c/WEB:expired",
  );
  assert.equal(session.state.conversationTargetId, "target-uncertain");
});

test("fresh fallback fails closed for any committed model or tool history", async (t) => {
  const task = "Do not replay progressed work";
  const pending = {
    callId: "call_pending",
    name: "fs.write",
    ok: true,
    message: "already wrote",
  };
  const cases = [
    {
      name: "missing opening transcript",
      transcriptItems: [],
    },
    {
      name: "pending result",
      state: { pendingToolResult: pending },
    },
    {
      name: "completed tool",
      state: { completedTools: { fingerprint: { result: pending } } },
    },
    {
      name: "side effect",
      state: {
        sideEffectTools: {
          operation: { status: "running", name: "fs.write" },
        },
      },
    },
    {
      name: "completed assistant event without transcript",
      event: {
        type: "model.message_complete",
        payload: {
          assistantMessageId: null,
          raw: "unrecorded assistant reply",
        },
      },
    },
    {
      name: "assistant transcript",
      transcriptItems: [
        transcriptUser(task),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "progress" }],
        },
      ],
    },
    {
      name: "tool call transcript",
      transcriptItems: [
        transcriptUser(task),
        {
          type: "function_call",
          name: "fs.read",
          arguments: "{}",
          call_id: "call_existing",
        },
      ],
    },
    {
      name: "tool output transcript",
      transcriptItems: [
        transcriptUser(task),
        {
          type: "function_call_output",
          call_id: "call_existing",
          output: "status: ok",
        },
      ],
    },
    {
      name: "opening attachment",
      transcriptItems: [transcriptUser(task, {
        attachments: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
      })],
    },
    {
      name: "malformed attachment metadata",
      transcriptItems: [{
        ...transcriptUser(task),
        attachments: { name: "brief.pdf", path: "/tmp/brief.pdf" },
      }],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { session } = await createInterruptedResumeSession(t, {
        task,
        state: scenario.state,
        transcriptItems: scenario.transcriptItems,
      });
      if (scenario.event) {
        await session.appendEvent(scenario.event.type, scenario.event.payload);
      }
      const before = structuredClone({
        pendingToolResult: session.state.pendingToolResult,
        completedTools: session.state.completedTools,
        sideEffectTools: session.state.sideEffectTools,
      });
      const adapter = new FakeWebModelAdapter([]);
      adapter.startConversationOutcome = {
        status: "verified-fresh",
        conversationUrl: "https://chatgpt.com/",
      };

      await assert.rejects(
        runtimeForResume(session, adapter).run({ resume: true }),
        (error) => {
          assert.equal(error.code, "CONVERSATION_REBUILD_UNSAFE");
          return true;
        },
      );
      assert.deepEqual(adapter.sentMessages, []);
      assert.deepEqual(
        {
          pendingToolResult: session.state.pendingToolResult,
          completedTools: session.state.completedTools,
          sideEffectTools: session.state.sideEffectTools,
        },
        before,
        "unsafe fallback must preserve recovery ledgers",
      );
    });
  }
});

test("resends a pending tool result before continuing a recovered task", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const session = await TaskSession.create({
    tasksDir,
    task: "Recover",
    projectRoot,
    mode: "Pro",
  });
  await session.update({
    phase: "waiting_model",
    conversationUrl: "https://chatgpt.com/c/recover",
    pendingToolResult: {
      callId: "call_pending",
      name: "fs.write",
      ok: true,
      message: "Wrote file.",
    },
  });
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call id="inspect" name="fs.list"><args/></tool_call>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Recovered.</message>
    </agent_response>`,
  ]);
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run({
    resume: true,
    instruction: "Also verify it",
  });

  assert.match(adapter.sentMessages[0], /<tool_result name="fs\.write"/);
  assert.doesNotMatch(adapter.sentMessages[0], /call_id=/);
  assert.match(adapter.sentMessages[0], /<resume_instruction>/);
  assertOneTrailingReminder(adapter.sentMessages[0]);
  assert.equal(session.state.pendingToolResult, null);
});

test("does not reuse an identical read across different turns", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const write = (id, content) => `<agent_response>
    <done>false</done>
    <tool_call id="${id}" name="fs.write">
      <args><path>state.txt</path><content>${content}</content></args>
    </tool_call>
  </agent_response>`;
  const read = `<agent_response>
    <done>false</done>
    <tool_call id="read" name="fs.read">
      <args><path>state.txt</path></args>
    </tool_call>
  </agent_response>`;
  const adapter = new FakeWebModelAdapter([
    write("write_one", "one"),
    read,
    write("write_two", "two"),
    read,
    `<agent_response><done>true</done><message>done</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Read changing state",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();

  assert.match(adapter.sentMessages[2], /"content":"one"/);
  assert.match(adapter.sentMessages[4], /"content":"two"/);
});


test("allows a direct done=true answer without forcing a tool call", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // A task may be answerable directly (e.g. a question) with no local tool.
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>The answer is 4.</message>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "What is 2 + 2?",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "The answer is 4.");
  assert.equal(session.state.phase, "idle");
  // Completed on the first turn: only the opening message was sent, no gate
  // protocol-error was pushed back.
  assert.equal(adapter.sentMessages.length, 1);
});

test("completes done=true even when the task wording implies commands", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // The task text mentions "run" and "build", but the model answers directly
  // and marks the run done. The runtime must accept that without demanding
  // tool "evidence" or pushing the model to keep working.
  const adapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>To run the build, use npm run build.</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    sessionsDir,
    task: "How do I run the build for this project?",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "To run the build, use npm run build.");
  assert.equal(session.state.phase, "idle");
  // Only the opening message was sent: no completion-rejection was pushed back.
  assert.equal(adapter.sentMessages.length, 1);
});

test("merges the trailing markdown report into the done=true final answer", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // GLM-style reply: a short done/true stub inside the envelope, with the real
  // deliverable (the report) rendered after it.
  const adapter = new FakeWebModelAdapter([
    "思考过程\nxml\n<agent_response><done>true</done><message>审查完成</message></agent_response>\n"
      + "应用分析报告：sweep\n概述\n一个 Swift 磁盘清理工具",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Review the project.",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(
    result.message,
    "审查完成\n\n应用分析报告：sweep\n概述\n一个 Swift 磁盘清理工具",
  );
  assert.equal(session.state.phase, "idle");
  assert.equal(
    session.state.lastMessage,
    result.message,
  );
  // The transcript records the merged message too.
  const transcript = await session.readTranscript();
  const assistantItems = transcript.items.filter(
    (entry) => entry.item.type === "message" && entry.item.role === "assistant",
  );
  assert.match(assistantItems.at(-1).item.content[0].text, /应用分析报告/);
  assert.equal(adapter.sentMessages.length, 1);
});

test("treats a plain non-protocol reply as the final answer instead of retrying", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // The model answers in plain prose with no <agent_response> at all. There is
  // no envelope, so no tool could ever be involved: the runtime must end the
  // run and show the prose instead of burning protocol-error retries.
  const adapter = new FakeWebModelAdapter([
    "思考过程\n跳过\n\n抱歉，我无法完成这个任务，因为项目缺少说明文件。",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Deploy the site.",
    projectRoot,
    mode: "Pro",
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  const result = await runtime.run();

  assert.equal(result.message, "抱歉，我无法完成这个任务，因为项目缺少说明文件。");
  assert.equal(session.state.phase, "idle");
  assert.equal(session.state.lastMessage, result.message);
  // No protocol-error was pushed back: exactly one outbound message.
  assert.equal(adapter.sentMessages.length, 1);
  const plainEvent = events.find((e) => e.type === "protocol.plain_answer");
  assert.ok(plainEvent, "a protocol.plain_answer event is emitted");
  const completed = events.find((e) => e.type === "run.completed");
  assert.equal(completed.payload.plainAnswer, true);
});

test("a broken envelope still triggers a protocol retry (never guessed as done)", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // The reply contains <agent_response but the XML is malformed — the model
  // tried the protocol. It must NOT be treated as a plain answer; the runtime
  // pushes a format error back and continues (then the model finishes).
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>unclosed",
    "<agent_response><done>true</done><message>fixed</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Hello.",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "fixed");
  assert.equal(session.state.phase, "idle");
  // Two sends: the opening message plus the protocol-error feedback.
  assert.equal(adapter.sentMessages.length, 2);
  assert.match(adapter.sentMessages[1], /protocol_error/);
});

test("a tool call written inside a done=true message is re-prompted, not swallowed", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // DeepSeek-style slip: the model puts <tool_calls><invoke> INSIDE the message
  // of a done=true envelope. The runtime must NOT complete with raw XML as the
  // answer; it feeds the format error back and lets the model redo it as a real
  // tool call, which then executes and the run finishes properly.
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message><tool_calls><invoke name=\"fs.write\"><parameter name=\"path\">slip.txt</parameter><parameter name=\"content\">ok</parameter></invoke></tool_calls></message></agent_response>",
    "<agent_response><done>false</done><message>writing now</message>"
      + "<tool_call name=\"fs.write\"><args><path>slip.txt</path><content>ok</content></args></tool_call></agent_response>",
    "<agent_response><done>true</done><message>done</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Write slip.txt.",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "done");
  assert.equal(await fs.readFile(path.join(projectRoot, "slip.txt"), "utf8"), "ok");
  assert.equal(session.state.phase, "idle");
  // Sends: opening + protocol-error feedback + tool result.
  assert.equal(adapter.sentMessages.length, 3);
  assert.match(adapter.sentMessages[1], /protocol_error/);
  assert.match(adapter.sentMessages[2], /<tool_result name="fs\.write"/);
});

test("a bare tool_calls reply without an envelope is a tool request, not a plain answer", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // The model emits a bare Claude-style tool call with NO <agent_response>.
  // It must NOT be displayed as a plain final answer; it is a tool request
  // and feeds the protocol-error retry path (the model then finishes).
  const adapter = new FakeWebModelAdapter([
    "<tool_calls><invoke name=\"fs.write\"><parameter name=\"path\" string=\"true\">bare.txt</parameter><parameter name=\"content\" string=\"true\">ok</parameter></invoke></tool_calls>",
    "<agent_response><done>true</done><message>done</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Write bare.txt.",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "done");
  assert.equal(await fs.readFile(path.join(projectRoot, "bare.txt"), "utf8"), "ok");
  // The bare tool call was wrapped and executed, then the result was returned.
  assert.equal(adapter.sentMessages.length, 2);
  assert.match(adapter.sentMessages[1], /<tool_result name="fs\.write"/);
});

test("done ends the current run but the same session accepts a follow-up", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const session = await TaskSession.create({
    sessionsDir,
    task: "Answer once",
    projectRoot,
    mode: "Pro",
  });
  const makeRuntime = (adapter) => new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const firstAdapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>First answer.</message></agent_response>`,
  ]);
  await makeRuntime(firstAdapter).run();
  const conversationUrl = session.state.conversationUrl;
  assert.equal(session.state.phase, "idle");

  const followUpAdapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>Follow-up answer.</message></agent_response>`,
  ]);
  await session.appendInstruction("Now answer again");
  await makeRuntime(followUpAdapter).run({
    resume: true,
    instruction: "Now answer again",
  });

  assert.equal(followUpAdapter.startConversationCalls[0], conversationUrl);
  assert.equal(
    followUpAdapter.startConversationOptions[0].expectedAssistantMessageId,
    "assistant-1",
  );
  assert.equal(
    followUpAdapter.startConversationOptions[0].expectedUserMessageId,
    "user-1",
  );
  assert.doesNotMatch(followUpAdapter.sentMessages[0], /<agent_protocol>/);
  assert.match(followUpAdapter.sentMessages[0], /^Now answer again\n/);
  assert.equal(session.state.phase, "idle");
  assert.equal(session.state.lastMessage, "Follow-up answer.");
  const transcript = await session.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "user").length,
    2,
  );
});

test("does not carry an older assistant id past an unidentified reply", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const session = await TaskSession.create({
    sessionsDir,
    task: "Answer",
    projectRoot,
    mode: "Pro",
  });
  await session.update({
    conversationUrl: "https://chatgpt.com/c/existing",
    lastAssistantMessageId: "assistant-old",
  });

  const unidentifiedAdapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>New unidentified answer.</message></agent_response>`,
  ]);
  unidentifiedAdapter.getLastAssistantMessageId = async () => null;
  const makeRuntime = (adapter) => new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await makeRuntime(unidentifiedAdapter).run({
    resume: true,
    instruction: "Next",
  });
  assert.equal(
    unidentifiedAdapter.startConversationOptions[0].expectedAssistantMessageId,
    "assistant-old",
  );
  assert.equal(session.state.lastAssistantMessageId, null);

  const followingAdapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>Following answer.</message></agent_response>`,
  ]);
  await makeRuntime(followingAdapter).run({
    resume: true,
    instruction: "Again",
  });
  assert.equal(
    followingAdapter.startConversationOptions[0].expectedAssistantMessageId,
    null,
  );
});

test("still rejects done=true with an empty final message", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>   </message>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Now with a real summary.</message>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Summarize",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Now with a real summary.");
  // The empty-message turn was pushed back as a protocol error before the
  // second, valid completion was accepted.
  assert.match(adapter.sentMessages[1], /done=true requires a non-empty final message/i);
  assertOneTrailingReminder(adapter.sentMessages[1]);
});

test("keeps a completed tool result pending when sending it crashes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  class CrashOnToolResultSendAdapter extends FakeWebModelAdapter {
    async sendMessage(text) {
      if (this.sentMessages.length === 1) {
        this.lastSendStatus = "not-submitted";
        throw new Error("simulated send crash");
      }
      await super.sendMessage(text);
    }
  }

  const firstAdapter = new CrashOnToolResultSendAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="fs.write">
        <args><path>send-crash.txt</path><content>once</content></args>
      </tool_call>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Recover a send crash",
    projectRoot,
    mode: "Pro",
  });
  const firstRuntime = new AgentRuntime({
    adapter: firstAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(firstRuntime.run(), /simulated send crash/);
  assert.match(session.state.pendingToolResult.callId, /^call_[a-f0-9]{16}$/);
  assert.equal(
    Object.values(session.state.sideEffectTools)[0].status,
    "completed",
  );

  const recovered = await TaskSession.load({
    tasksDir,
    taskId: session.taskId,
  });
  const recoveryAdapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>Recovered without replaying the write.</message>
    </agent_response>`,
  ]);
  recoveryAdapter.reconciliationOutcome = fakeReconciliationOutcome(
    recovered.state.pendingAssistantTurn,
  );
  const recoveryRuntime = new AgentRuntime({
    adapter: recoveryAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session: recovered,
    approval: async () => false,
  });

  await recoveryRuntime.run({ resume: true });

  assert.match(recoveryAdapter.sentMessages[0], /<tool_result name="fs\.write"/);
  assertOneTrailingReminder(recoveryAdapter.sentMessages[0]);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "send-crash.txt"), "utf8"),
    "once",
  );
  assert.equal(recovered.state.pendingToolResult, null);
});

test("recovers the reported committed bootstrap and executes its fs.write once", async (t) => {
  const task = "write a qsort.c and test it";
  const { projectRoot, session } = await createInterruptedResumeSession(t, {
    task,
    state: {
      turn: 0,
      conversationUrl: "https://chatgpt.com/",
      conversationTargetId: "fake-target",
      lastUserMessageId: null,
      lastAssistantMessageId: null,
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: "a31ab6af-d043-493b-9344-fe4fac5e3219",
        messageHash: "legacy-checkpoint-hash",
        preparedAt: "2026-09-08T05:49:51.000Z",
        transcriptItems: [],
        status: "commit-unknown",
      },
    },
  });
  const recoveredAssistant = `<agent_response>
    <done>false</done>
    <message>Writing qsort.c.</message>
    <tool_call name="fs.write">
      <args>
        <path>qsort.c</path>
        <content><![CDATA[int main(void) { return 0; }\n]]></content>
      </args>
    </tool_call>
  </agent_response>`;
  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>qsort.c was written.</message>
    </agent_response>`,
  ]);
  adapter.conversationUrl =
    "https://chatgpt.com/c/6a9fa20c-7094-83e8-a36e-be919fe3021a";
  adapter.reconciliationOutcome = {
    status: "complete",
    conversationUrl: adapter.conversationUrl,
    conversationTargetId: "fake-target",
    userMessageId: "5e5e5412-6805-42cf-8f13-4e14e4340d26",
    userTurn: 1,
    preOutboundMarkerIds: [],
    assistantBaseline: { ids: [], count: 0, maxTurn: null, lastText: "" },
    assistantCandidateMessageId: "837c170f-b89e-447c-ada8-0a55ec23456f",
    assistantCandidateTurn: 2,
    assistantMessageId: "837c170f-b89e-447c-ada8-0a55ec23456f",
    assistantTurn: 2,
    rawResponse: recoveredAssistant,
    responseHash: createHash("sha256").update(recoveredAssistant).digest("hex"),
  };
  const events = [];

  const result = await runtimeForResume(session, adapter, { events }).run({
    resume: true,
  });

  assert.equal(result.message, "qsort.c was written.");
  assert.equal(
    await fs.readFile(path.join(projectRoot, "qsort.c"), "utf8"),
    "int main(void) { return 0; }\n",
  );
  assert.deepEqual(adapter.recoveryTargetCalls, ["fake-target"]);
  assert.equal(adapter.startConversationCalls.length, 0);
  assert.equal(adapter.sentMessages.length, 1);
  assert.match(adapter.sentMessages[0], /<tool_result name="fs\.write"/);
  assert.doesNotMatch(adapter.sentMessages[0], /## User task/);
  assert.equal(
    events.filter((event) => event.type === "outbound.reconciled").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "model.message_sent").length,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  assert.equal(Object.keys(session.state.sideEffectTools).length, 1);
  assert.equal(
    Object.values(session.state.sideEffectTools)[0].status,
    "completed",
  );
  assert.equal(session.state.pendingOutbound, null);
  assert.equal(session.state.pendingAssistantTurn, null);
  const transcript = await session.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "user").length,
    1,
  );
});

for (const recoveryInput of ["instruction", "files"]) {
  test(`pending recovery rejects ${recoveryInput} before browser launch`, async (t) => {
    const { session } = await createInterruptedResumeSession(t, {
      state: {
        conversationTargetId: "fake-target",
        pendingOutbound: {
          kind: "bootstrap",
          outboundId: "11111111-1111-4111-8111-111111111111",
          transcriptItems: [],
          status: "commit-unknown",
        },
      },
    });
    const adapter = new FakeWebModelAdapter([]);
    const pendingBefore = structuredClone(session.state.pendingOutbound);

    await assert.rejects(
      runtimeForResume(session, adapter).run({
        resume: true,
        instruction: recoveryInput === "instruction" ? "do something else" : null,
        files: recoveryInput === "files"
          ? [{ name: "extra.txt", path: "/tmp/extra.txt" }]
          : [],
      }),
      (error) => error.code === "RECOVERY_REQUIRES_BARE_RESUME",
    );
    assert.equal(adapter.launched, false);
    assert.deepEqual(session.state.pendingOutbound, pendingBefore);
  });
}

test("unsupported providers reject pending recovery before browser launch", async (t) => {
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      conversationTargetId: "fake-target",
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: "11111111-1111-4111-8111-111111111111",
        transcriptItems: [],
        status: "commit-unknown",
      },
    },
  });
  const adapter = new FakeWebModelAdapter([]);
  adapter.pendingOutboundRecoverySupported = false;

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => error.code === "OUTBOUND_RECOVERY_UNSUPPORTED",
  );
  assert.equal(adapter.launched, false);
  assert.deepEqual(adapter.sentMessages, []);
  assert.notEqual(session.state.pendingOutbound, null);
});

test("providers without marker reconciliation resume a confirmed assistant handoff", async (t) => {
  const conversationUrl = "https://gemini.google.com/app/confirmed";
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      provider: "gemini",
      conversationUrl,
      conversationTargetId: "fake-target",
      pendingAssistantTurn: {
        version: 1,
        handoffId: "outbound:11111111-1111-4111-8111-111111111111",
        sourceOutboundId: "11111111-1111-4111-8111-111111111111",
        outboundKind: "bootstrap",
        runtimeTurn: 1,
        status: "waiting",
        conversationUrl,
        conversationTargetId: "fake-target",
        userMessageId: "user-confirmed",
        userTurn: 1,
        assistantBaseline: { ids: [], count: 0, maxTurn: null },
        pendingToolAcknowledgement: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    },
  });
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Legacy provider recovered.</message></agent_response>",
  ]);
  adapter.pendingOutboundRecoverySupported = false;
  adapter.classifyConversationUrl = (value) => (
    String(value).includes("/app/") ? "restorable" : "fresh"
  );
  adapter.conversationUrl = conversationUrl;
  adapter.startConversationOutcome = {
    status: "restored-existing",
    conversationUrl,
    targetId: "fake-target",
  };

  const result = await runtimeForResume(session, adapter).run({ resume: true });

  assert.equal(result.message, "Legacy provider recovered.");
  assert.deepEqual(adapter.recoveryTargetCalls, []);
  assert.deepEqual(adapter.sentMessages, []);
  assert.equal(adapter.startConversationCalls[0], conversationUrl);
  assert.equal(session.state.pendingAssistantTurn, null);
});

test("pending child recovery prefers its target over an older parent handoff", async (t) => {
  const childOutboundId = "22222222-2222-4222-8222-222222222222";
  const parentRaw = "<agent_response><done>false</done><message>parent</message></agent_response>";
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      conversationUrl: "https://chatgpt.com/c/child",
      conversationTargetId: "target-child",
      pendingOutbound: {
        kind: "tool_result",
        outboundId: childOutboundId,
        transcriptItems: [],
        conversationUrl: "https://chatgpt.com/c/child",
        conversationTargetId: "target-child",
        status: "commit-unknown",
      },
      pendingAssistantTurn: {
        version: 1,
        handoffId: "outbound:11111111-1111-4111-8111-111111111111",
        sourceOutboundId: "11111111-1111-4111-8111-111111111111",
        outboundKind: "runtime_message",
        runtimeTurn: 1,
        status: "complete",
        conversationUrl: "https://chatgpt.com/c/parent",
        conversationTargetId: "target-parent",
        userMessageId: "user-parent",
        userTurn: 1,
        assistantMessageId: "assistant-parent",
        assistantTurn: 2,
        rawResponse: parentRaw,
        responseHash: createHash("sha256").update(parentRaw).digest("hex"),
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    },
  });
  const childRaw = "<agent_response><done>true</done><message>Child recovered.</message></agent_response>";
  const adapter = new FakeWebModelAdapter([]);
  adapter.targetId = "target-child";
  adapter.conversationUrl = "https://chatgpt.com/c/child";
  adapter.reconciliationOutcome = {
    status: "complete",
    conversationUrl: adapter.conversationUrl,
    conversationTargetId: adapter.targetId,
    userMessageId: "user-child",
    userTurn: 3,
    preOutboundMarkerIds: ["assistant-parent"],
    assistantBaseline: {
      ids: ["assistant-parent"],
      count: 1,
      maxTurn: 2,
      lastText: parentRaw,
    },
    assistantCandidateMessageId: "assistant-child",
    assistantCandidateTurn: 4,
    assistantMessageId: "assistant-child",
    assistantTurn: 4,
    rawResponse: childRaw,
    responseHash: createHash("sha256").update(childRaw).digest("hex"),
  };

  const result = await runtimeForResume(session, adapter).run({ resume: true });

  assert.equal(result.message, "Child recovered.");
  assert.deepEqual(adapter.recoveryTargetCalls, ["target-child"]);
  assert.equal(
    adapter.reconciliationCalls[0].priorHandoff,
    null,
  );
});

test("recovery rejects a root target that conflicts with its pending outbound", async (t) => {
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      conversationTargetId: "target-root",
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: "11111111-1111-4111-8111-111111111111",
        transcriptItems: [],
        conversationTargetId: "target-outbound",
        status: "commit-unknown",
      },
    },
  });
  const adapter = new FakeWebModelAdapter([]);

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.equal(adapter.launched, false);
  assert.deepEqual(adapter.recoveryTargetCalls, []);
});

test("recovery rejects an outcome labeled with a substitute target", async (t) => {
  const targetId = "target-attached";
  const { session } = await createInterruptedResumeSession(t, {
    state: {
      conversationUrl: "https://chatgpt.com/c/attached",
      conversationTargetId: targetId,
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: "11111111-1111-4111-8111-111111111111",
        transcriptItems: [],
        conversationTargetId: targetId,
        status: "commit-unknown",
      },
    },
  });
  const rawResponse = "<agent_response><done>true</done><message>substitute</message></agent_response>";
  const adapter = new FakeWebModelAdapter([]);
  adapter.targetId = targetId;
  adapter.conversationUrl = "https://chatgpt.com/c/attached";
  adapter.reconciliationOutcome = {
    status: "complete",
    conversationUrl: "https://chatgpt.com/c/substitute",
    conversationTargetId: "target-substitute",
    userMessageId: "user-substitute",
    userTurn: 1,
    assistantBaseline: { ids: [], count: 0, maxTurn: null },
    assistantMessageId: "assistant-substitute",
    assistantTurn: 2,
    rawResponse,
    responseHash: createHash("sha256").update(rawResponse).digest("hex"),
  };

  await assert.rejects(
    runtimeForResume(session, adapter).run({ resume: true }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );

  assert.deepEqual(adapter.recoveryTargetCalls, [targetId]);
  assert.notEqual(session.state.pendingOutbound, null);
  assert.equal(session.state.conversationTargetId, targetId);
});

test("a crash after assistant receipt resumes from the durable raw response", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-handoff-crash-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const rawResponse = [
    "<agent_response>",
    "<done>true</done>",
    "<message>Durably recovered.</message>",
    "</agent_response>",
  ].join("");
  const session = await TaskSession.create({
    sessionsDir,
    task: "checkpoint assistant raw",
    projectRoot,
    mode: null,
  });
  const originalComplete = session.completePendingAssistantTurn.bind(session);
  let injected = false;
  session.completePendingAssistantTurn = async (options) => {
    const completed = await originalComplete(options);
    if (!injected) {
      injected = true;
      throw new Error("crash after assistant checkpoint");
    }
    return completed;
  };
  const firstAdapter = new FakeWebModelAdapter([rawResponse]);

  await assert.rejects(
    runtimeForResume(session, firstAdapter).run(),
    /crash after assistant checkpoint/,
  );
  assert.equal(session.state.pendingAssistantTurn.status, "complete");
  assert.equal(session.state.pendingAssistantTurn.rawResponse, rawResponse);

  const recovered = await TaskSession.load({
    sessionsDir,
    taskId: session.taskId,
  });
  const recoveryAdapter = new FakeWebModelAdapter([]);
  recoveryAdapter.conversationUrl = recovered.state.conversationUrl;
  recoveryAdapter.reconciliationOutcome = fakeReconciliationOutcome(
    recovered.state.pendingAssistantTurn,
  );
  const result = await runtimeForResume(recovered, recoveryAdapter).run({
    resume: true,
  });

  assert.equal(result.message, "Durably recovered.");
  assert.deepEqual(recoveryAdapter.sentMessages, []);
  assert.equal(recovered.state.pendingAssistantTurn, null);
  const transcript = await recovered.readTranscript();
  assert.equal(
    transcript.items.filter((entry) => entry.item.role === "assistant").length,
    1,
  );
});

test("commit-unknown tool results are checkpointed and never replayed", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  class AmbiguousToolResultAdapter extends FakeWebModelAdapter {
    async sendMessage(text, options = {}) {
      if (
        this.sentMessages.length > 0
        && String(text).includes("<tool_result")
      ) {
        this.lastSendStatus = "commit-unknown";
        this.sentMessages.push(text);
        throw new Error("Connection closed after tool result submission");
      }
      return await super.sendMessage(text, options);
    }
  }

  const adapter = new AmbiguousToolResultAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="missing.tool"><args/></tool_call>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    sessionsDir,
    task: "Do not duplicate a tool result",
    projectRoot,
    mode: null,
  });

  await assert.rejects(
    runtimeForResume(session, adapter).run(),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );
  assert.equal(session.state.pendingOutbound.kind, "tool_result");
  assert.equal(session.state.pendingOutbound.status, "commit-unknown");
  assert.notEqual(session.state.pendingToolResult, null);

  const retryAdapter = new FakeWebModelAdapter([]);
  await assert.rejects(
    runtimeForResume(session, retryAdapter).run({ resume: true }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(retryAdapter.sentMessages, []);
  assert.equal(retryAdapter.launched, true);
  assert.deepEqual(retryAdapter.recoveryTargetCalls, ["fake-target"]);
  assert.notEqual(session.state.pendingOutbound, null);
});

test("persists the concrete conversation URL when the first send crashes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  class CrashAfterFirstSendAdapter extends FakeWebModelAdapter {
    async sendMessage(text) {
      await super.sendMessage(text);
      throw new Error("crashed after browser submission");
    }
  }

  const session = await TaskSession.create({
    sessionsDir,
    task: "Start safely",
    projectRoot,
    mode: "Pro",
  });
  const adapter = new CrashAfterFirstSendAdapter([]);
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(runtime.run(), /crashed after browser submission/);
  assert.equal(session.state.conversationUrl, "https://chatgpt.com/c/fake");
});

test("persists a late canonical URL even when the model turn times out", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const provisionalUrl = "https://chatgpt.com/c/WEB:waiting";
  const canonicalUrl = "https://chatgpt.com/c/canonical-after-timeout";
  const adapter = new FakeWebModelAdapter([]);
  const originalSend = adapter.sendMessage.bind(adapter);
  adapter.sendMessage = async (text, options) => {
    await originalSend(text, options);
    adapter.conversationUrl = provisionalUrl;
    await adapter.conversationIdentityListener?.({
      conversationUrl: provisionalUrl,
      targetId: adapter.targetId,
      kind: "provisional",
    });
  };
  adapter.waitForTurnComplete = async () => {
    adapter.conversationUrl = canonicalUrl;
    // Simulate the top-frame navigation callback firing before CDP dies. The
    // final synchronous URL read then fails, but the eager checkpoint survives.
    await adapter.conversationIdentityListener?.({
      conversationUrl: canonicalUrl,
      targetId: adapter.targetId,
      kind: "restorable",
    });
    adapter.getConversationIdentity = () => {
      throw new Error("Connection closed while reading URL");
    };
    throw new BrowserAdapterError("Turn timed out.", {
      code: "TURN_TIMEOUT",
    });
  };
  const session = await TaskSession.create({
    sessionsDir,
    task: "Wait for canonicalization",
    projectRoot,
    mode: null,
  });

  await assert.rejects(
    runtimeForResume(session, adapter).run(),
    (error) => error.code === "TURN_TIMEOUT",
  );

  assert.equal(session.state.conversationUrl, canonicalUrl);
  assert.equal(session.state.conversationTargetId, adapter.targetId);
});

test("a final assistant checkpoint cannot overwrite a newer canonical URL", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const provisionalUrl = "https://chatgpt.com/c/WEB:race";
  const canonicalUrl = "https://chatgpt.com/c/canonical-race-winner";
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Done.</message></agent_response>",
  ]);
  const originalSend = adapter.sendMessage.bind(adapter);
  adapter.sendMessage = async (text, options) => {
    const result = await originalSend(text, options);
    adapter.conversationUrl = provisionalUrl;
    await adapter.conversationIdentityListener?.({
      conversationUrl: provisionalUrl,
      targetId: adapter.targetId,
      kind: "provisional",
    });
    return result;
  };
  let canonicalPublished = false;
  adapter.getLastAssistantMessageId = async () => {
    if (!canonicalPublished) {
      canonicalPublished = true;
      adapter.conversationUrl = canonicalUrl;
      await adapter.conversationIdentityListener?.({
        conversationUrl: canonicalUrl,
        targetId: adapter.targetId,
        kind: "restorable",
      });
    }
    return adapter.lastAssistantMessageId;
  };
  const session = await TaskSession.create({
    sessionsDir,
    task: "Preserve the newest canonical identity",
    projectRoot,
    mode: null,
  });

  await runtimeForResume(session, adapter).run();

  assert.equal(session.state.conversationUrl, canonicalUrl);
  assert.equal(session.state.lastAssistantMessageId, "assistant-1");
});

test("a navigation callback stays newer than an in-flight stale identity read", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const provisionalUrl = "https://chatgpt.com/c/WEB:stale-read";
  const canonicalUrl = "https://chatgpt.com/c/callback-wins";
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Done.</message></agent_response>",
  ]);
  let identityReads = 0;
  adapter.getConversationIdentity = async () => {
    identityReads += 1;
    if (identityReads === 3) {
      adapter.conversationUrl = canonicalUrl;
      void adapter.conversationIdentityListener?.({
        conversationUrl: canonicalUrl,
        targetId: adapter.targetId,
        kind: "restorable",
      });
      await Promise.resolve();
      return {
        conversationUrl: provisionalUrl,
        targetId: adapter.targetId,
        kind: "provisional",
      };
    }
    return {
      conversationUrl: identityReads === 1 ? provisionalUrl : canonicalUrl,
      targetId: adapter.targetId,
      kind: identityReads === 1 ? "provisional" : "restorable",
    };
  };
  const session = await TaskSession.create({
    sessionsDir,
    task: "Keep the navigation callback authoritative",
    projectRoot,
    mode: null,
  });

  await runtimeForResume(session, adapter).run();

  assert.equal(identityReads, 3);
  assert.equal(session.state.conversationUrl, canonicalUrl);
});

test("a failed URL observation does not discard a completed model reply", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Complete reply.</message></agent_response>",
  ]);
  const originalIdentity = adapter.getConversationIdentity.bind(adapter);
  let identityReads = 0;
  adapter.getConversationIdentity = () => {
    identityReads += 1;
    if (identityReads > 1) {
      throw new Error("transient CDP URL read failed");
    }
    return originalIdentity();
  };
  const session = await TaskSession.create({
    sessionsDir,
    task: "Keep the completed reply",
    projectRoot,
    mode: null,
  });

  const result = await runtimeForResume(session, adapter).run();

  assert.equal(result.message, "Complete reply.");
  assert.equal(session.state.lastMessage, "Complete reply.");
});

test("a transient non-conversation redirect cannot poison the saved URL", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const sessionsDir = path.join(base, "sessions");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const canonicalUrl = "https://chatgpt.com/c/trusted";
  const adapter = new FakeWebModelAdapter([]);
  adapter.sendMessage = async (text, options) => {
    await FakeWebModelAdapter.prototype.sendMessage.call(adapter, text, options);
    adapter.conversationUrl = canonicalUrl;
    await adapter.conversationIdentityListener?.({
      conversationUrl: canonicalUrl,
      targetId: adapter.targetId,
      kind: "restorable",
    });
  };
  adapter.waitForTurnComplete = async () => {
    adapter.conversationUrl = "https://chatgpt.com/settings";
    throw new BrowserAdapterError("Turn timed out.", {
      code: "TURN_TIMEOUT",
    });
  };
  const session = await TaskSession.create({
    sessionsDir,
    task: "Keep the trusted URL",
    projectRoot,
    mode: null,
  });

  await assert.rejects(
    runtimeForResume(session, adapter).run(),
    (error) => error.code === "TURN_TIMEOUT",
  );

  assert.equal(session.state.conversationUrl, canonicalUrl);
});

test("keeps a sent tool result pending when waiting for the next turn crashes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const firstAdapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call name="fs.write">
        <args><path>wait-crash.txt</path><content>once</content></args>
      </tool_call>
    </agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Recover a wait crash",
    projectRoot,
    mode: "Pro",
  });
  const firstRuntime = new AgentRuntime({
    adapter: firstAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(firstRuntime.run(), /no more responses/i);
  assert.match(session.state.pendingToolResult.callId, /^call_[a-f0-9]{16}$/);

  const recovered = await TaskSession.load({
    tasksDir,
    taskId: session.taskId,
  });
  const recoveryAdapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>true</done>
      <message>Recovered after the pending result.</message>
    </agent_response>`,
  ]);
  recoveryAdapter.reconciliationOutcome = fakeReconciliationOutcome(
    recovered.state.pendingAssistantTurn,
  );
  const recoveryRuntime = new AgentRuntime({
    adapter: recoveryAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session: recovered,
    approval: async () => false,
  });

  await recoveryRuntime.run({ resume: true });

  assert.deepEqual(recoveryAdapter.sentMessages, []);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "wait-crash.txt"), "utf8"),
    "once",
  );
  assert.equal(recovered.state.pendingToolResult, null);
});

test("treats identical writes in later assistant messages as separate operations", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const replay = `<agent_response>
    <done>false</done>
    <tool_call id="append_once" name="fs.write">
      <args>
        <path>write-replay.txt</path>
        <content>x</content>
        <mode>append</mode>
      </args>
    </tool_call>
  </agent_response>`;
  const adapter = new FakeWebModelAdapter([
    replay,
    replay,
    `<agent_response><done>true</done><message>done</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Replay a write",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();

  assert.equal(
    await fs.readFile(path.join(projectRoot, "write-replay.txt"), "utf8"),
    "xx",
  );
  assert.equal(
    Object.values(session.state.sideEffectTools)[0].status,
    "completed",
  );
});

test("treats identical commands in later assistant messages as separate operations", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const script = "require('node:fs').appendFileSync('terminal-replay.txt','x')";
  const replay = `<agent_response>
    <done>false</done>
    <tool_call id="terminal_once" name="terminal.exec">
      <args>
        <program>${process.execPath}</program>
        <argv><item>-e</item><item>${script}</item></argv>
        <cwd>.</cwd>
        <timeout_ms>5000</timeout_ms>
      </args>
    </tool_call>
  </agent_response>`;
  const adapter = new FakeWebModelAdapter([
    replay,
    replay,
    `<agent_response><done>true</done><message>done</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Replay a command",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => true,
  });

  await runtime.run();

  assert.equal(
    await fs.readFile(path.join(projectRoot, "terminal-replay.txt"), "utf8"),
    "xx",
  );
});

test("ignores model-provided call ids and treats a later message as a new operation", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call id="conflicting_write" name="fs.write">
        <args><path>conflict.txt</path><content>first</content></args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <tool_call id="conflicting_write" name="fs.write">
        <args><path>conflict.txt</path><content>second</content></args>
      </tool_call>
    </agent_response>`,
    `<agent_response><done>true</done><message>done</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Reject conflicting call IDs",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();

  assert.equal(
    await fs.readFile(path.join(projectRoot, "conflict.txt"), "utf8"),
    "second",
  );
  assert.doesNotMatch(adapter.sentMessages[2], /call_id/);
});

test("marks a non-cooperative side-effect timeout as recoverable and unknown", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const registry = new ToolRegistry();
  registry.register({
    name: "test.slow_write",
    description: "Slow non-cooperative write",
    risk: "write",
    inputSchema: z.object({ path: z.string() }),
    execute: async (args, context) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await fs.writeFile(path.join(context.projectRoot, args.path), "late");
      return { ok: true, message: "late completion" };
    },
  });

  const adapter = new FakeWebModelAdapter([
    `<agent_response>
      <done>false</done>
      <tool_call id="slow_write" name="test.slow_write">
        <args><path>late.txt</path></args>
      </tool_call>
    </agent_response>`,
    `<agent_response><done>true</done><message>The operation is unknown; should I inspect local state?</message></agent_response>`,
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Bound a non-cooperative write",
    projectRoot,
    mode: "Pro",
  });
  const runtime = new AgentRuntime({
    adapter,
    registry,
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    limits: {
      ...DEFAULT_LIMITS,
      toolTimeoutMs: 10,
    },
  });

  await runtime.run();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const slowWrite = Object.values(session.state.sideEffectTools)[0];
  assert.equal(slowWrite.status, "unknown");
  assert.equal(
    slowWrite.result.meta.completionUnknown,
    true,
  );
  assert.match(adapter.sentMessages[1], /Completion is unknown/i);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "late.txt"), "utf8"),
    "late",
  );
});

function deadAssistantRequest() {
  return new BrowserAdapterError(
    "ChatGPT never started generating a reply.",
    { code: "DEAD_ASSISTANT_REQUEST" },
  );
}

test("asks ChatGPT to continue after a silently dead request", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    deadAssistantRequest(),
    deadAssistantRequest(),
    deadAssistantRequest(),
    "<agent_response><done>true</done><message>Recovered.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "UNIQUE_ORIGINAL_TASK",
    projectRoot,
    mode: null,
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  const result = await runtime.run();

  assert.equal(result.message, "Recovered.");
  assert.equal(adapter.sentMessages.length, 4);
  assert.match(adapter.sentMessages[0], /UNIQUE_ORIGINAL_TASK/);
  for (const continuation of adapter.sentMessages.slice(1)) {
    assert.match(continuation, /previous request received no reply/i);
    assert.match(continuation, /Do not repeat any local tool operation/i);
    assert.doesNotMatch(continuation, /UNIQUE_ORIGINAL_TASK/);
    assert.doesNotMatch(continuation, /<tool_result/);
    assertOneTrailingReminder(continuation);
  }
  const emptyEvents = events.filter(
    (event) => event.type === "model.empty_response",
  );
  assert.deepEqual(
    emptyEvents.map((event) => event.payload.retry),
    [1, 2, 3],
  );
  assert.ok(emptyEvents.every((event) => event.payload.deadRequest === true));
});

class ConnectionDroppingAdapter extends FakeWebModelAdapter {
  constructor(responses, { dropFirstSends = 1 } = {}) {
    super(responses);
    this.dropFirstSends = dropFirstSends;
    this.sendCalls = 0;
    this.sendOptions = [];
    this.reconnectCalls = 0;
    this.restoreCalls = [];
  }

  async sendMessage(text, options = {}) {
    this.sendCalls += 1;
    this.sendOptions.push(options);
    if (this.sendCalls <= this.dropFirstSends) {
      throw new Error("Target page, context or browser has been closed");
    }
    return await super.sendMessage(text, options);
  }

  async reconnect() {
    this.reconnectCalls += 1;
  }

  async startConversation(url, options = {}) {
    this.restoreCalls.push(url);
    return await super.startConversation(url, options);
  }
}

test("reconnects and resends when the browser connection dies during send", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new ConnectionDroppingAdapter([
    "<agent_response><done>true</done><message>Done after reconnect.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Recover from a dead connection",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Done after reconnect.");
  assert.equal(adapter.sendCalls, 2);
  assert.match(adapter.sendOptions[0].outboundId, /^[0-9a-f-]{36}$/);
  assert.equal(
    adapter.sendOptions[1].outboundId,
    adapter.sendOptions[0].outboundId,
  );
  assert.equal(adapter.reconnectCalls, 1);
  assert.ok(
    adapter.restoreCalls.some((url) => url?.includes("chatgpt.com")),
    "the conversation was restored after reconnecting",
  );
});

test("a pre-submit reconnect checkpoints the replacement target for recovery", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  class TargetMovingAdapter extends FakeWebModelAdapter {
    constructor() {
      super([]);
      this.sendCalls = 0;
    }

    async sendMessage(text) {
      this.sendCalls += 1;
      if (this.sendCalls === 1) {
        this.lastSendStatus = "not-submitted";
        throw new Error("Target page, context or browser has been closed");
      }
      this.lastSendStatus = "commit-unknown";
      this.sentMessages.push(text);
      throw new Error("Connection closed after Send was clicked");
    }

    async reconnect() {
      this.targetId = "fake-target-after-reconnect";
    }
  }

  const session = await TaskSession.create({
    tasksDir,
    task: "Checkpoint a reconnect target",
    projectRoot,
    mode: null,
  });
  const firstAdapter = new TargetMovingAdapter();

  await assert.rejects(
    runtimeForResume(session, firstAdapter).run(),
    /Connection closed after Send was clicked/,
  );
  assert.equal(
    session.state.pendingOutbound.conversationTargetId,
    "fake-target-after-reconnect",
  );

  const recoveredRaw = "<agent_response><done>true</done><message>Recovered on T2.</message></agent_response>";
  const recoveryAdapter = new FakeWebModelAdapter([]);
  recoveryAdapter.targetId = "fake-target-after-reconnect";
  recoveryAdapter.conversationUrl = "https://chatgpt.com/c/after-reconnect";
  recoveryAdapter.reconciliationOutcome = {
    status: "complete",
    conversationUrl: recoveryAdapter.conversationUrl,
    conversationTargetId: recoveryAdapter.targetId,
    userMessageId: "user-after-reconnect",
    userTurn: 1,
    preOutboundMarkerIds: [],
    assistantBaseline: { ids: [], count: 0, maxTurn: null, lastText: "" },
    assistantCandidateMessageId: "assistant-after-reconnect",
    assistantCandidateTurn: 2,
    assistantMessageId: "assistant-after-reconnect",
    assistantTurn: 2,
    rawResponse: recoveredRaw,
    responseHash: createHash("sha256").update(recoveredRaw).digest("hex"),
  };

  const result = await runtimeForResume(session, recoveryAdapter).run({
    resume: true,
  });
  assert.equal(result.message, "Recovered on T2.");
  assert.deepEqual(
    recoveryAdapter.recoveryTargetCalls,
    ["fake-target-after-reconnect"],
  );
});

test("does not resend after a connection loss with unknown commit status", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([]);
  let sendCalls = 0;
  let reconnectCalls = 0;
  adapter.sendMessage = async (text) => {
    sendCalls += 1;
    adapter.lastSendStatus = "commit-unknown";
    adapter.sentMessages.push(text);
    throw new Error("Connection closed after Send was clicked");
  };
  adapter.reconnect = async () => {
    reconnectCalls += 1;
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Never duplicate an ambiguous submission",
    projectRoot,
    mode: null,
  });

  await assert.rejects(
    runtimeForResume(session, adapter).run(),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );

  assert.equal(sendCalls, 1);
  assert.equal(reconnectCalls, 0);
  assert.equal(session.state.pendingOutbound.status, "commit-unknown");
});

test("reconnects and resumes waiting when the connection dies mid-turn", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  let waitCalls = 0;
  let reconnectCalls = 0;
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Recovered after reconnect.</message></agent_response>",
  ]);
  adapter.pendingOutboundRecoverySupported = false;
  const originalWait = adapter.waitForTurnComplete.bind(adapter);
  adapter.waitForTurnComplete = async (options) => {
    waitCalls += 1;
    if (waitCalls === 1) {
      throw new Error("Connection closed");
    }
    return await originalWait(options);
  };
  adapter.reconnect = async () => {
    reconnectCalls += 1;
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Resume waiting after a dead connection",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Recovered after reconnect.");
  assert.equal(waitCalls, 2);
  assert.equal(reconnectCalls, 1);
});

test("ChatGPT mid-turn connection loss reattaches the exact target", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  let waitCalls = 0;
  let reconnectCalls = 0;
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Exact target recovered.</message></agent_response>",
  ]);
  const originalWait = adapter.waitForTurnComplete.bind(adapter);
  adapter.waitForTurnComplete = async (options) => {
    waitCalls += 1;
    if (waitCalls === 1) {
      throw new Error("Connection closed");
    }
    return await originalWait(options);
  };
  adapter.reconnect = async () => {
    reconnectCalls += 1;
    adapter.targetId = "target-substitute";
  };
  adapter.reconciliationOutcome = ({ priorHandoff }) => (
    fakeReconciliationOutcome(priorHandoff)
  );
  const session = await TaskSession.create({
    tasksDir,
    task: "Recover an exact ChatGPT wait target",
    projectRoot,
    mode: null,
  });

  const result = await runtimeForResume(session, adapter).run();

  assert.equal(result.message, "Exact target recovered.");
  assert.equal(waitCalls, 2);
  assert.equal(reconnectCalls, 0);
  assert.deepEqual(adapter.recoveryTargetCalls, ["fake-target"]);
});

test("mid-turn reconnect refuses to continue on a verified fresh page", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([]);
  adapter.pendingOutboundRecoverySupported = false;
  adapter.waitForTurnComplete = async () => {
    throw new Error("Connection closed");
  };
  adapter.reconnect = async () => {};
  adapter.startConversationOutcome = () => ({
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  });
  const session = await TaskSession.create({
    tasksDir,
    task: "Do not continue on a blank reconnect",
    projectRoot,
    mode: null,
  });
  const runtime = runtimeForResume(session, adapter);

  await assert.rejects(
    runtime.run(),
    (error) => {
      assert.equal(error.code, "CONVERSATION_RESTORE_REQUIRED");
      return true;
    },
  );
  assert.equal(adapter.sentMessages.length, 1);
});

test("gives up after one reconnect attempt instead of looping forever", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  let reconnectCalls = 0;
  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Never reached.</message></agent_response>",
  ]);
  adapter.pendingOutboundRecoverySupported = false;
  adapter.waitForTurnComplete = async () => {
    throw new Error("Connection closed");
  };
  adapter.reconnect = async () => {
    reconnectCalls += 1;
    adapter.targetId = "fake-target-after-wait-reconnect";
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Dead connection loop",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(runtime.run(), /Connection closed/);
  assert.equal(reconnectCalls, 1);
  assert.equal(
    session.state.pendingAssistantTurn.conversationTargetId,
    "fake-target-after-wait-reconnect",
  );
  const reloaded = await TaskSession.load({
    tasksDir,
    taskId: session.taskId,
  });
  assert.equal(
    reloaded.state.pendingAssistantTurn.conversationTargetId,
    "fake-target-after-wait-reconnect",
  );
});

test("stops immediately when ChatGPT reports a usage limit instead of retrying the format", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "你已达到限额。请稍后重试。",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Usage limit task",
    projectRoot,
    mode: null,
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    runtime.run(),
    (error) => {
      assert.equal(error.code, "USAGE_LIMIT_REACHED");
      return true;
    },
  );
  // Only the bootstrap message was sent: no format-retry nudge.
  assert.equal(adapter.sentMessages.length, 1);
  assert.ok(events.some((event) => event.type === "model.limit_reached"));
});

test("emits the limit event when the adapter detects a usage-limit card", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([]);
  adapter.waitForTurnComplete = async () => {
    throw new BrowserAdapterError(
      "ChatGPT reported a usage limit (你已达到限额。请稍后重试。).",
      { code: "USAGE_LIMIT_REACHED" },
    );
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Adapter-detected limit",
    projectRoot,
    mode: null,
  });
  const events = [];
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    runtime.run(),
    (error) => {
      assert.equal(error.code, "USAGE_LIMIT_REACHED");
      return true;
    },
  );
  assert.ok(events.some((event) => event.type === "model.limit_reached"));
});

test("resume ignores legacy mode overrides and keeps the browser-selected model", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>First.</message></agent_response>",
    "<agent_response><done>true</done><message>Second.</message></agent_response>",
    "<agent_response><done>true</done><message>Third.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Mode selection",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  // Fresh run with no session mode: no selection.
  await runtime.run();
  assert.equal(adapter.mode, null);

  // Legacy callers may still pass a mode field; runtime ignores it.
  await runtime.run({ resume: true, mode: "legacy-mode" });
  assert.equal(adapter.mode, null);

  // A plain resume also leaves the browser-selected model untouched.
  await runtime.run({ resume: true });
  assert.equal(adapter.mode, null);
});

test("does not retry a submitted message whose DOM confirmation is missing", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([]);
  let sendCalls = 0;
  adapter.sendMessage = async () => {
    sendCalls += 1;
    adapter.lastSendStatus = "commit-unknown";
    throw new BrowserAdapterError(
      "ChatGPT did not confirm whether the sent message committed.",
      { code: "SEND_COMMIT_UNKNOWN" },
    );
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Do not duplicate an ambiguous send",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await assert.rejects(
    runtime.run(),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );

  assert.equal(sendCalls, 1);
  assert.equal(session.state.pendingOutbound.status, "commit-unknown");
});

test("resume launches with the conversation URL so an existing tab can be reused", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>First run.</message></agent_response>",
    "<agent_response><done>true</done><message>Resumed.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Tab reuse",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  await runtime.run();
  assert.equal(adapter.lastLaunchUrl, null);

  await runtime.run({ resume: true, instruction: "Continue" });
  assert.equal(adapter.lastLaunchUrl, "https://chatgpt.com/c/fake");
  assert.equal(adapter.lastLaunchOptions.preferredTargetId, "fake-target");
});

test("uses the same default timeout regardless of legacy session mode", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const seen = [];
  const adapter = new FakeWebModelAdapter(["<agent_response><done>true</done><message>ok</message></agent_response>"]);
  adapter.waitForTurnComplete = async (options) => {
    seen.push(options.timeoutMs);
    return "<agent_response><done>true</done><message>ok</message></agent_response>";
  };

  const proSession = await TaskSession.create({
    tasksDir,
    task: "Pro timeout",
    projectRoot,
    mode: "Pro",
  });
  await new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session: proSession,
    approval: async () => false,
  }).run();

  const plainSession = await TaskSession.create({
    tasksDir,
    task: "Default timeout",
    projectRoot,
    mode: null,
  });
  await new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session: plainSession,
    approval: async () => false,
  }).run();

  assert.equal(seen[0], DEFAULT_LIMITS.modelTurnTimeoutMs);
  assert.equal(seen[1], DEFAULT_LIMITS.modelTurnTimeoutMs);
});

test("an explicit --model-turn-timeout-ms overrides the default timeout", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const seen = [];
  const adapter = new FakeWebModelAdapter(["<agent_response><done>true</done><message>ok</message></agent_response>"]);
  adapter.waitForTurnComplete = async (options) => {
    seen.push(options.timeoutMs);
    return "<agent_response><done>true</done><message>ok</message></agent_response>";
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Explicit timeout",
    projectRoot,
    mode: "Pro",
  });
  await new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
    limits: resolveLimits({ modelTurnTimeoutMs: "720000" }),
  }).run();

  assert.equal(seen[0], 720_000);
});

test("recovers after a provider-side generation failure", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    new BrowserAdapterError(
      "ChatGPT generation failed (Internal Server Error).",
      { code: "GENERATION_FAILED" },
    ),
    "<agent_response><done>true</done><message>Recovered after retry.</message></agent_response>",
  ]);
  const session = await TaskSession.create({
    tasksDir,
    task: "Server error recovery",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: new ToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval: async () => false,
  });

  const result = await runtime.run();

  assert.equal(result.message, "Recovered after retry.");
  assert.match(adapter.sentMessages[1], /generation failure \(server error\)/i);
  assertOneTrailingReminder(adapter.sentMessages[1]);
});
