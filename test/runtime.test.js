import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { TaskSession } from "../src/session/task-session.js";
import { DEFAULT_LIMITS } from "../src/shared/limits.js";
import { BrowserAdapterError } from "../src/shared/errors.js";

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

test("current mode skips ChatGPT mode selection entirely", async (t) => {
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
    task: "Use the current ChatGPT setting",
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

  assert.equal(result.message, "Used current mode.");
  assert.equal(
    events.some((event) => event.type === "conversation.mode_selected"),
    false,
  );
  const started = events.find((event) => event.type === "conversation.started");
  assert.equal(started.payload.mode, null);
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

test("conversation.started reports the actual mode, not the requested one", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Adapter that cannot select Pro (limited, no known fallback label).
  const adapter = new FakeWebModelAdapter([
    `<agent_response><done>true</done><message>Done on the current mode.</message></agent_response>`,
  ]);
  adapter.selectMode = async () => ({
    status: "unavailable_disabled",
    requested: "Pro",
    selectedLabel: null,
    attempts: 1,
    reason: "Pro is limited.",
  });

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
  // Actual mode is unknown (not "Pro"), so it must not falsely claim Pro.
  assert.equal(started.payload.mode, null);
  assert.equal(started.payload.requestedMode, "Pro");
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
  assert.equal(resumedStarted.payload.mode, null);
  assert.equal(resumedStarted.payload.requestedMode, "Pro");
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
      <done>false</done>
      <tool_call name="fs.write">
        <args><content>once</content><path>send-crash.txt</path></args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>true</done>
      <message>Recovered without replaying the write.</message>
    </agent_response>`,
  ]);
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
      <message>Recovered after resending the pending result.</message>
    </agent_response>`,
  ]);
  const recoveryRuntime = new AgentRuntime({
    adapter: recoveryAdapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session: recovered,
    approval: async () => false,
  });

  await recoveryRuntime.run({ resume: true });

  assert.match(recoveryAdapter.sentMessages[0], /<tool_result name="fs\.write"/);
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
    this.reconnectCalls = 0;
    this.restoreCalls = [];
  }

  async sendMessage(text, options = {}) {
    this.sendCalls += 1;
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
  assert.equal(adapter.reconnectCalls, 1);
  assert.ok(
    adapter.restoreCalls.some((url) => url?.includes("chatgpt.com")),
    "the conversation was restored after reconnecting",
  );
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
  adapter.waitForTurnComplete = async () => {
    throw new Error("Connection closed");
  };
  adapter.reconnect = async () => {
    reconnectCalls += 1;
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

test("resume applies an explicit mode and keeps the current mode otherwise", async (t) => {
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

  // Resume with an explicit mode override selects it.
  await runtime.run({ resume: true, mode: "Pro" });
  assert.equal(adapter.mode, "Pro");

  // A plain resume does not re-select anything.
  await runtime.run({ resume: true });
  assert.equal(adapter.mode, "Pro");
});

test("retries a send that ChatGPT never rendered", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-runtime-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter([
    "<agent_response><done>true</done><message>Done after resend.</message></agent_response>",
  ]);
  let sendCalls = 0;
  const originalSend = adapter.sendMessage.bind(adapter);
  adapter.sendMessage = async (text, options = {}) => {
    sendCalls += 1;
    if (sendCalls === 1) {
      throw new BrowserAdapterError(
        "ChatGPT did not render the sent message; the send may have failed.",
        { code: "SEND_NOT_DETECTED" },
      );
    }
    return await originalSend(text, options);
  };
  const session = await TaskSession.create({
    tasksDir,
    task: "Resend after a silent send failure",
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

  assert.equal(result.message, "Done after resend.");
  assert.equal(sendCalls, 2);
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
});
