#!/usr/bin/env node
// Scripted offline AI replies; production runtime and real local tools.
// Only an owned temporary fixture is modified. No browser account is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { AgentSession } from "../src/session/agent-session.js";
const jsonOnly = process.argv.includes("--json");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--json");
if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(", ")}`);
const responseTag = ["agent", "response"].join("_");
const xml = (value) => String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const task = "Fix slugify so repeated spaces become one hyphen. Run the tests.";
const beforeLine = '  return value.trim().toLowerCase().replace(" ", "-");';
const afterLine = '  return value.trim().toLowerCase().replace(/\\s+/g, "-");';
const source = (line) => `export function slugify(value) {\n${line}\n}\n`;
const testSource = `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./src/slugify.js";
test("lowercases words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});
test("collapses repeated spaces", () => {
  assert.equal(slugify("Hello   World"), "hello-world");
});
test("trims the input", () => {
  assert.equal(slugify("  Hello World  "), "hello-world");
});
`;
const steps = [
  { name: "fs.read", label: "Read src/slugify.js" },
  { name: "terminal.exec", label: "Reproduce the failing test" },
  { name: "fs.edit", label: "Normalize repeated whitespace" },
  { name: "terminal.exec", label: "Rerun all three tests" },
  { name: "fs.read", label: "Read back the modified file" },
];
function toolReply(message, name, args) {
  return `<${responseTag}><done>false</done><message>${xml(message)}</message>` +
    `<tool_call name="${name}"><args>${args}</args></tool_call></${responseTag}>`;
}
const command = `<program>${xml(process.execPath)}</program>` +
  "<argv><item>--test</item><item>--test-reporter=tap</item><item>slugify.test.js</item></argv>" +
  "<cwd>.</cwd><timeout_ms>30000</timeout_ms>";
const responses = [
  toolReply("I will inspect slugify.", "fs.read", "<path>src/slugify.js</path>"),
  toolReply("I will reproduce the failing test.", "terminal.exec", command),
  toolReply("I will normalize consecutive whitespace.", "fs.edit",
    "<path>src/slugify.js</path><edits><item>" +
    `<old_text>${xml(beforeLine)}</old_text><new_text>${xml(afterLine)}</new_text>` +
    "<replace_all>false</replace_all></item></edits>"),
  toolReply("I will rerun the same tests.", "terminal.exec", command),
  toolReply("I will read back the modified source.", "fs.read", "<path>src/slugify.js</path>"),
  `<${responseTag}><done>true</done><message>` +
    "Fixed slugify. All three tests pass; the modified source was read back." +
    `</message></${responseTag}>`,
];
function runTests(projectRoot) {
  let output, exitCode;
  try {
    output = execFileSync(process.execPath,
      ["--test", "--test-reporter=tap", "slugify.test.js"], {
        cwd: projectRoot, encoding: "utf8", timeout: 30000,
        maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
    exitCode = 0;
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error;
    output = String(error.stdout ?? "");
    exitCode = error.status;
  }
  const passed = Number(output.match(/^# pass (\d+)\s*$/m)?.[1]);
  const failed = Number(output.match(/^# fail (\d+)\s*$/m)?.[1]);
  assert.ok(Number.isInteger(passed) && Number.isInteger(failed), "Missing TAP totals");
  return { exitCode, passed, failed };
}
class DemoProviderAdapter extends FakeWebModelAdapter {
  constructor() {
    super(responses);
    this.providerName = "Offline scripted fixture";
  }
}
async function executeRuntime(projectRoot, sessionsDir) {
  const adapter = new DemoProviderAdapter();
  const completed = [];
  try {
    const session = await AgentSession.create({
      sessionsDir, task, projectRoot, mode: null, provider: "chatgpt",
    });
    const runtime = new AgentRuntime({
      adapter, registry: createDefaultToolRegistry(), policy: new PolicyEngine(), session,
      approval: async () => {
        throw new Error("Unexpected approval request; nothing was approved.");
      },
      onEvent: async (event) => {
        if (event.type === "tool.completed") completed.push(event);
      },
    });
    await runtime.run();
    return completed.length;
  } finally {
    await adapter.close();
  }
}
const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-site-demo-"));
const projectRoot = path.join(base, "demo-project");
try {
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), '{"private":true,"type":"module"}\n');
  await fs.writeFile(path.join(projectRoot, "src/slugify.js"), source(beforeLine));
  await fs.writeFile(path.join(projectRoot, "slugify.test.js"), testSource);
  const baseline = runTests(projectRoot);
  assert.deepEqual(baseline, { exitCode: 1, passed: 2, failed: 1 });
  const count = await executeRuntime(projectRoot, path.join(base, "sessions"));
  assert.equal(count, steps.length, "Expected five completed runtime tool calls");
  assert.equal(await fs.readFile(path.join(projectRoot, "src/slugify.js"), "utf8"), source(afterLine));
  assert.equal(await fs.readFile(path.join(projectRoot, "slugify.test.js"), "utf8"), testSource);
  const verified = runTests(projectRoot);
  assert.deepEqual(verified, { exitCode: 0, passed: 3, failed: 0 });
  const report = {
    schemaVersion: 1, kind: "offline-scripted-runtime-demo",
    liveProvider: false, actualLocalTools: true, task, baseline, verified,
    runtimeToolCompletions: count, steps,
    source: { path: "src/slugify.js", before: source(beforeLine), after: source(afterLine) },
    disclosure: "Offline scripted AI replies; real local tools. Not an online recording or speed benchmark.",
  };
  console.log(jsonOnly ? JSON.stringify(report) : [
    "WTAgent — SCRIPTED OFFLINE REPLIES / REAL LOCAL TOOLS", task,
    "Before: 2 passed, 1 failed. After: 3 passed, 0 failed.",
    "Verified: five runtime tool calls, exact source edit, unchanged tests.",
  ].join("\n"));
} finally {
  await fs.rm(base, { recursive: true, force: true });
}
