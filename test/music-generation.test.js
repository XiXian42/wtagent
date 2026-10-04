import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/session/agent-session.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { GeminiWebAdapter } from "../src/browser/gemini-web-adapter.js";
import { NativeMusicReceiver, validateGenerationType } from "../src/audio/native-music-receiver.js";
import { inspectMusicBuffer } from "../src/audio/music-artifact.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function container(handlers = ["soun", "vide"]) {
  const tracks = handlers.map((handler) => {
    const hdlr = Buffer.alloc(12); hdlr.write(handler, 8, "ascii");
    const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(44100, 12); mdhd.writeUInt32BE(44100 * 30, 16);
    return box("trak", box("mdia", box("hdlr", hdlr), box("mdhd", mdhd)));
  });
  return Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", ...tracks), box("mdat", Buffer.from([1, 2, 3, 4]))]);
}
const music = [{ source: "https://contribution.usercontent.google.com/download?filename=track.mp4" }];

test("music bytes retain their real format and must contain a valid audio track", () => {
  assert.equal(inspectMusicBuffer(container()).extension, ".mp4");
  const audio = inspectMusicBuffer(container(["soun"]));
  assert.equal(audio.mimeType, "audio/mp4");
  assert.equal(audio.extension, ".m4a");
  assert.equal(audio.durationSeconds, 30);
  assert.equal(audio.hasVideo, false);
  assert.match(audio.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => inspectMusicBuffer(container(["vide"])), /no valid audio track/);
  assert.throws(() => inspectMusicBuffer(container().subarray(0, -1)), /container/);
  assert.throws(() => inspectMusicBuffer(Buffer.from("<html>Please sign in</html>")), /container/);
});

test("music type is opt-in and limited to Gemini", () => {
  assert.equal(validateGenerationType(undefined, "chatgpt"), "agent");
  assert.equal(validateGenerationType("music", "gemini"), "music");
  assert.throws(() => validateGenerationType("music", "chatgpt"), /requires --model gemini/);
  assert.throws(() => validateGenerationType("video", "gemini"), /Unknown --type/);
});

test("CLI rejects unsupported music providers before browser startup", () => {
  const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--model", "chatgpt", "--type", "music", "--once", "test"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--type music requires --model gemini/);
  assert.doesNotMatch(result.stdout, /Chrome started|Session ID/);
});

async function setup(t, responses = [{ text: "Your track is ready.", nativeMusic: music }]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-music-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project"); await fs.mkdir(projectRoot);
  const session = await AgentSession.create({ sessionsDir: path.join(root, "sessions"), projectRoot,
    task: "Create calm piano music", provider: "gemini", generationType: "music" });
  const adapter = new FakeWebModelAdapter(responses);
  let prepares = 0; let downloads = 0;
  adapter.prepareMusicGeneration = async () => { prepares += 1; };
  adapter.page = { request: { get: async () => {
    downloads += 1;
    return { ok: () => true, body: async () => container() };
  } } };
  const receiver = new NativeMusicReceiver({ adapter, extractAudio: async (_source, output) => {
    await fs.writeFile(output, container(["soun"])); return { ok: true };
  } });
  const runtime = (model = adapter) => new AgentRuntime({ adapter: model, nativeMusicReceiver: receiver,
    session, registry: createDefaultToolRegistry(), policy: new PolicyEngine(), approval: async () => true });
  return { root, projectRoot, session, adapter, receiver, runtime, prepares: () => prepares, downloads: () => downloads };
}

test("music generates once, saves original and audio, and bare resume does not regenerate", async (t) => {
  const state = await setup(t);
  const result = await state.runtime().run();
  assert.equal(result.artifacts.length, 2);
  assert.equal(state.prepares(), 1);
  assert.equal(state.adapter.sentMessages.length, 1);
  assert.match(state.adapter.sentMessages[0], /Create calm piano music/);
  assert.doesNotMatch(state.adapter.sentMessages[0], /<agent_response>|<tool_catalog>/);
  assert.match(result.artifacts[0].localPath, /track-1\.mp4$/);
  assert.match(result.artifacts[1].localPath, /track-1\.m4a$/);
  assert.equal(inspectMusicBuffer(await fs.readFile(result.artifacts[1].localPath)).hasVideo, false);
  assert.equal(state.session.state.pendingAssistantTurn, null);
  assert.equal(state.session.state.generationType, "music");
  const resumed = await state.runtime().run({ resume: true });
  assert.deepEqual(resumed.artifacts, result.artifacts);
  assert.equal(state.adapter.sentMessages.length, 1);
});

