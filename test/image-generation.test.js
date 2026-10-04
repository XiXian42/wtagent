import { registerImageTools } from "../src/tools/image-tools.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectImageBuffer, ArtifactStore } from "../src/artifacts/artifact-store.js";
import { ImageGenerationService } from "../src/image/image-generation-service.js";
import { BrowserImageDriver } from "../src/image/browser-image-driver.js";
import { BrowserImageSessionPool } from "../src/image/browser-image-session-pool.js";
import {
  ChatGPTImageDriver,
  preferredImageUrl,
} from "../src/image/providers/chatgpt-image-driver.js";
import { GeminiImageDriver } from "../src/image/providers/gemini-image-driver.js";
import {
  GrokImageDriver,
  parseGrokGeneratedImageUrl,
} from "../src/image/providers/grok-image-driver.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { z } from "zod";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const IMAGE_REFUSAL = "I can help with images of people, but I can't depict some public figures. Is there anyone else you'd like to try?";

function textReplyAdapter(t) {
  const state = { id: "new-reply", text: IMAGE_REFUSAL, generating: false, stop: false, images: [] };
  const message = {
    count: async () => 1,
    locator: () => ({ evaluateAll: async (fn) => fn(state.images) }),
  };
  const adapter = {
    page: { waitForTimeout: async (ms) => t.mock.timers.tick(ms) },
    assistantMessages: () => ({ count: async () => 1, last: () => message }),
    messageIdentity: async () => ({ id: state.id, turn: null }),
    assistantText: async () => state.text,
    isNewAssistantIdentity: ({ id }) => id !== "old-reply",
    isAssistantGenerating: async () => state.generating,
    stopButtonLocators: () => [{ first: () => ({ isVisible: async () => state.stop }) }],
    hasReliableCompletionSignal: () => true,
    truncatedEnvelopeGraceMs: () => 90_000,
  };
  return { adapter, state };
}

for (const [provider, Driver] of [["gemini", GeminiImageDriver], ["chatgpt", ChatGPTImageDriver], ["grok", GrokImageDriver]]) {
  test(`${provider} image wait returns a completed text reply before the image timeout`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
    const { adapter } = textReplyAdapter(t);
    const driver = new Driver({ provider, adapter });
    driver.generatedImages = async () => [];
    driver.currentAssistantImages = async () => [];
    const result = provider === "chatgpt"
      ? await driver.waitForChatImage(600_000)
      : await driver.waitForGeneratedImage(600_000, ...(provider === "grok"
        ? [{ images: () => [], lastAddedAt: () => 0 }] : []));
    assert.equal(result.type, "text");
    assert.equal(result.text, IMAGE_REFUSAL);
    assert.equal(result.provenance.assistantMessageId, "new-reply");
    assert.ok(Date.now() < 10_000);
  });
}

test("text completion excludes old replies, streaming, stop controls, and pending images", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { adapter, state } = textReplyAdapter(t);
  const driver = new BrowserImageDriver({ provider: "gemini", adapter });
  const poll = {};
  for (const override of [
    { id: "old-reply" }, { generating: true }, { stop: true },
    { images: [{ complete: false }] },
    { images: [{ complete: true, naturalWidth: 512, naturalHeight: 512 }] },
  ]) {
    Object.assign(state, { id: "new-reply", generating: false, stop: false, images: [] }, override);
    assert.equal(await driver.completedTextResponse(poll), null);
    t.mock.timers.tick(100_000);
    assert.equal(await driver.completedTextResponse(poll), null);
  }
  state.images = [];
  state.text = "Which aspect ratio would you like?";
  assert.equal(await driver.completedTextResponse(poll), null);
  t.mock.timers.tick(1_000);
  state.text += " Please choose one.";
  assert.equal(await driver.completedTextResponse(poll), null);
  t.mock.timers.tick(1_000);
  assert.equal(await driver.completedTextResponse(poll), null);
  t.mock.timers.tick(1_000);
  assert.equal((await driver.completedTextResponse(poll)).text, state.text);
});

test("an image arriving after introductory text takes precedence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { adapter, state } = textReplyAdapter(t);
  state.text = "Here is your image.";
  const driver = new GeminiImageDriver({ provider: "gemini", adapter });
  driver.generatedImages = async () => Date.now() < 2_000 ? [] : [{ source: "new.png" }];
  const result = await driver.waitForGeneratedImage(600_000);
  assert.equal(result.source, "new.png");
  assert.notEqual(result.type, "text");
});

