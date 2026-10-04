import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { TaskSession } from "../src/session/task-session.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { NativeImageReceiver } from "../src/image/native-image-receiver.js";
import { buildBootstrapPrompt, buildResumePrompt } from "../src/protocol/prompt-builder.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const images = [{ source: "https://example.test/one.png", width: 512, height: 512 }, { source: "https://example.test/two.png", width: 512, height: 512 }];
const done = '<agent_response><done>true</done><message>Saved both images.</message></agent_response>';
async function setup(t, responses) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-native-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const session = await TaskSession.create({ sessionsDir: path.join(root, "sessions"), projectRoot, task: "Generate two illustrations", mode: null });
  const adapter = new FakeWebModelAdapter(responses);
  const receiver = new NativeImageReceiver({ provider: "gemini", adapter });
  let downloads = 0;
  receiver.driver.saveFromUrl = async (_page, source) => {
    assert.ok(images.some((image) => image.source === source));
    downloads += 1;
    const temporaryDir = await fs.mkdtemp(path.join(root, "download-"));
    const temporaryPath = path.join(temporaryDir, "image.png");
    await fs.writeFile(temporaryPath, PNG);
    return { temporaryDir, temporaryPath };
  };
  const runtime = (model = adapter) => new AgentRuntime({ adapter: model, nativeImageReceiver: receiver, session,
    registry: createDefaultToolRegistry(), policy: new PolicyEngine(), approval: async () => true });
  return { root, projectRoot, session, adapter, receiver, runtime, downloads: () => downloads };
}

test("native images are saved before their receipt and ordinary file tools continue", async (t) => {
  const state = await setup(t, [{ text: "", nativeImages: images },
    '<agent_response><done>false</done><tool_call name="fs.list"><args><path>artifacts/native-images</path><depth>3</depth></args></tool_call></agent_response>', done]);
  const result = await state.runtime().run();
  assert.equal(result.message, "Saved both images.");
  assert.equal(state.downloads(), 2);
  assert.equal(state.adapter.sentMessages.length, 3, "no auxiliary generation prompt");
  assert.match(state.adapter.sentMessages[1], /native_image_result/);
  assert.match(state.adapter.sentMessages[1], /image-1.png/);
  assert.match(state.adapter.sentMessages[1], /image-2.png/);
  assert.doesNotMatch(state.adapter.sentMessages[1], /https:\/\/example/);
  assert.match(state.adapter.sentMessages[2], /image-2.png/);
  const [dir] = await fs.readdir(path.join(state.projectRoot, "artifacts/native-images"));
  assert.match(dir, /^[0-9a-f]{24}$/);
  assert.deepEqual(await fs.readFile(path.join(state.projectRoot, "artifacts/native-images", dir, "image-1.png")), PNG);
  assert.equal(state.session.state.pendingAssistantTurn, null);
});

for (const failure of ["download", "receipt"]) {
  test(`native ${failure} failure resumes the same reply without generating again`, async (t) => {
    const state = await setup(t, [{ text: "", nativeImages: images }]);
    if (failure === "download") {
      const save = state.receiver.save.bind(state.receiver);
      let fail = true;
      state.receiver.save = async (...args) => {
        if (fail) { fail = false; throw new Error("download interrupted"); }
        return save(...args);
      };
    } else {
      const send = state.adapter.sendMessage.bind(state.adapter);
      state.adapter.sendMessage = async (text, options) => {
        if (text.startsWith("<native_image_result>")) {
          state.adapter.lastSendStatus = "not-submitted";
          throw new Error("receipt interrupted");
        }
        return send(text, options);
      };
    }
    await assert.rejects(state.runtime().run(), /interrupted/);
    const handoff = structuredClone(state.session.state.pendingAssistantTurn);
    assert.equal(handoff.status, "complete");
    assert.deepEqual(handoff.nativeImages, images);
    assert.equal(state.adapter.sentMessages.length, 1);
    await assert.rejects(state.session.refreshPendingAssistantTurn(handoff.handoffId, { nativeImages: [] }), /protected/);
    const resumed = new FakeWebModelAdapter([done]);
    resumed.reconciliationOutcome = { ...handoff, status: "complete" };
    await state.runtime(resumed).run({ resume: true });
    assert.equal(resumed.sentMessages.length, 1, "resume sends saved paths only");
    assert.match(resumed.sentMessages[0], /^<native_image_result>/);
    assert.equal(state.downloads(), 2, "a saved receipt does not download or generate again");
  });
}