test("music download failure resumes the checkpointed response without another prompt", async (t) => {
  const state = await setup(t);
  const save = state.receiver.save.bind(state.receiver);
  state.receiver.save = async () => { throw new Error("download interrupted"); };
  await assert.rejects(state.runtime().run(), /download interrupted/);
  const handoff = structuredClone(state.session.state.pendingAssistantTurn);
  assert.equal(handoff.status, "complete");
  assert.deepEqual(handoff.nativeMusic, music);
  await assert.rejects(state.session.refreshPendingAssistantTurn(handoff.handoffId, { nativeMusic: [] }), /protected/);
  state.receiver.save = save;
  const resumed = new FakeWebModelAdapter([]);
  resumed.reconciliationOutcome = { ...handoff, status: "complete" };
  const result = await state.runtime(resumed).run({ resume: true });
  assert.equal(result.artifacts.length, 2);
  assert.equal(resumed.sentMessages.length, 0);
  assert.equal(state.downloads(), 1);
});

test("music download survives an absent FFmpeg and rejects a sign-in page", async (t) => {
  const state = await setup(t);
  state.receiver.extractAudio = async () => ({ ok: false, message: "FFmpeg is not installed; original saved." });
  const result = await state.runtime().run();
  assert.equal(result.artifacts.length, 1);
  assert.match(result.message, /FFmpeg is not installed/);
  state.adapter.page.request.get = async () => ({ ok: () => true, body: async () => Buffer.from("<html>Login</html>") });
  await assert.rejects(state.receiver.save(music, { projectRoot: state.projectRoot, handoffId: "invalid", assistantMessageId: "a" }), /container/);
});

test("text-only music results return honestly without XML corrections or regeneration", async (t) => {
  const state = await setup(t, ["Music generation is unavailable right now."]);
  const result = await state.runtime().run();
  assert.deepEqual(result.artifacts, []);
  assert.match(result.message, /No music file was generated or saved/);
  assert.equal(state.adapter.sentMessages.length, 1);
  assert.equal(state.downloads(), 0);
});

test("an empty music turn is not automatically retried", async (t) => {
  const error = Object.assign(new Error("empty"), { code: "EMPTY_ASSISTANT_RESPONSE" });
  const state = await setup(t, [error]);
  await assert.rejects(state.runtime().run(), /empty/);
  assert.equal(state.adapter.sentMessages.length, 1);
  assert.equal(state.session.state.pendingAssistantTurn.status, "waiting");
});

test("Gemini music setup accepts the dedicated creation screen", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  let placeholder = "Describe your track";
  let templateClicks = 0;
  const editor = {
    getAttribute: async () => placeholder,
    waitFor: async ({ state }) => assert.equal(state, "visible"),
  };
  const template = {
    isVisible: async () => true,
    click: async () => { templateClicks += 1; placeholder = "What's the background music for?"; },
  };
  adapter.page = {
    getByText: () => ({ isVisible: async () => true }),
    getByRole: () => template,
    locator: () => editor,
  };
  await adapter.prepareMusicGeneration();
  await adapter.prepareMusicGeneration();
  assert.equal(templateClicks, 1);
  assert.equal(adapter.musicGeneration, true);
});

test("Gemini music setup recovers when the tool menu opens the creation screen", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  let creationVisible = false;
  let templateClicks = 0;
  const selected = { isVisible: async () => false };
  const tools = {
    getAttribute: async () => "false",
    press: async () => { creationVisible = true; },
  };
  const template = { isVisible: async () => true, click: async () => { templateClicks += 1; } };
  const editor = { getAttribute: async () => "Describe your track", waitFor: async () => {} };
  adapter.page = {
    getByText: () => ({ isVisible: async () => creationVisible }),
    getByRole: (_role, { name }) => String(name).includes("Deselect") ? selected
      : String(name).includes("Background music") ? template : tools,
    locator: (selector) => selector.includes("menuitemcheckbox")
      ? { waitFor: async () => { throw new Error("old music menu disappeared"); } }
      : editor,
  };
  await adapter.prepareMusicGeneration();
  assert.equal(templateClicks, 1);
  assert.equal(adapter.musicGeneration, true);
});

test("Gemini music setup selects the real tool once and submits using one keyboard action", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  let selected = false; const presses = [];
  const tools = { getAttribute: async () => "false", press: async (key) => presses.push(`tools:${key}`) };
  const musicItem = { waitFor: async () => {}, getAttribute: async () => "false", press: async (key) => { presses.push(`music:${key}`); selected = true; } };
  const chip = { isVisible: async () => selected, waitFor: async () => assert.equal(selected, true) };
  const send = { count: async () => 1, nth() { return this; }, first() { return this; }, isVisible: async () => true, isEnabled: async () => true,
    press: async (key) => presses.push(`send:${key}`) };
  adapter.page = { getByRole: (_role, { name }) => String(name).includes("Deselect") ? chip : tools,
    locator: () => musicItem };
  adapter.sendButtonLocators = () => [send];
  await adapter.prepareMusicGeneration();
  await adapter.prepareMusicGeneration();
  await adapter.submitComposer({}, { assertActive() {}, timeoutMs: 100 });
  assert.deepEqual(presses, ["tools:Space", "music:Space", "send:Space"]);
});