test("providers without a reliable completion signal require a longer stable text window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { adapter } = textReplyAdapter(t);
  adapter.hasReliableCompletionSignal = () => false;
  const driver = new BrowserImageDriver({ provider: "chatgpt", adapter });
  const state = {};
  assert.equal(await driver.completedTextResponse(state), null);
  t.mock.timers.tick(10_000);
  assert.equal(await driver.completedTextResponse(state), null);
  t.mock.timers.tick(80_000);
  assert.equal((await driver.completedTextResponse(state)).type, "text");
});

test("image.generate returns provider text without creating or replacing an image", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-text-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "existing.png"), PNG_1X1);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { adapter } = textReplyAdapter(t);
  let sends = 0;
  let captures = 0;
  adapter.sendMessage = async () => { sends += 1; return {}; };
  adapter.captureAuxiliaryTurnCompletion = async () => { captures += 1; return {}; };
  const driver = new GeminiImageDriver({ provider: "gemini", adapter });
  driver.ensureChatPage = async () => {};
  driver.generatedImages = async () => [];
  driver.downloadGeneratedImage = async () => { assert.fail("text must not be downloaded as an image"); };
  const imageService = new ImageGenerationService({ drivers: { gemini: driver } });
  const registry = createDefaultToolRegistry();
  registerImageTools(registry, { imageService });
  for (const output_path of ["missing.png", "existing.png"]) {
    const result = await registry.execute(registry.validate({
      id: output_path, name: "image.generate", args: { prompt: "test", output_path },
    }), toolContext(root));
    assert.equal(result.ok, false);
    assert.equal(result.meta.code, "IMAGE_TEXT_RESPONSE");
    assert.equal(result.meta.completionUnknown, false);
    assert.equal(result.data.response.text, IMAGE_REFUSAL);
    assert.equal(result.data.artifact, undefined);
  }
  assert.equal(sends, 2);
  assert.equal(captures, 2);
  assert.deepEqual(await fs.readdir(root), ["existing.png"]);
  assert.deepEqual(await fs.readFile(path.join(root, "existing.png")), PNG_1X1);
});

function toolContext(projectRoot) {
  return { projectRoot, allowOutside: false, toolTimeoutMs: 1_000 };
}

test("inspectImageBuffer validates and describes PNG artifacts", () => {
  const image = inspectImageBuffer(PNG_1X1);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.equal(image.size, PNG_1X1.length);
  assert.match(image.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => inspectImageBuffer(Buffer.from("not an image")), /not a supported/);
});

test("ArtifactStore atomically saves a verified local artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-artifact-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.png");
  await fs.writeFile(source, PNG_1X1);

  const artifact = await new ArtifactStore({ projectRoot: root })
    .saveImage(source, "images/result.png", {
      provider: "chatgpt",
      providerFileId: "file_test",
    });

  assert.deepEqual(await fs.readFile(path.join(root, "images/result.png")), PNG_1X1);
  assert.equal(artifact.type, "image");
  assert.equal(artifact.mimeType, "image/png");
  assert.equal(artifact.width, 1);
  assert.equal(artifact.height, 1);
  assert.equal(artifact.provenance.provider, "chatgpt");
});

test("ArtifactStore rejects an extension that disagrees with image bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-artifact-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.png");
  await fs.writeFile(source, PNG_1X1);
  await assert.rejects(
    new ArtifactStore({ projectRoot: root }).saveImage(source, "result.jpg"),
    /does not match/,
  );
  await assert.rejects(fs.stat(path.join(root, "result.jpg")), /ENOENT/);
});

test("browser downloads are isolated in a temporary directory", async (t) => {
  let savedAs = null;
  const driver = new BrowserImageDriver({
    provider: "test",
    adapter: {},
  });
  const result = await driver.saveDownload({
    waitForEvent: async () => ({
      suggestedFilename: () => "../../generated.png",
      saveAs: async (target) => {
        savedAs = target;
        await fs.writeFile(target, PNG_1X1);
      },
      url: () => "https://example.test/download?id=file_test",
    }),
  }, { click: async () => {} }, 1_000);
  t.after(() => fs.rm(result.temporaryDir, { recursive: true, force: true }));

  assert.equal(path.dirname(savedAs), result.temporaryDir);
  assert.equal(path.basename(savedAs), "generated.png");
  assert.equal(result.suggestedFilename, "generated.png");
});

