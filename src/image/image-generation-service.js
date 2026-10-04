import { ArtifactStore } from "../artifacts/artifact-store.js";

export class ImageGenerationService {
  constructor({ drivers, defaultProvider = null, driverResolver = null }) {
    this.drivers = new Map(Object.entries(drivers ?? {}));
    this.defaultProvider = defaultProvider;
    this.driverResolver = driverResolver;
  }

  providerIds() {
    return [...this.drivers.keys()];
  }

  async resolveDriver(provider = "auto") {
    const requested = provider === "auto"
      ? (this.defaultProvider ?? this.providerIds()[0])
      : provider;
    const driver = this.drivers.get(requested)
      ?? await this.driverResolver?.(requested);
    if (driver && !this.drivers.has(requested)) {
      this.drivers.set(requested, driver);
    }
    if (!driver) {
      throw new Error(
        `Image provider "${requested}" is unavailable. Available providers: ${this.providerIds().join(", ") || "none"}.`,
      );
    }
    return driver;
  }

  async generate(request, context) {
    const driver = await this.resolveDriver(request.provider);
    const capabilities = driver.capabilities();
    if (!capabilities.generate) {
      throw new Error(`${driver.provider} does not support image generation.`);
    }
    if (request.referenceImages.length > 0 && !capabilities.referenceImages) {
      throw new Error(`${driver.provider} does not support reference images.`);
    }
    let aspectRatio = request.aspectRatio;
    let requestedAspectRatio = null;
    if (
      aspectRatio !== "auto"
      && capabilities.aspectRatios.length > 0
      && !capabilities.aspectRatios.includes(aspectRatio)
    ) {
      requestedAspectRatio = aspectRatio;
      aspectRatio = "auto";
    }

    await driver.adapter?.restoreWindow?.();
    await driver.adapter?.page?.bringToFront?.().catch(() => null);
    let produced;
    try {
      produced = await driver.generate(
        { ...request, aspectRatio },
        {
          runAuxiliaryTurn: context.runAuxiliaryTurn,
        },
      );
    } finally {
      if (driver.adapter?.ownsWindow) {
        await driver.adapter.minimizeWindow?.();
      }
    }
    // No artifact exists for a completed textual provider reply. Preserve it
    // as a normal result so Runtime can acknowledge the completed browser turn.
    if (produced.type === "text") return produced;
    try {
      const store = new ArtifactStore({
        projectRoot: context.projectRoot,
        allowOutside: context.allowOutside,
      });
      try {
        return await store.saveImage(
          produced.sourcePath,
          request.outputPath,
          {
            ...produced.provenance,
            ...(requestedAspectRatio
              ? { aspectRatio, requestedAspectRatio }
              : {}),
          },
        );
      } catch (error) {
        // The provider operation has already completed by the time a driver
        // returns. A validation or local write failure must therefore use the
        // same no-replay semantics as a failed download: blindly retrying the
        // tool could spend quota and create another remote image.
        error.completionUnknown = true;
        error.meta = {
          ...(error.meta ?? {}),
          provenance: produced.provenance,
        };
        throw error;
      }
    } finally {
      await produced.cleanup?.().catch(() => null);
    }
  }
}
