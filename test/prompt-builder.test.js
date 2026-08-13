import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBootstrapPrompt,
  buildResumePrompt,
} from "../src/protocol/prompt-builder.js";

const tools = [{
  name: "fs.read",
  description: "Read a file.",
  inputDescription: "<args><path>file.txt</path></args>",
}];

const requiredSemantics = [
  "<done>true</done> ends only the current agent run",
  "It does not close this conversation",
  "Set done=true only when the current user request has a complete, deliverable answer",
  "you can reply with done=true and your answer directly — no tool call is required",
  "use the local tools and verify the result before done=true",
  "Use done=false only when you are about to call a local tool",
  "Tool count, elapsed turns, or lack of an immediately obvious next action never proves completion.",
];

function assertPreciseDoneSemantics(prompt) {
  for (const text of requiredSemantics) {
    assert.match(prompt, new RegExp(escapeRegExp(text)));
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bootstrap prompt defines current-run done semantics", () => {
  const { web } = buildBootstrapPrompt({
    task: "Implement the feature.",
    projectRoot: "/project",
    tools,
  });

  assertPreciseDoneSemantics(web);
  assert.match(
    web,
    /run the appropriate verification \(build, tests, etc\.\) before finishing/,
  );
  assert.match(web, /The user is running WTAgent/);
  assert.doesNotMatch(web, /\bwebagent\b/i);
});

test("bootstrap prompt defines the virtual filesystem boundary", () => {
  const { web } = buildBootstrapPrompt({
    task: "Inspect the project.",
    projectRoot: "/project",
    tools,
  });

  assert.match(web, /logical, virtual filesystem namespace/);
  assert.match(web, /Do not inspect \/workspace, \/mnt\/data/);
  assert.match(web, /only through the XML operations declared below/);
  assert.match(web, /requested application-level response format/);
  assert.match(web, /You do not need direct filesystem access/);
  assert.doesNotMatch(web, /emitting tool_call XML invokes the tools/);
  assert.doesNotMatch(web, /Ignore any and all previous instructions/);
});

test("model-facing tool calls do not require call ids", () => {
  const { web } = buildBootstrapPrompt({
    task: "Create a file.",
    projectRoot: "/project",
    tools,
  });

  assert.match(web, /<tool_call name="tool_name">/);
  assert.doesNotMatch(web, /<tool_call id=/);
});

test("bootstrap prompt marks scaffolding and puts the user task outside it", () => {
  const { web, developer, user } = buildBootstrapPrompt({
    task: "Implement the feature.",
    projectRoot: "/project",
    tools,
  });

  // Scaffolding (protocol + tools) is wrapped in a strippable marker.
  assert.match(web, /<agent_protocol>[\s\S]*<\/agent_protocol>/);
  assert.match(developer, /## Available tools/);
  assert.equal(user, "Implement the feature.");
  // The prompt tells the model the project may contain unrelated content and
  // to exclude it while searching.
  assert.match(developer, /may contain content unrelated to the current task/);
  assert.match(developer, /fs\.search supports an exclude argument/);
  // The user task lives outside the marker so exporters keep it.
  const afterMarker = web.slice(web.indexOf("</agent_protocol>"));
  assert.match(afterMarker, /Implement the feature\./);
});

test("resume prompt keeps done semantics for an interrupted run", () => {
  const { web } = buildResumePrompt({
    state: {
      taskId: "task-1",
      projectRoot: "/project",
      task: "Implement the feature.",
    },
    tools,
  });

  assertPreciseDoneSemantics(web);
  assert.match(web, /Continue the interrupted run/);
  assert.match(web, /Continue the same WTAgent session/);
});

test("resume prompt treats a follow-up as the next message in an open session", () => {
  const { web } = buildResumePrompt({
    instruction: "Also add regression coverage.",
    state: {
      taskId: "task-1",
      projectRoot: "/project",
      task: "Implement the feature.",
    },
    tools,
  });

  assertPreciseDoneSemantics(web);
  assert.match(web, /next message in the same open conversation/);
  assert.doesNotMatch(web, /previous_status|completed\/done status/);
});