test("browser image URL downloads are isolated in a temporary directory", async (t) => {
  const driver = new BrowserImageDriver({
    provider: "test",
    adapter: {},
  });
  const result = await driver.saveFromUrl({
    request: {
      get: async () => ({
        ok: () => true,
        body: async () => PNG_1X1,
        headers: () => ({ "content-type": "image/png" }),
      }),
    },
  }, "https://example.test/files/generated", 1_000);
  t.after(() => fs.rm(result.temporaryDir, { recursive: true, force: true }));

  assert.equal(path.basename(result.temporaryPath), "generated-image.png");
  assert.deepEqual(await fs.readFile(result.temporaryPath), PNG_1X1);
  assert.equal(result.downloadUrl, "https://example.test/files/generated");
});

test("secondary image generation uses the adapter's normal chat send path", async () => {
  let completionCaptured = false;
  const driver = new BrowserImageDriver({
    provider: "test",
    adapter: {
      sendMessage: async (text, options) => ({ text, options }),
      getLastSendStatus: () => "confirmed",
      captureAuxiliaryTurnCompletion: async () => {
        completionCaptured = true;
      },
      page: {},
    },
  });
  const result = await driver.performTurn({
      prompt: "test",
      aspectRatio: "16:9",
      referenceImages: [],
      timeoutMs: 1_000,
    }, {}, async ({ sendResult }) => sendResult);

  assert.match(result.text, /Aspect ratio: 16:9/);
  assert.match(result.text, /Opaque WTAgent transport correlation ID/);
  assert.match(result.options.outboundId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.options.files, []);
  assert.equal(result.options.requireAttachments, false);
  assert.equal(completionCaptured, true);
});

test("secondary image generation requires every reference attachment", async () => {
  const driver = new BrowserImageDriver({
    provider: "test",
    adapter: {
      sendMessage: async (_text, options) => options,
      getLastSendStatus: () => "confirmed",
      captureAuxiliaryTurnCompletion: async () => ({}),
      page: {},
    },
  });
  const result = await driver.performTurn({
    prompt: "edit this image",
    aspectRatio: "auto",
    referenceImages: ["reference.png"],
    timeoutMs: 1_000,
  }, {}, async ({ sendResult }) => sendResult);

  assert.equal(result.requireAttachments, true);
});

test("image.generate dispatches to a provider and returns a local artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "provider.png");
  await fs.writeFile(source, PNG_1X1);
  let received = null;
  const driver = {
    provider: "gemini",
    capabilities: () => ({
      generate: true,
      referenceImages: true,
      aspectRatios: ["auto", "16:9"],
    }),
    async generate(request) {
      received = request;
      return {
        sourcePath: source,
        provenance: { provider: "gemini", providerFileId: "remote_1" },
      };
    },
  };
  const service = new ImageGenerationService({
    drivers: { gemini: driver },
    defaultProvider: "gemini",
  });
  const registry = createDefaultToolRegistry();
  registerImageTools(registry, { imageService: service });
  const prepared = registry.validate({
    id: "image-1",
    name: "image.generate",
    args: {
      prompt: "a small test image",
      output_path: "assets/generated.png",
      provider: "auto",
      aspect_ratio: "16:9",
    },
  });
  const result = await registry.execute(prepared, toolContext(root));

  assert.equal(result.ok, true, result.message);
  assert.equal(received.provider, "auto");
  assert.equal(received.aspectRatio, "16:9");
  assert.equal(result.data.artifact.provenance.provider, "gemini");
  assert.equal(
    await fs.realpath(result.data.artifact.localPath),
    await fs.realpath(path.join(root, "assets/generated.png")),
  );
  assert.deepEqual(await fs.readFile(result.data.artifact.localPath), PNG_1X1);
});

test("default catalog never exposes image.generate, even with a legacy service", () => {
  const names = createDefaultToolRegistry({ imageService: {} }).list().map((tool) => tool.name);
  assert.equal(names.includes("image.generate"), false);
});

