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
