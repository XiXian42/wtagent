import { ChatGPTWebAdapter } from "./chatgpt-web-adapter.js";
import { ClaudeWebAdapter } from "./claude-web-adapter.js";
import { DeepSeekWebAdapter } from "./deepseek-web-adapter.js";
import { GeminiWebAdapter } from "./gemini-web-adapter.js";
import { GrokWebAdapter } from "./grok-web-adapter.js";
import { KimiWebAdapter } from "./kimi-web-adapter.js";
import { GLMWebAdapter } from "./glm-web-adapter.js";
import { getProfileDir } from "../platform/paths.js";

// Single source of truth for the web-AI providers WTAgent can drive. The CLI,
// per-provider Chrome profile resolution, and `resume` all read from here so a
// new provider is added in exactly one place.
//
// Fields:
//   id                   - stable CLI/session identifier (the `--model` value)
//   label                - human display name
//   baseUrl              - origin the adapter operates on (login + conversation)
//   profileBasename      - dedicated Chrome profile directory name under the app
//                          data dir; each provider logs in once, independently
//   status               - "active" (has a working adapter) | "planned" (named
//                          but not implemented yet)
//   adapter              - the adapter class, or null until implemented
//
// WTAgent deliberately does not encode provider-specific model names or choose
// a model automatically. After login, interactive runs give the user a chance
// to choose directly on the provider website; pressing Enter keeps whatever
// the website currently has selected.
//
// ChatGPT keeps the historical "chrome-profile" basename so existing logins,
// the logout guard, and cli.test.js keep working unchanged.
export const PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({
    id: "chatgpt",
    label: "ChatGPT",
    baseUrl: "https://chatgpt.com/",
    profileBasename: "chrome-profile",
    status: "active",
    adapter: ChatGPTWebAdapter,
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://chat.deepseek.com/",
    profileBasename: "deepseek-profile",
    status: "active",
    adapter: DeepSeekWebAdapter,
  }),
  claude: Object.freeze({
    id: "claude",
    label: "Claude",
    baseUrl: "https://claude.ai/",
    profileBasename: "claude-profile",
    status: "active",
    adapter: ClaudeWebAdapter,
  }),
  grok: Object.freeze({
    id: "grok",
    label: "Grok",
    baseUrl: "https://grok.com/",
    profileBasename: "grok-profile",
    status: "active",
    adapter: GrokWebAdapter,
  }),
  kimi: Object.freeze({
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://www.kimi.com/",
    profileBasename: "kimi-profile",
    status: "active",
    adapter: KimiWebAdapter,
  }),
  glm: Object.freeze({
    id: "glm",
    label: "GLM",
    baseUrl: "https://chat.z.ai/",
    profileBasename: "glm-profile",
    status: "active",
    adapter: GLMWebAdapter,
  }),
  gemini: Object.freeze({
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://gemini.google.com/app",
    profileBasename: "gemini-profile",
    status: "active",
    adapter: GeminiWebAdapter,
  }),
});

export const DEFAULT_PROVIDER = "chatgpt";

export function listActiveProviderIds() {
  return Object.values(PROVIDERS)
    .filter((provider) => provider.status === "active")
    .map((provider) => provider.id);
}

// Returns the provider record without asserting it is usable. Useful for
// profile-directory resolution, which must work for any known id (e.g. so
// `logout` can reset a profile). Throws only for a genuinely unknown id.
export function findProvider(providerId) {
  if (providerId == null || providerId === "") {
    return null;
  }
  return PROVIDERS[String(providerId).toLowerCase()] ?? null;
}

export function getProvider(providerId) {
  const provider = findProvider(providerId);
  if (!provider) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new Error(`Unknown model "${providerId}". Known providers: ${known}.`);
  }
  return provider;
}

// Resolves the dedicated Chrome profile directory for a provider under the
// given app data dir. ChatGPT resolves to the historical "chrome-profile".
export function getProviderProfileDir(appDataDir, providerId) {
  return getProfileDir(appDataDir, getProvider(providerId).profileBasename);
}

// Whether `basename` is the profile directory name of any known provider. The
// logout guard uses this so it will only ever delete a directory that matches a
// real provider profile.
export function isProviderProfileBasename(basename) {
  return Object.values(PROVIDERS)
    .some((provider) => provider.profileBasename === basename);
}

// Resolves a provider that has a working adapter, or throws a clear,
// actionable error. Used everywhere WTAgent is about to actually drive a
// browser (run, resume, login).
export function resolveProvider(providerId = DEFAULT_PROVIDER) {
  const provider = getProvider(providerId);
  if (provider.status !== "active" || !provider.adapter) {
    const active = listActiveProviderIds().join(", ");
    throw new Error(
      `Model "${provider.id}" is not supported yet. Active providers: ${active}. `
        + "Support for more providers is planned.",
    );
  }
  return provider;
}

// Builds the adapter instance for a provider. `provider` may be an id or a
// provider record. All remaining options are forwarded to the adapter
// constructor (profileDir, chromePath, debug, minimized, cancelOnEsc).
export function createWebAdapter({ provider, ...adapterOptions }) {
  const record = typeof provider === "string"
    ? resolveProvider(provider)
    : (provider?.adapter ? provider : resolveProvider(provider?.id));
  return new record.adapter({
    ...adapterOptions,
    baseUrl: record.baseUrl,
  });
}