test("image.generate reports an aspect-ratio fallback in its result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-tool-ratio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "provider.png");
  await fs.writeFile(source, PNG_1X1);
  const service = new ImageGenerationService({
    drivers: {
      chatgpt: {
        provider: "chatgpt",
        capabilities: () => ({
          generate: true,
          referenceImages: true,
          aspectRatios: ["auto", "1:1"],
        }),
        async generate(request) {
          assert.equal(request.aspectRatio, "auto");
          return {
            sourcePath: source,
            provenance: { provider: "chatgpt" },
          };
        },
      },
    },
    defaultProvider: "chatgpt",
  });
  const registry = createDefaultToolRegistry();
  registerImageTools(registry, { imageService: service });
  const result = await registry.execute(registry.validate({
    id: "image-ratio",
    name: "image.generate",
    args: {
      prompt: "a moon base",
      output_path: "moon.png",
      aspect_ratio: "4:3",
    },
  }), toolContext(root));

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /Requested aspect_ratio 4:3/);
  assert.match(result.message, /used auto/);
});

test("image.generate requires approval for output or references outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.png`);
  const policy = new PolicyEngine();
  const decision = await policy.evaluate({
    name: "image.generate",
    args: {
      output_path: outside,
      reference_images: [outside],
    },
  }, { projectRoot: root });

  assert.equal(decision.action, "confirm");
  assert.equal(decision.grants.allowOutside, true);
  assert.equal(decision.reasons.length, 2);
});

test("image.generate does not require confirmation inside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-policy-in-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = new PolicyEngine();
  const decision = await policy.evaluate({
    name: "image.generate",
    args: {
      output_path: "images/moon.png",
      reference_images: [],
    },
  }, { projectRoot: root });

  assert.equal(decision.action, "allow");
  assert.equal(decision.grants.allowOutside, false);
});

test("ImageGenerationService falls back to auto for unsupported aspect ratios", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-aspect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "provider.png");
  await fs.writeFile(source, PNG_1X1);
  let received = null;
  const service = new ImageGenerationService({
    drivers: {
      chatgpt: {
        provider: "chatgpt",
        capabilities: () => ({
          generate: true,
          referenceImages: true,
          aspectRatios: ["auto", "1:1", "3:2", "2:3", "16:9", "9:16"],
        }),
        async generate(request) {
          received = request;
          return {
            sourcePath: source,
            provenance: { provider: "chatgpt", providerFileId: "file_ratio" },
          };
        },
      },
    },
    defaultProvider: "chatgpt",
  });

  const artifact = await service.generate({
    provider: "auto",
    referenceImages: [],
    aspectRatio: "4:3",
    outputPath: "moon.png",
  }, { projectRoot: root, allowOutside: false });

  assert.equal(received.aspectRatio, "auto");
  assert.equal(artifact.provenance.requestedAspectRatio, "4:3");
  assert.equal(artifact.provenance.aspectRatio, "auto");
});

test("ImageGenerationService enforces provider capabilities", async () => {
  const service = new ImageGenerationService({
    drivers: {
      grok: {
        provider: "grok",
        capabilities: () => ({
          generate: true,
          referenceImages: false,
          aspectRatios: ["auto", "1:1"],
        }),
      },
    },
    defaultProvider: "grok",
  });
  await assert.rejects(
    service.generate({
      provider: "auto",
      referenceImages: ["reference.png"],
      aspectRatio: "auto",
    }, {}),
    /does not support reference images/,
  );
});

test("a local artifact failure after provider completion is not replay-safe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-save-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "provider.png");
  await fs.writeFile(source, PNG_1X1);
  let cleaned = false;
  const service = new ImageGenerationService({
    drivers: {
      chatgpt: {
        provider: "chatgpt",
        capabilities: () => ({
          generate: true,
          referenceImages: true,
          aspectRatios: [],
        }),
        async generate() {
          return {
            sourcePath: source,
            provenance: { provider: "chatgpt", providerFileId: "file_test" },
            cleanup: async () => { cleaned = true; },
          };
        },
      },
    },
    defaultProvider: "chatgpt",
  });

  await assert.rejects(
    service.generate({
      provider: "auto",
      referenceImages: [],
      aspectRatio: "auto",
      outputPath: "result.jpg",
    }, { projectRoot: root, allowOutside: false }),
    (error) => {
      assert.equal(error.completionUnknown, true);
      assert.equal(error.meta.provenance.providerFileId, "file_test");
      return true;
    },
  );
  assert.equal(cleaned, true);
});

