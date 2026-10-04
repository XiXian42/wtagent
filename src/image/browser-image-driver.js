import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ImageProviderDriver } from "./image-provider-driver.js";
import { appendSystemReminder } from "../protocol/markers.js";

const IMAGE_OUTBOUND_CORRELATION_PREFIX =
  " Opaque WTAgent transport correlation ID (do not repeat): ";

function parseRemoteFileId(value) {
  try {
    return new URL(value).searchParams.get("id");
  } catch {
    return null;
  }
}

function extensionForContentType(contentType, fallback = ".png") {
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  if (type.includes("png")) return ".png";
  return fallback;
}

export class BrowserImageDriver extends ImageProviderDriver {
  async ensureChatPage() {
    if (!this.adapter.page) {
      throw new Error(`${this.provider} chat page is unavailable.`);
    }
    const kind = this.adapter.classifyConversationUrl?.(this.adapter.page.url());
    if (!["fresh", "restorable", "provisional"].includes(kind)) {
      throw new Error(`${this.provider} is not on a normal chat page.`);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.composer()) return;
      await this.adapter.page.waitForTimeout(500);
    }
    throw new Error(`${this.provider} chat composer is unavailable.`);
  }

  async composer() {
    for (const locator of this.adapter.composerLocators()) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  }

  promptText(request) {
    const lines = [
      "Generate exactly one image now. Use your native image-generation capability and output the image itself. Do not write drawing code or respond with only a text description.",
      `Image requirements:\n${request.prompt}`,
    ];
    if (request.aspectRatio !== "auto") {
      lines.push(`Aspect ratio: ${request.aspectRatio}.`);
    }
    return lines.join("\n\n");
  }

  // Poll alongside image detection, without consuming the assistant boundary.
  // The normal auxiliary-turn completion path still verifies/checkpoints it.
  // A refusal, clarification, or other finished text is a provider result too;
  // do not classify it using language-specific refusal keywords.
  async completedTextResponse(state) {
    const adapter = this.adapter;
    if (typeof adapter.isNewAssistantIdentity !== "function") return null;
    const reset = () => { state.candidate = null; return null; };
    const messages = adapter.assistantMessages();
    if (await messages.count() === 0) return reset();
    const message = messages.last();
    const identity = await adapter.messageIdentity(message);
    const text = await adapter.assistantText(message);
    if (!text.trim() || !adapter.isNewAssistantIdentity({ ...identity, text })) {
      return reset();
    }
    if (await adapter.isAssistantGenerating(message)) return reset();
    for (const locator of adapter.stopButtonLocators()) {
      if (await locator.first().isVisible()) return reset();
    }
    // An image can mount before its pixels/URL are ready. Do not return a
    // caption while that image is still loading or awaiting correlation.
    const hasImage = await message.locator("img").evaluateAll((images) => images.some(
      (image) => !image.complete || (image.naturalWidth >= 256 && image.naturalHeight >= 256),
    ));
    if (hasImage) return reset();
    const key = JSON.stringify([identity.id, identity.turn, text]);
    if (state.candidate !== key) {
      state.candidate = key;
      state.since = Date.now();
      return null;
    }
    const stableMs = adapter.hasReliableCompletionSignal()
      ? 2_000
      : Math.max(10_000, adapter.truncatedEnvelopeGraceMs());
    if (Date.now() - state.since < stableMs) return null;
    return {
      type: "text",
      text,
      provenance: {
        provider: this.provider,
        assistantMessageId: identity.id ?? null,
        assistantTurn: identity.turn ?? null,
      },
    };
  }

  async performTurn(request, execution, waitForCompletion) {
    const prompt = this.promptText(request);
    if (this.sharedConversation) {
      if (typeof execution?.runAuxiliaryTurn !== "function") {
        throw new Error(
          `${this.provider} image generation in the active chat requires Runtime auxiliary-turn support.`,
        );
      }
      return await execution.runAuxiliaryTurn({
        text: prompt,
        files: request.referenceImages,
        timeoutMs: request.timeoutMs,
        waitForCompletion,
      });
    }

    const outboundId = randomUUID();
    const message = appendSystemReminder(
      prompt,
      "This is an internal WTAgent provider operation. Perform only the requested operation; "
        + `do not emit the WTAgent XML protocol.${IMAGE_OUTBOUND_CORRELATION_PREFIX}${outboundId}.`,
    );
    let value;
    try {
      const sendResult = await this.adapter.sendMessage(message, {
        files: request.referenceImages,
        maxBytes: null,
        outboundId,
        allowAssistantContinuation: false,
        requireAttachments: request.referenceImages.length > 0,
      });
      value = await waitForCompletion({
        adapter: this.adapter,
        page: this.adapter.page,
        sendResult,
        timeoutMs: request.timeoutMs,
      });
      await this.adapter.captureAuxiliaryTurnCompletion?.({
        timeoutMs: Math.min(request.timeoutMs, 30_000),
      });
      return value;
    } catch (error) {
      await value?.cleanup?.().catch(() => null);
      if (this.adapter.getLastSendStatus?.() !== "not-submitted") {
        error.completionUnknown = true;
      }
      throw error;
    }
  }

  async saveDownload(page, button, timeoutMs) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: timeoutMs }),
      button.click(),
    ]);
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-"));
    const suggestedFilename = path.basename(
      download.suggestedFilename() || "generated-image",
    );
    const temporaryPath = path.join(
      temporaryDir,
      suggestedFilename,
    );
    try {
      await download.saveAs(temporaryPath);
      return {
        temporaryDir,
        temporaryPath,
        suggestedFilename,
        downloadUrl: download.url(),
      };
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => null);
      throw error;
    }
  }

  async saveFromUrl(page, url, timeoutMs) {
    if (!url) {
      throw new Error("No image URL was available to download.");
    }

    let body;
    let contentType = "";
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      const result = await page.evaluate(async (src) => {
        const response = await fetch(src);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        }
        return {
          base64: btoa(binary),
          contentType: response.headers.get("content-type") || "",
        };
      }, url);
      body = Buffer.from(result.base64, "base64");
      contentType = result.contentType;
    } else {
      const response = await page.request.get(url, { timeout: timeoutMs });
      if (!response.ok()) {
        throw new Error(`Image URL download failed with HTTP ${response.status()}.`);
      }
      body = Buffer.from(await response.body());
      contentType = response.headers()["content-type"] ?? "";
    }

    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-image-"));
    const suggestedFilename = `generated-image${extensionForContentType(contentType)}`;
    const temporaryPath = path.join(temporaryDir, suggestedFilename);
    try {
      await fs.writeFile(temporaryPath, body);
      return {
        temporaryDir,
        temporaryPath,
        suggestedFilename,
        downloadUrl: url,
      };
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => null);
      throw error;
    }
  }

  remoteFileId(url) {
    return parseRemoteFileId(url);
  }
}
