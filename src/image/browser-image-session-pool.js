import { createWebAdapter, getProviderProfileDir, resolveProvider } from "../browser/provider-registry.js";

export class BrowserImageSessionPool {
  constructor({
    primaryAdapter,
    primaryProvider,
    appDataDir,
    chromePath,
    debug = false,
    minimized = true,
    adapterFactory = createWebAdapter,
  }) {
    this.primaryAdapter = primaryAdapter;
    this.primaryProvider = primaryProvider;
    this.appDataDir = appDataDir;
    this.chromePath = chromePath;
    this.debug = debug;
    this.minimized = minimized;
    this.adapterFactory = adapterFactory;
    this.resources = new Map();
  }

  async adapterFor(providerId) {
    if (providerId === this.primaryProvider.id) {
      if (!this.primaryAdapter.context || !this.primaryAdapter.page) {
        throw new Error(
          `${this.primaryProvider.label} browser context is not ready for image generation.`,
        );
      }
      // Image generation is an ordinary turn in the active conversation. Do
      // not clone the adapter or create a second Page: doing so would split the
      // provider's visible history from Runtime's message identities.
      return {
        adapter: this.primaryAdapter,
        sharedConversation: true,
        close: async () => {},
      };
    }

    const cached = this.resources.get(providerId);
    if (cached) return await cached;
    const pending = this.#create(providerId);
    this.resources.set(providerId, pending);
    try {
      return await pending;
    } catch (error) {
      this.resources.delete(providerId);
      throw error;
    }
  }

  async #create(providerId) {
    const provider = resolveProvider(providerId);
    const adapter = this.adapterFactory({
      provider,
      profileDir: getProviderProfileDir(this.appDataDir, providerId),
      chromePath: this.chromePath,
      debug: this.debug,
      minimized: this.minimized,
      cancelOnEsc: false,
    });

    await adapter.launch();
    let authState = await adapter.getAuthState();
    if (authState !== "authenticated") {
      // A freshly attached SPA can expose neither its login control nor its
      // composer for a few seconds. Give it the same bounded authentication
      // grace as the primary Runtime before declaring the profile logged out.
      await adapter.waitForManualLogin({ timeoutMs: 8_000 }).catch(() => null);
      authState = await adapter.getAuthState();
    }
    if (authState !== "authenticated") {
      await adapter.close().catch(() => null);
      throw new Error(
        `${provider.label} is not logged in. Run "wtagent login --model ${providerId}" first.`,
      );
    }
    await adapter.startConversation(null);
    adapter.ownsWindow = true;
    return {
      adapter,
      sharedConversation: false,
      close: async () => adapter.close(),
    };
  }

  async close() {
    const resources = await Promise.allSettled([...this.resources.values()]);
    this.resources.clear();
    for (const result of resources) {
      if (result.status === "fulfilled") {
        await result.value.close().catch(() => null);
      }
    }
  }
}
