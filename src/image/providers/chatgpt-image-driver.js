import fs from "node:fs/promises";
import { BrowserImageDriver } from "../browser-image-driver.js";

const DOWNLOAD_NAME_PATTERN = /download(?: image)?|下载(?:图片)?|下載(?:圖片)?/i;
const MIN_IMAGE_EDGE = 256;

export function preferredImageUrl(image) {
  const candidates = [image?.source, image?.href]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (candidates.length === 0) {
    return null;
  }
  const durableHttps = candidates.find((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:"
        && !parsed.hostname.endsWith("chatgpt.com");
    } catch {
      return false;
    }
  });
  return durableHttps
    ?? candidates.find((value) => value.startsWith("https://"))
    ?? candidates[0];
}

export class ChatGPTImageDriver extends BrowserImageDriver {
  capabilities() {
    return Object.freeze({
      generate: true,
      referenceImages: true,
      aspectRatios: ["auto", "1:1", "3:2", "2:3", "16:9", "9:16"],
      imageCount: 1,
    });
  }

  async generate(request, execution = {}) {
    await this.ensureChatPage();
    const baseline = new Set(
      (await this.chatImages().catch(() => [])).map((image) => preferredImageUrl(image)),
    );
    return await this.performTurn(request, execution, async () => {
      const image = await this.waitForChatImage(request.timeoutMs, baseline);
      if (image.type === "text") return image;
      const downloaded = await this.downloadChatImage(
        image,
        Math.min(request.timeoutMs, 60_000),
      );
      return {
        sourcePath: downloaded.temporaryPath,
        cleanup: async () => fs.rm(downloaded.temporaryDir, { recursive: true, force: true }),
        provenance: {
          provider: this.provider,
          providerFileId: this.remoteFileId(image.source)
            ?? this.remoteFileId(downloaded.downloadUrl),
          suggestedFilename: downloaded.suggestedFilename,
        },
      };
    });
  }

  async imagesFromLocator(locator) {
    if (await locator.count().catch(() => 0) === 0) return [];
    return await locator.evaluate((root, minEdge) => {
      const toAbsolute = (value) => {
        if (!value) return "";
        try {
          return new URL(value, location.href).href;
        } catch {
          return value;
        }
      };
      const fromSrcset = (srcset) => {
        let best = "";
        let bestWidth = 0;
        for (const part of String(srcset ?? "").split(",")) {
          const [url, descriptor] = part.trim().split(/\s+/, 2);
          const width = descriptor?.endsWith("w")
            ? Number.parseInt(descriptor, 10)
            : 0;
          if (url && width >= bestWidth) {
            best = url;
            bestWidth = width;
          }
        }
        return best;
      };
      const images = [...root.querySelectorAll("img")].map((image) => {
        const source = toAbsolute(
          image.currentSrc
          || fromSrcset(image.srcset)
          || image.src
          || image.getAttribute("data-src")
          || "",
        );
        const href = toAbsolute(image.closest("a")?.href || "");
        return {
          source,
          href,
          width: image.naturalWidth || 0,
          height: image.naturalHeight || 0,
        };
      }).filter((image) => (
        (image.source || image.href)
        && image.width >= minEdge
        && image.height >= minEdge
      ));

      for (const link of root.querySelectorAll("a[href]")) {
        const href = toAbsolute(link.href);
        if (
          !href
          || images.some((image) => image.href === href || image.source === href)
        ) {
          continue;
        }
        if (
          /oaiusercontent/i.test(href)
          || /\.(png|jpe?g|webp)(?:\?|$)/i.test(href)
        ) {
          images.push({
            source: href,
            href,
            width: minEdge,
            height: minEdge,
          });
        }
      }
      return images;
    }, MIN_IMAGE_EDGE).catch(() => []);
  }

  async currentAssistantImages() {
    return await this.imagesFromLocator(this.adapter.assistantMessages().last());
  }

  async chatImages() {
    return await this.imagesFromLocator(
      this.adapter.page.locator("main").first(),
    );
  }

  async waitForChatImage(timeoutMs, baseline = new Set()) {
    const deadline = Date.now() + timeoutMs;
    let candidate = null;
    let stableSince = 0;
    const textState = {};
    while (Date.now() < deadline) {
      const images = (await this.currentAssistantImages().catch(() => []))
        .filter((image) => !baseline.has(preferredImageUrl(image)));
      if (images.length > 1) {
        throw new Error(
          "ChatGPT produced multiple uncorrelated chat images; refusing to guess which artifact belongs to this request.",
        );
      }
      if (images.length === 1) {
        const next = preferredImageUrl(images[0]);
        if (candidate !== next) {
          candidate = next;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 1_500) {
          return { ...images[0], source: next };
        }
      } else {
        candidate = null;
        stableSince = 0;
      }
      if (images.length === 0) {
        const text = await this.completedTextResponse(textState);
        if (text) return text;
      } else {
        textState.candidate = null;
      }
      await this.adapter.page.waitForTimeout(1_000);
    }
    throw new Error(`ChatGPT did not publish a new image within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  async downloadChatImage(image, timeoutMs) {
    await this.adapter.page.bringToFront().catch(() => null);
    const url = preferredImageUrl(image);
    if (url) {
      try {
        return await this.saveFromUrl(this.adapter.page, url, timeoutMs);
      } catch {
        // The in-chat URL can be a preview or expire; try a download control next.
      }
    }

    const response = this.adapter.assistantMessages().last();
    const buttonCandidates = [
      response.getByRole("button", { name: DOWNLOAD_NAME_PATTERN }),
      response.locator('button[aria-label*="download" i]'),
    ];
    for (const locator of buttonCandidates) {
      if (await locator.first().isVisible().catch(() => false)) {
        try {
          return await this.saveDownload(
            this.adapter.page,
            locator.first(),
            Math.min(timeoutMs, 30_000),
          );
        } catch {
          break;
        }
      }
    }
    throw new Error("ChatGPT generated an image but no download control or image URL was found.");
  }

}