test("provider failures after submission surface completionUnknown", async () => {
  const registry = new ToolRegistry().register({
    name: "image.generate",
    risk: "write",
    inputSchema: z.object({}),
    execute: async () => {
      const error = new Error("download control disappeared");
      error.completionUnknown = true;
      throw error;
    },
  });
  const result = await registry.execute(registry.validate({
    id: "unknown-image",
    name: "image.generate",
    args: {},
  }), { toolTimeoutMs: 1_000 });

  assert.equal(result.ok, false);
  assert.equal(result.meta.completionUnknown, true);
  assert.equal(result.meta.recoverable, true);
});

test("preferredImageUrl prefers a durable https image over a ChatGPT viewer or blob", () => {
  assert.equal(
    preferredImageUrl({
      source: "blob:https://chatgpt.com/preview",
      href: "https://files.oaiusercontent.com/file-abc?id=file_abc",
    }),
    "https://files.oaiusercontent.com/file-abc?id=file_abc",
  );
  assert.equal(
    preferredImageUrl({
      source: "https://files.oaiusercontent.com/file.png",
      href: "https://chatgpt.com/share/xyz",
    }),
    "https://files.oaiusercontent.com/file.png",
  );
});

test("ChatGPT generate downloads the in-chat image URL without opening Library", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-chatgpt-chat-image-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "generated.png");
  await fs.writeFile(source, PNG_1X1);

  let openedLibrary = false;
  const adapter = {
    baseUrl: "https://chatgpt.com/",
    context: {
      newPage: async () => {
        openedLibrary = true;
        throw new Error("Library page should not open during generate");
      },
    },
    page: {
      bringToFront: async () => {},
      url: () => "https://chatgpt.com/c/current",
      waitForTimeout: async () => {},
      locator: () => ({ waitFor: async () => {} }),
    },
    classifyConversationUrl: () => "restorable",
    composerLocators: () => [{ isVisible: async () => true }],
    sendMessage: async () => ({}),
    getLastSendStatus: () => "confirmed",
    captureAuxiliaryTurnCompletion: async () => ({}),
    assistantMessages: () => ({
      last: () => ({
        count: async () => 0,
      }),
    }),
  };
  const driver = new ChatGPTImageDriver({ provider: "chatgpt", adapter });
  driver.chatImages = async () => [{
    source: "https://files.oaiusercontent.com/moon.png?id=file_moon",
    href: "",
    width: 1024,
    height: 768,
  }];
  driver.waitForChatImage = async () => ({
    source: "https://files.oaiusercontent.com/moon.png?id=file_moon",
    href: "",
    width: 1024,
    height: 768,
  });
  driver.saveFromUrl = async (_page, url) => ({
    temporaryDir: root,
    temporaryPath: source,
    suggestedFilename: "moon.png",
    downloadUrl: url,
  });

  const produced = await driver.generate({
    prompt: "moon base",
    aspectRatio: "auto",
    referenceImages: [],
    timeoutMs: 5_000,
  });

  assert.equal(openedLibrary, false);
  assert.equal(produced.sourcePath, source);
  assert.equal(produced.provenance.providerFileId, "file_moon");
});

test("ChatGPT image discovery is scoped to the latest assistant turn", async () => {
  const historical = { name: "historical" };
  const latest = { name: "latest" };
  const driver = new ChatGPTImageDriver({
    provider: "chatgpt",
    adapter: {
      assistantMessages: () => ({ last: () => latest }),
    },
  });
  driver.imagesFromLocator = async (locator) => {
    assert.equal(locator, latest);
    assert.notEqual(locator, historical);
    return [{ source: "https://files.oaiusercontent.com/current.png" }];
  };

  assert.deepEqual(await driver.currentAssistantImages(), [
    { source: "https://files.oaiusercontent.com/current.png" },
  ]);
});

test("Gemini image discovery is scoped to the latest model response", async () => {
  let selected = null;
  const latestImages = [{
    source: "https://lh3.googleusercontent.com/current.jpg",
    alt: "current",
    width: 1024,
    height: 1024,
  }];
  const latest = {
    count: async () => 1,
    locator: (selector) => {
      selected = selector;
      return { evaluateAll: async () => latestImages };
    },
  };
  const driver = new GeminiImageDriver({
    provider: "gemini",
    adapter: {
      assistantMessages: () => ({ last: () => latest }),
    },
  });

  assert.deepEqual(await driver.generatedImages(), latestImages);
  assert.equal(selected, "img");
});

