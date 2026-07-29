import test from "node:test";
import assert from "node:assert/strict";
import {
  stripSystemMarkers,
  extractMarkedBlocks,
  wrapSystemPrompt,
  wrapSystemReminder,
  SYSTEM_PROMPT_TAG,
} from "../src/protocol/markers.js";
import {
  developerMessage,
  userMessage,
  assistantMessage,
  functionCall,
  functionCallOutput,
  toolResultOutput,
} from "../src/session/canonical-transcript.js";
import {
  toCodexRollout,
  toClaudeCodeSession,
} from "../src/session/session-export.js";
import { buildBootstrapPrompt } from "../src/protocol/prompt-builder.js";

const NOW = "2026-07-29T00:00:00.000Z";

function transcript() {
  const stamp = (item) => ({ timestamp: NOW, item });
  return {
    meta: { sessionId: "task-x", cwd: "/project", createdAt: NOW, task: "Build a site" },
    items: [
      stamp(developerMessage(wrapSystemPrompt("PROTOCOL: emit <agent_response> XML. Tools: fs.write"))),
      stamp(userMessage("Build a site")),
      stamp(assistantMessage("Creating the file.")),
      stamp(functionCall({ name: "fs.write", args: { path: "index.html" }, callId: "call_1" })),
      stamp(functionCallOutput({ callId: "call_1", output: toolResultOutput({ ok: true, message: "Wrote index.html." }) })),
      stamp(assistantMessage("Done.")),
    ],
  };
}

test("strips system markers and normalizes whitespace", () => {
  const text = `${wrapSystemPrompt("scaffold here")}\n\nReal user task.`;
  assert.equal(stripSystemMarkers(text), "Real user task.");
});

test("extracts inner text of marked blocks", () => {
  const text = wrapSystemReminder("remind me") + wrapSystemReminder("again");
  assert.deepEqual(
    extractMarkedBlocks(text, "system_reminder"),
    ["remind me", "again"],
  );
});

test("codex export removes transport scaffold and keeps the body clean", () => {
  const lines = toCodexRollout(transcript(), { now: NOW }).trim().split("\n").map((l) => JSON.parse(l));

  assert.equal(lines[0].type, "session_meta");
  assert.equal(lines[0].payload.base_instructions, null);
  assert.equal(lines[0].payload.originator, "wtagent");
  assert.equal(lines[0].payload.source, "wtagent");
  assert.doesNotMatch(JSON.stringify(lines[0]), /PROTOCOL|agent_response/);

  const body = lines.slice(1);
  // Developer scaffolding is not replayed as a turn.
  assert.equal(body.every((l) => l.payload.role !== "developer"), true);
  // No WTAgent XML/markers leak into the exported body.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /system_prompt|system_reminder|agent_response/);
  // The user turn carries only the real task text.
  const user = body.find((l) => l.payload.role === "user");
  assert.equal(user.payload.content[0].text, "Build a site");
  // Tool calls survive as Responses items.
  assert.equal(body.some((l) => l.payload.type === "function_call"), true);
  assert.equal(body.some((l) => l.payload.type === "function_call_output"), true);
});

test("production bootstrap export never leaks the XML protocol into Codex", () => {
  const prompt = buildBootstrapPrompt({
    task: "Build a site",
    projectRoot: "/project",
    tools: [{
      name: "fs.write",
      description: "Write a file.",
      inputDescription: "<args><path>x</path></args>",
    }],
  });
  const stamp = (item) => ({ timestamp: NOW, item });
  const input = {
    meta: {
      sessionId: "session-production",
      cwd: "/project",
      createdAt: NOW,
    },
    items: [
      stamp(developerMessage(prompt.developer)),
      stamp(userMessage(prompt.user)),
    ],
  };

  const output = toCodexRollout(input, { now: NOW });
  assert.doesNotMatch(
    output,
    /communicate exclusively through XML|XML is the communication protocol|agent_response|tool_call|system_prompt|system_reminder/,
  );
  assert.match(output, /Build a site/);
});

test("claude code export maps tools and links parentUuid", () => {
  const lines = toClaudeCodeSession(transcript(), { sessionId: "sess-1", now: NOW })
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.every((line) => line.version === "wtagent-export"), true);

  // tool_use and tool_result blocks are present.
  const toolUse = lines.find((l) => Array.isArray(l.message?.content)
    && l.message.content[0]?.type === "tool_use");
  assert.equal(toolUse.message.content[0].name, "fs.write");
  assert.equal(toolUse.message.content[0].input.path, "index.html");

  const toolResult = lines.find((l) => Array.isArray(l.message?.content)
    && l.message.content[0]?.type === "tool_result");
  assert.equal(toolResult.message.content[0].tool_use_id, "call_1");

  // No scaffolding leaks.
  assert.doesNotMatch(JSON.stringify(lines), /system_prompt|system_reminder|agent_response/);

  // parentUuid chain is intact.
  let prev = null;
  for (const l of lines) {
    assert.equal(l.parentUuid, prev);
    prev = l.uuid;
  }
});

test("codex export drops a user turn that is only scaffolding", () => {
  const only = {
    meta: { sessionId: "t", cwd: "/p", createdAt: NOW },
    items: [{ timestamp: NOW, item: userMessage(wrapSystemPrompt("only scaffold")) }],
  };
  const lines = toCodexRollout(only, { now: NOW }).trim().split("\n").map((l) => JSON.parse(l));
  // Only session_meta remains; the empty user turn is dropped.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "session_meta");
});

test("exports note @file attachments in both formats", () => {
  const stamp = (item) => ({ timestamp: NOW, item });
  const input = {
    meta: { sessionId: "att", cwd: "/project", createdAt: NOW },
    items: [
      stamp(userMessage("review this", {
        attachments: [{ name: "report.pdf", path: "/project/report.pdf" }],
      })),
    ],
  };

  const codex = toCodexRollout(input, { now: NOW }).trim().split("\n").map((l) => JSON.parse(l));
  const codexUser = codex.find((l) => l.payload?.role === "user");
  assert.match(codexUser.payload.content[0].text, /review this/);
  assert.match(codexUser.payload.content[0].text, /\[attached: report\.pdf\]/);

  const cc = toClaudeCodeSession(input, { sessionId: "att", now: NOW })
    .trim().split("\n").map((l) => JSON.parse(l));
  const ccUser = cc.find((l) => l.type === "user");
  assert.match(ccUser.message.content, /review this/);
  assert.match(ccUser.message.content, /\[attached: report\.pdf\]/);
});
