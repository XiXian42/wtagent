import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { discoverChromeExecutable } from "../src/platform/chrome-discovery.js";
import { GeminiWebAdapter } from "../src/browser/gemini-web-adapter.js";
import { GrokWebAdapter } from "../src/browser/grok-web-adapter.js";
import { renderedMessageContainsOutboundMarker } from "../src/browser/base-web-adapter.js";
import { parseAgentResponse } from "../src/protocol/xml-protocol.js";
import { GeminiImageDriver } from "../src/image/providers/gemini-image-driver.js";
import { NativeMusicReceiver } from "../src/audio/native-music-receiver.js";

test("real Gemini music DOM waits for completion and ignores media from old replies", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>model-response, message-content {display:block}</style>
    <model-response><message-content id="message-content-id-old"><div class="markdown">Old track</div></message-content>
      <video preload="none" src="data:video/mp4;base64,AA=="></video><button aria-label="Redo">Redo</button></model-response>
    <model-response id="new"><message-content id="message-content-id-new"><div class="markdown">Your music</div></message-content>
      <video preload="none" src="data:video/mp4;base64,AQ=="></video></model-response>
  `);
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  adapter.page = page;
  adapter.assistantIdsBeforeSend = new Set(["message-content-id-old"]);
  const receiver = new NativeMusicReceiver({ adapter });
  let settled = false;
  const pending = adapter.waitForTurnComplete({ timeoutMs: 10_000, stableWindowMs: 0,
    readNativeMusic: (message) => receiver.read(message),
  }).then((result) => { settled = true; return result; });
  await page.waitForTimeout(2_100);
  assert.equal(settled, false, "a mounted music player is not proof of a finished reply");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Redo"); button.textContent = "Redo";
    document.querySelector("#new").append(button);
  });
  const result = await pending;
  assert.deepEqual(result.nativeMusic, [{ source: "data:video/mp4;base64,AQ==" }]);
  assert.equal(result.text, "Your music");
  assert.equal(await adapter.getLastAssistantMessageId(), "message-content-id-new");
});

// Opt-in because the ordinary unit suite must also run without installed Chrome.
// WTAGENT_DOM_TESTS=1 node --test test/rendered-text.test.js
test("real DOM preserves provider text, code, and completion boundaries", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: discoverChromeExecutable(), headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const content = 'const tag = "</agent_response>";\n\n  keepIndent();';
  const xml = '<agent_response><done>false</done><tool_call name="fs.write"><args>'
    + '<path>file.js</path><content><![CDATA[' + content
    + ']]></content></args></tool_call></agent_response>';
  const nonce = "11111111-1111-4111-8111-111111111111";
  const marker = '<system_reminder>Opaque WTAgent transport correlation ID '
    + `(do not repeat): ${nonce}.</system_reminder>`;
  await page.setContent(`
    <style>model-response, message-content { display: block; }</style>
    <model-response><message-content>
      <div class="markdown"><p>First paragraph</p><p>Second paragraph</p>
        <span hidden>HIDDEN_CORRUPTION</span>
        <div class="markdown">Nested visible text</div>
      </div>
      <div class="markdown"><pre><code>${escape(xml)}</code></pre></div>
      <div class="markdown" style="display:none">HIDDEN_WHOLE_BLOCK</div>
      <span>OUTSIDE_ATTACHMENT_CHIP</span>
    </message-content><button aria-label="Copy">Copy code</button></model-response>
    <article id="grok-user"><div class="response-content-markdown">
      <p>User text</p><pre><code>${escape(marker)}</code></pre>
    </div></article>
  `);
  const gemini = new GeminiWebAdapter({ profileDir: "." });
  gemini.page = page;
  const model = page.locator("model-response");
  const extracted = await gemini.assistantText(model);
  assert.match(extracted, /First paragraph\n\nSecond paragraph/);
  assert.equal(extracted.split("Nested visible text").length - 1, 1);
  assert.doesNotMatch(extracted, /HIDDEN_|OUTSIDE_ATTACHMENT/);
  assert.equal(parseAgentResponse(extracted).toolCall.args.content, content);
  assert.equal(await gemini.isAssistantGenerating(model), true,
    "a code Copy control is not a finished response");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.testId = "regenerate-button";
    button.textContent = "Regenerate";
    document.querySelector("model-response").append(button);
  });
  assert.equal(await gemini.isAssistantGenerating(model), false);

  const grok = new GrokWebAdapter({ profileDir: "." });
  grok.page = page;
  const userText = await grok.userMessageText(page.locator("#grok-user"));
  assert.equal(renderedMessageContainsOutboundMarker(userText, nonce), true);
  await page.evaluate(() => {
    document.querySelector("#grok-user").innerHTML = '<div class="response-content-markdown"></div><span>Fallback text</span>';
  });
  assert.equal(await grok.userMessageText(page.locator("#grok-user")), "Fallback text");
});

test("real Gemini DOM returns a completed image refusal, but waits during generation", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const refusal = "I can help with images of people, but I can't depict some public figures. Is there anyone else you'd like to try?";
  await page.setContent(`
    <style>model-response, message-content { display:block }</style>
    <model-response><message-content id="message-content-id-old"><div class="markdown">Previous reply</div></message-content></model-response>
    <model-response id="latest"><message-content id="message-content-id-current"><div class="markdown"><p>${refusal}</p></div></message-content>
      <button aria-label="Copy">Copy</button>
    </model-response>
  `);
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  adapter.page = page;
  adapter.assistantIdsBeforeSend = new Set(["message-content-id-old"]);
  const driver = new GeminiImageDriver({ provider: "gemini", adapter });
  const state = {};
  assert.equal(await driver.completedTextResponse(state), null, "no completion controls yet");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.testId = "regenerate-button";
    button.textContent = "Regenerate";
    document.querySelector("#latest").append(button);
  });
  const result = await driver.waitForGeneratedImage(10_000);
  assert.equal(result.type, "text");
  assert.equal(result.text, refusal);
  assert.equal(result.provenance.assistantMessageId, "message-content-id-current");
});

test("real Gemini main turn receives multiple native images and waits for completion", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const { NativeImageReceiver } = await import("../src/image/native-image-receiver.js");
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>model-response,message-content { display:block }</style>
    <model-response id="old"><message-content id="message-content-id-old"></message-content><button data-test-id="regenerate-button">Redo</button></model-response>
    <model-response id="new"><message-content id="message-content-id-new"><div class="markdown">Caption</div></message-content></model-response>`);
  await page.evaluate(async () => {
    for (const [root, color] of [["old", "black"], ["new", "blue"], ["new", "red"]]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 256, 256);
      const image = new Image();
      image.src = canvas.toDataURL();
      document.querySelector(`#${root} message-content`).append(image);
      await image.decode();
    }
  });
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  adapter.page = page;
  adapter.assistantIdsBeforeSend = new Set(["message-content-id-old"]);
  const receiver = new NativeImageReceiver({ provider: "gemini", adapter });
  let settled = false;
  const waiting = adapter.waitForTurnComplete({
    timeoutMs: 10_000, stableWindowMs: 0, emptyResponseWindowMs: 20,
    readNativeImages: (message) => receiver.read(message),
  }).then((result) => { settled = true; return result; });
  await page.waitForTimeout(2_100);
  assert.equal(settled, false, "images are not complete until response controls appear");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.testId = "regenerate-button";
    button.textContent = "Redo";
    document.querySelector("#new").append(button);
  });
  const result = await waiting;
  assert.equal(result.nativeImages.length, 2, "old reply image is excluded");
  assert.equal(result.text, "Caption");
  assert.equal(await adapter.getLastAssistantMessageId(), "message-content-id-new");
});