test("parseGrokGeneratedImageUrl accepts only durable Grok generated assets", () => {
  assert.deepEqual(
    parseGrokGeneratedImageUrl(
      "https://assets.grok.com/users/u1/generated/e0040c7a-ea4a-4ac3-9814-99474f85674e/image.jpg?cache=1",
    ),
    {
      id: "e0040c7a-ea4a-4ac3-9814-99474f85674e",
      key: "https://assets.grok.com/users/u1/generated/e0040c7a-ea4a-4ac3-9814-99474f85674e/image.jpg",
      url: "https://assets.grok.com/users/u1/generated/e0040c7a-ea4a-4ac3-9814-99474f85674e/image.jpg?cache=1",
    },
  );
  assert.equal(
    parseGrokGeneratedImageUrl(
      "https://imagine-public.x.ai/imagine-public/images/e0040c7a-ea4a-4ac3-9814-99474f85674e.jpg",
    ),
    null,
  );
  assert.equal(
    parseGrokGeneratedImageUrl("https://assets.grok.com/users/u1/avatar.jpg"),
    null,
  );
});

test("Grok correlates a result with post-submit network plus prompt-matched conversation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-grok-correlation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const historicalId = "11111111-1111-4111-8111-111111111111";
  const currentId = "22222222-2222-4222-8222-222222222222";
  const ignoredId = "33333333-3333-4333-8333-333333333333";
  const historicalUrl = `https://assets.grok.com/users/u/generated/${historicalId}/image.jpg?cache=1`;
  const currentUrl = `https://assets.grok.com/users/u/generated/${currentId}/image.jpg?cache=1`;
  const ignoredBeforeSubmitUrl = `https://assets.grok.com/users/u/generated/${ignoredId}/image.jpg?cache=1`;
  const listeners = new Set();
  const expectedPrompt = "a cyan circle on a magenta square";
  const emitResponse = (url, contentType = "image/jpeg") => {
    const response = {
      url: () => url,
      ok: () => true,
      headers: () => ({ "content-type": contentType }),
    };
    for (const listener of [...listeners]) listener(response);
  };
  const page = {
    on: (event, listener) => {
      if (event === "response") listeners.add(listener);
    },
    off: (event, listener) => {
      if (event === "response") listeners.delete(listener);
    },
    waitForTimeout: async () => {},
    request: {
      get: async (url) => {
        if (url.includes("/rest/app-chat/conversations")) {
          return {
            ok: () => true,
            json: async () => ({
              conversations: [
                {
                  createTime: new Date().toISOString(),
                  latestAssetMetadata: {
                    assetId: currentId,
                    mimeType: "image/jpeg",
                    isDeleted: false,
                    isModelGenerated: true,
                    key: `users/u/generated/${currentId}/image.jpg`,
                    mediaGenInput: {
                      textToImage: {
                        prompt: new BrowserImageDriver({ provider: "grok", adapter: {} }).promptText({
                          prompt: expectedPrompt, aspectRatio: "auto",
                        }),
                        numOfImages: 2,
                      },
                    },
                  },
                },
              ],
            }),
          };
        }
        assert.equal(url, currentUrl);
        return { ok: () => true, body: async () => PNG_1X1 };
      },
    },
  };
  const adapter = {
    page,
    getLastSendStatus: () => "confirmed",
    captureAuxiliaryTurnCompletion: async () => ({}),
    sendMessage: async () => {
      // This image response happens after the listener is installed but before
      // the submit boundary, so it must never become a candidate.
      emitResponse(ignoredBeforeSubmitUrl);
      // A virtualized historical thumbnail may load just after submit. It is
      // captured, but the current result is first in Grok's result DOM.
      emitResponse(historicalUrl);
      emitResponse("https://imagine-public.x.ai/imagine-public/images/loading.jpg");
      emitResponse(currentUrl);
      return {};
    },
  };
  const driver = new GrokImageDriver({
    provider: "grok",
    adapter,
    responseStabilityMs: 0,
  });
  driver.ensureChatPage = async () => {};
  let assistantImageReads = 0;
  driver.currentAssistantImages = async () => {
    assistantImageReads += 1;
    return assistantImageReads === 1
      ? [{
        source: historicalUrl,
        alt: "Historical image",
        width: 1024,
        height: 1024,
      }]
      : [{
        source: currentUrl,
        alt: "Generated image",
        width: 1024,
        height: 1024,
      }];
  };

  const produced = await driver.generate({
    prompt: expectedPrompt,
    aspectRatio: "auto",
    referenceImages: [],
    timeoutMs: 1_000,
  });
  t.after(() => produced.cleanup());

  assert.equal(produced.provenance.providerFileId, currentId);
  assert.equal(produced.provenance.generatedImageCount, 1);
  assert.equal(produced.provenance.selectedImageIndex, 1);
  assert.deepEqual(await fs.readFile(produced.sourcePath), PNG_1X1);
  assert.equal(listeners.size, 0, "the response listener must be removed");
});

