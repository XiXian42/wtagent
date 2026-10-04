// Provider contract for browser-backed image generation. Concrete drivers own
// website-specific navigation, completion detection, and artifact correlation.
export class ImageProviderDriver {
  constructor({ provider, adapter, sharedConversation = false }) {
    this.provider = provider;
    this.adapter = adapter;
    this.sharedConversation = sharedConversation;
  }

  capabilities() {
    return Object.freeze({
      generate: true,
      referenceImages: false,
      aspectRatios: [],
      imageCount: 1,
    });
  }

  async generate(_request, _execution = {}) {
    throw new Error(`${this.provider} does not implement image generation.`);
  }
}
