import { ChatGPTImageDriver } from "./providers/chatgpt-image-driver.js";
import { GeminiImageDriver } from "./providers/gemini-image-driver.js";
import { GrokImageDriver } from "./providers/grok-image-driver.js";

export const IMAGE_PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({ id: "chatgpt", driver: ChatGPTImageDriver }),
  gemini: Object.freeze({ id: "gemini", driver: GeminiImageDriver }),
  grok: Object.freeze({ id: "grok", driver: GrokImageDriver }),
});

export function listImageProviderIds() {
  return Object.keys(IMAGE_PROVIDERS);
}

export function createImageDriver({ provider, adapter, sharedConversation = false }) {
  const record = IMAGE_PROVIDERS[provider];
  if (!record) {
    throw new Error(
      `Provider "${provider}" has no image driver. Supported image providers: ${listImageProviderIds().join(", ")}.`,
    );
  }
  return new record.driver({ provider, adapter, sharedConversation });
}