test("default prompts expose direct image output as an XML exception", () => {
  const tools = createDefaultToolRegistry({ imageService: {} }).list();
  for (const prompt of [
    buildBootstrapPrompt({ task: "draw", projectRoot: ".", tools, nativeImages: true }),
    buildResumePrompt({ instruction: "draw", state: { sessionId: "s", task: "draw", projectRoot: "." }, tools, nativeImages: true }),
  ]) {
    assert.match(prompt.web, /Image responses are exempt from the XML format/);
    assert.doesNotMatch(prompt.web, /image\.generate/);
  }
});

test("native receiver rejects invalid downloaded bytes", async (t) => {
  const state = await setup(t, []);
  state.receiver.driver.saveFromUrl = async () => {
    const temporaryDir = await fs.mkdtemp(path.join(state.root, "invalid-"));
    const temporaryPath = path.join(temporaryDir, "fake.png");
    await fs.writeFile(temporaryPath, "<html>sign in</html>");
    return { temporaryDir, temporaryPath };
  };
  await assert.rejects(state.receiver.save(images, { projectRoot: state.projectRoot, handoffId: "turn", assistantMessageId: "a" }), /not a supported/);
  assert.deepEqual(await fs.readdir(state.projectRoot), []);
});

test("native reminder is included in the tool-result byte budget", async (t) => {
  const state = await setup(t, []);
  const runtime = state.runtime();
  const message = runtime.buildToolResultMessage({ name: "fs.read", ok: true, message: "Read", data: { content: "中".repeat(50_000) } });
  await runtime.sendMessage(message);
  assert.ok(Buffer.byteLength(state.adapter.sentMessages[0]) <= runtime.limits.maxBrowserToolResultBytes);
});

test("malformed XML with native images enabled still cannot execute a tool", async (t) => {
  const broken = '<agent_response><tool_call name="fs.write"><args><path>bad.txt</path><content>bad</content></args></tool_call>';
  const state = await setup(t, [broken, done]);
  await state.runtime().run();
  assert.match(state.adapter.sentMessages[1], /protocol_error/);
  assert.doesNotMatch(state.adapter.sentMessages[1], /native_image_result type="text"/);
  assert.deepEqual(await fs.readdir(state.projectRoot), []);
});

test("a partial multi-image download resumes the saved reply and stable artifact paths", async (t) => {
  const state = await setup(t, [{ text: "", nativeImages: images }]);
  const download = state.receiver.driver.saveFromUrl.bind(state.receiver.driver);
  let interrupted = false;
  state.receiver.driver.saveFromUrl = async (page, source) => {
    if (!interrupted && source === images[1].source) {
      interrupted = true;
      throw new Error("second image download interrupted");
    }
    return download(page, source);
  };
  await assert.rejects(state.runtime().run(), /second image download interrupted/);
  const handoff = structuredClone(state.session.state.pendingAssistantTurn);
  assert.equal(handoff.status, "complete");
  assert.equal(handoff.nativeArtifacts, undefined);
  const parent = path.join(state.projectRoot, "artifacts/native-images");
  const [directory] = await fs.readdir(parent);
  assert.deepEqual(await fs.readdir(path.join(parent, directory)), ["image-1.png"]);
  const firstBefore = await fs.readFile(path.join(parent, directory, "image-1.png"));
  const resumed = new FakeWebModelAdapter([done]);
  resumed.reconciliationOutcome = { ...handoff, status: "complete" };
  await state.runtime(resumed).run({ resume: true });
  assert.equal(resumed.sentMessages.length, 1);
  assert.match(resumed.sentMessages[0], /^<native_image_result>/);
  assert.deepEqual(await fs.readdir(parent), [directory]);
  assert.deepEqual((await fs.readdir(path.join(parent, directory))).sort(), ["image-1.png", "image-2.png"]);
  assert.deepEqual(await fs.readFile(path.join(parent, directory, "image-1.png")), firstBefore);
  assert.equal(state.session.state.pendingAssistantTurn, null);
});
