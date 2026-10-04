import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ArtifactStore, inspectImageBuffer } from "../artifacts/artifact-store.js";
import { createImageDriver, listImageProviderIds } from "./provider-registry.js";
import { parseGrokGeneratedImageUrl } from "./providers/grok-image-driver.js";

// Receive the ordinary assistant turn. This class never sends a prompt or
// generates an image, and is deliberately absent from the local tool catalog.
export class NativeImageReceiver {
  static forAdapter(provider, adapter) {
    return listImageProviderIds().includes(provider)
      ? new NativeImageReceiver({ provider, adapter }) : null;
  }

  constructor({ provider, adapter }) {
    this.provider = provider;
    this.adapter = adapter;
    this.driver = createImageDriver({ provider, adapter });
  }

  async read(message) {
    const snapshot = await message.locator("img").evaluateAll((elements) => ({
      pending: elements.some((image) => !image.complete),
      images: elements.filter((image) => image.isConnected && image.complete
        && image.naturalWidth >= 256 && image.naturalHeight >= 256)
        .map((image) => ({
          source: image.currentSrc || image.src,
          width: image.naturalWidth,
          height: image.naturalHeight,
        })),
    }));
    const seen = new Set();
    snapshot.images = snapshot.images.filter((image) => {
      if (!image.source || seen.has(image.source)) return false;
      if (this.provider === "grok" && !parseGrokGeneratedImageUrl(image.source)) return false;
      seen.add(image.source);
      return true;
    });
    return snapshot;
  }

  async save(images, { projectRoot, handoffId, assistantMessageId }) {
    const store = new ArtifactStore({ projectRoot });
    // The handoff UUID names this turn, so retries reuse the same destination
    // without overwriting artifacts from another turn or a user-selected path.
    const directory = path.join("artifacts", "native-images",
      createHash("sha256").update(handoffId).digest("hex").slice(0, 24));
    const artifacts = [];
    for (const [index, image] of images.entries()) {
      const downloaded = await this.driver.saveFromUrl(this.adapter.page, image.source, 60_000);
      try {
        const inspected = inspectImageBuffer(await fs.readFile(downloaded.temporaryPath));
        artifacts.push(await store.saveImage(downloaded.temporaryPath,
          path.join(directory, `image-${index + 1}${inspected.extension}`), {
            provider: this.provider,
            assistantMessageId,
            source: image.source,
          }));
      } finally {
        await fs.rm(downloaded.temporaryDir, { recursive: true, force: true });
      }
    }
    return artifacts;
  }
}