test("modern ChatGPT downloads only the completed turn's images to verified local paths", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const { ChatGPTWebAdapter } = await import("../src/browser/chatgpt-web-adapter.js");
  const { NativeImageReceiver } = await import("../src/image/native-image-receiver.js");
  const { inspectImageBuffer } = await import("../src/artifacts/artifact-store.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-chatgpt-images-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main>
    <section id="old" data-chatgpt-search-unit-key="fallback-turn-0:3:assistant" data-chatgpt-search-message-ids="old-assistant"></section>
    <section data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="current-user">Draw two images</section>
    <section id="current" data-chatgpt-search-unit-key="fallback-turn-1:3:assistant" data-chatgpt-search-message-ids="current-assistant"></section>
    <button data-testid="stop-button">Stop</button></main>`);
  await page.evaluate(async () => {
    for (const [root, color, size] of [["old", "black", 256], ["current", "blue", 256], ["current", "red", 256], ["current", "green", 32]]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, size, size);
      const image = new Image();
      image.src = canvas.toDataURL();
      document.getElementById(root).append(image);
      await image.decode();
    }
    document.getElementById("current").append(document.querySelector("#current img").cloneNode());
  });
  const adapter = new ChatGPTWebAdapter({ profileDir: path.join(projectRoot, "profile") });
  adapter.page = page;
  adapter.assistantIdsBeforeSend = new Set(["old-assistant"]);
  adapter.sentUserTurn = 3;
  const receiver = new NativeImageReceiver({ provider: "chatgpt", adapter });
  let settled = false;
  const waiting = adapter.waitForTurnComplete({ timeoutMs: 10000, stableWindowMs: 0,
    readNativeImages: (message) => receiver.read(message),
  }).then((result) => { settled = true; return result; });
  await page.waitForTimeout(2100);
  assert.equal(settled, false, "visible stop control keeps images pending");
  await page.locator('[data-testid="stop-button"]').evaluate((element) => element.remove());
  const result = await waiting;
  assert.equal(result.nativeImages.length, 2, "old images, icons and duplicate sources are excluded");
  const artifacts = await receiver.save(result.nativeImages, {
    projectRoot, handoffId: "modern-chatgpt-regression", assistantMessageId: "current-assistant",
  });
  assert.equal(artifacts.length, 2);
  for (const artifact of artifacts) {
    assert.ok(artifact.localPath.startsWith(path.join(await fs.realpath(projectRoot), "artifacts/native-images") + path.sep));
    const inspected = inspectImageBuffer(await fs.readFile(artifact.localPath));
    assert.equal(inspected.mimeType, "image/png");
    assert.equal(inspected.width, 256);
    assert.equal(inspected.height, 256);
    assert.equal(inspected.sha256, artifact.sha256);
    assert.equal(artifact.provenance.assistantMessageId, "current-assistant");
  }
  assert.notEqual(artifacts[0].sha256, artifacts[1].sha256);
});