test("Grok deterministically selects the first rendered image from a multi-image reply", async () => {
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const firstUrl = `https://assets.grok.com/users/u/generated/${firstId}/image.jpg?cache=1`;
  const secondUrl = `https://assets.grok.com/users/u/generated/${secondId}/image.jpg?cache=1`;
  const driver = new GrokImageDriver({
    provider: "grok",
    responseStabilityMs: 0,
    adapter: { page: { waitForTimeout: async () => {} } },
  });
  driver.currentAssistantImages = async () => [
    { source: secondUrl, width: 1024, height: 1024 },
    { source: firstUrl, width: 1024, height: 1024 },
  ];
  const tracker = {
    images: () => [
      parseGrokGeneratedImageUrl(firstUrl),
      parseGrokGeneratedImageUrl(secondUrl),
    ],
    lastAddedAt: () => 0,
  };

  const selected = await driver.waitForGeneratedImage(1_000, tracker);
  assert.equal(selected.providerFileId, secondId);
  assert.equal(selected.generatedImageCount, 2);
  assert.equal(selected.selectedImageIndex, 1);
});

test("image sessions reuse the primary chat adapter without creating a page", async () => {
  let factoryCalls = 0;
  const primaryAdapter = { context: {}, page: {} };
  const pool = new BrowserImageSessionPool({
    primaryAdapter,
    primaryProvider: { id: "gemini", label: "Gemini" },
    appDataDir: "/tmp/wtagent-test",
    adapterFactory: () => {
      factoryCalls += 1;
      throw new Error("primary provider must not create another adapter");
    },
  });

  const resource = await pool.adapterFor("gemini");
  assert.equal(resource.adapter, primaryAdapter);
  assert.equal(resource.sharedConversation, true);
  assert.equal(factoryCalls, 0);
});

test("secondary image providers start a fresh normal chat", async () => {
  const calls = [];
  const adapter = {
    ownsWindow: false,
    launch: async () => { calls.push("launch"); },
    getAuthState: async () => "authenticated",
    startConversation: async (url) => { calls.push(["startConversation", url]); },
    close: async () => { calls.push("close"); },
  };
  const pool = new BrowserImageSessionPool({
    primaryAdapter: { context: {}, page: {} },
    primaryProvider: { id: "chatgpt", label: "ChatGPT" },
    appDataDir: "/tmp/wtagent-test",
    adapterFactory: () => adapter,
  });

  const resource = await pool.adapterFor("grok");
  assert.equal(resource.adapter, adapter);
  assert.equal(resource.sharedConversation, false);
  assert.deepEqual(calls, ["launch", ["startConversation", null]]);
  await pool.close();
  assert.deepEqual(calls.at(-1), "close");
});

test("secondary image provider waits through a transient authentication state", async () => {
  const calls = [];
  let checks = 0;
  const adapter = {
    ownsWindow: false,
    launch: async () => { calls.push("launch"); },
    getAuthState: async () => (++checks === 1 ? "unknown" : "authenticated"),
    waitForManualLogin: async (options) => { calls.push(["waitForManualLogin", options.timeoutMs]); },
    startConversation: async (url) => { calls.push(["startConversation", url]); },
    close: async () => { calls.push("close"); },
  };
  const pool = new BrowserImageSessionPool({
    primaryAdapter: { context: {}, page: {} },
    primaryProvider: { id: "chatgpt", label: "ChatGPT" },
    appDataDir: "/tmp/wtagent-test",
    adapterFactory: () => adapter,
  });

  const resource = await pool.adapterFor("gemini");
  assert.equal(resource.adapter, adapter);
  assert.deepEqual(calls, [
    "launch",
    ["waitForManualLogin", 8_000],
    ["startConversation", null],
  ]);
  await pool.close();
});
