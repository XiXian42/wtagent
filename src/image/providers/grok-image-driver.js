import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserImageDriver } from "../browser-image-driver.js";

const GROK_ASSET_HOST = "assets.grok.com";
const GROK_GENERATED_IMAGE_PATH = /^\/users\/[^/]+\/generated\/([0-9a-f-]{16,})\/image\.(?:jpe?g|png|webp)$/i;
const IMAGE_CONTENT_TYPE = /^image\/(?:jpeg|jpg|png|webp)(?:;|$)/i;

export function parseGrokGeneratedImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== GROK_ASSET_HOST) return null;
    const match = url.pathname.match(GROK_GENERATED_IMAGE_PATH);
    if (!match) return null;
    return {
      id: match[1],
      key: `${url.origin}${url.pathname}`,
      url: url.href,
    };
  } catch {
    return null;
  }
}

function responseUrl(response) {
  return typeof response?.url === "function" ? response.url() : response?.url;
}

function responseHeaders(response) {
  return typeof response?.headers === "function" ? response.headers() : response?.headers;
}

export class GrokImageDriver extends BrowserImageDriver {
  constructor(options) {
    super(options);
    this.responseStabilityMs = options.responseStabilityMs ?? 2_000;
  }

  capabilities() {
    return Object.freeze({
      generate: true,
      referenceImages: false,
      aspectRatios: ["auto", "1:1", "3:2", "2:3", "16:9", "9:16"],
      imageCount: 1,
    });
  }

  trackGeneratedImageResponses() {
    const page = this.adapter.page;
    const images = [];
    const keys = new Set();
    let armed = false;
    let lastAddedAt = 0;
    const listener = (response) => {
      if (!armed) return;
      const parsed = parseGrokGeneratedImageUrl(responseUrl(response));
      if (!parsed || keys.has(parsed.key)) return;
      const ok = typeof response?.ok === "function" ? response.ok() : response?.ok;
      const contentType = String(responseHeaders(response)?.["content-type"] ?? "");
      if (!ok || !IMAGE_CONTENT_TYPE.test(contentType)) return;
      keys.add(parsed.key);
      images.push(parsed);
      lastAddedAt = Date.now();
    };
    page.on("response", listener);
    return {
      arm: () => { armed = true; },
      images: () => images.slice(),
      lastAddedAt: () => lastAddedAt,
      stop: () => page.off("response", listener),
    };
  }

  async currentAssistantImages() {
    const response = this.adapter.assistantMessages().last();
    if (await response.count().catch(() => 0) === 0) return [];
    return await response.locator("img").evaluateAll((images) => images.map((image) => ({
      source: image.currentSrc || image.src || "",
      alt: image.alt || "",
      width: image.naturalWidth || 0,
      height: image.naturalHeight || 0,
    })).filter((image) => image.source && image.width >= 256 && image.height >= 256));
  }

  async waitForGeneratedImage(timeoutMs, tracker, baseline = new Set()) {
    const deadline = Date.now() + timeoutMs;
    let candidateKey = null;
    let candidateSince = 0;
    const textState = {};
    while (Date.now() < deadline) {
      const responses = tracker.images();
      const responseByKey = new Map(responses.map((image) => [image.key, image]));
      const rendered = (await this.currentAssistantImages().catch(() => []))
        .map((image) => ({ ...image, parsed: parseGrokGeneratedImageUrl(image.source) }))
        .filter((image) => (
          image.parsed
          && !baseline.has(image.parsed.key)
          && responseByKey.has(image.parsed.key)
        ));
      const keys = [...new Set(rendered.map((image) => image.parsed.key))];
      if (
        keys.length > 0
        && Date.now() - tracker.lastAddedAt() >= this.responseStabilityMs
      ) {
        const signature = keys.join("|");
        if (candidateKey !== signature) {
          candidateKey = signature;
          candidateSince = Date.now();
        } else if (Date.now() - candidateSince >= this.responseStabilityMs) {
          const parsed = responseByKey.get(keys[0]);
          return {
            source: parsed.url,
            providerFileId: parsed.id,
            generatedImageCount: keys.length,
            selectedImageIndex: 1,
          };
        }
      }
      if (keys.length === 0) {
        const text = await this.completedTextResponse(textState);
        if (text) return text;
      } else {
        textState.candidate = null;
      }
      await this.adapter.page.waitForTimeout(500);
    }
    throw new Error(`Grok did not finish an image within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  async downloadGeneratedImage(image) {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-"));
    const sourceUrl = new URL(image.source);
    const extension = path.extname(sourceUrl.pathname).toLowerCase() || ".jpg";
    const temporaryPath = path.join(temporaryDir, `generated-image${extension}`);
    try {
      const response = await this.adapter.page.request.get(image.source, {
        timeout: 60_000,
      });
      if (!response.ok()) {
        throw new Error(`Grok image download failed with HTTP ${response.status()}.`);
      }
      await fs.writeFile(temporaryPath, await response.body());
      return {
        temporaryDir,
        temporaryPath,
        suggestedFilename: path.basename(sourceUrl.pathname) || `generated-image${extension}`,
        downloadUrl: image.source,
      };
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => null);
      throw error;
    }
  }

  async generate(request, execution = {}) {
    if (request.referenceImages.length > 0) {
      throw new Error("The current Grok image driver does not support reference images.");
    }
    await this.ensureChatPage();
    const baseline = new Set(
      (await this.currentAssistantImages().catch(() => []))
        .map((image) => parseGrokGeneratedImageUrl(image.source)?.key)
        .filter(Boolean),
    );
    const tracker = this.trackGeneratedImageResponses();
    try {
      tracker.arm();
      return await this.performTurn(request, execution, async () => {
        const image = await this.waitForGeneratedImage(
          request.timeoutMs,
          tracker,
          baseline,
        );
        if (image.type === "text") return image;
        const downloaded = await this.downloadGeneratedImage(image);
        return {
          sourcePath: downloaded.temporaryPath,
          cleanup: async () => fs.rm(downloaded.temporaryDir, { recursive: true, force: true }),
          provenance: {
            provider: this.provider,
            providerFileId: image.providerFileId,
            suggestedFilename: downloaded.suggestedFilename,
            generatedImageCount: image.generatedImageCount,
            selectedImageIndex: image.selectedImageIndex,
          },
        };
      });
    } finally {
      tracker.stop();
    }
  }
}
