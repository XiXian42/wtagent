import { ChatGPTWebAdapter } from "./chatgpt-web-adapter.js";
import { ClaudeWebAdapter } from "./claude-web-adapter.js";
import { DeepSeekWebAdapter } from "./deepseek-web-adapter.js";
import { GeminiWebAdapter } from "./gemini-web-adapter.js";
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
//   promptsForMode       - whether the CLI shows an interactive mode picker at
//                          conversation start (ChatGPT has Pro/Current; most
//                          providers do not prompt)
//   defaultMode          - mode applied silently at conversation start when the
//                          provider does not prompt (null = keep the site's
//                          current setting). The adapter's selectMode()
//                          interprets this value.
//   adapter              - the adapter class, or null until implemented
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
    promptsForMode: true,
    defaultMode: null,
    adapter: ChatGPTWebAdapter,
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://chat.deepseek.com/",
    profileBasename: "deepseek-profile",
    status: "active",
    // DeepSeek does not prompt; every new conversation silently switches to
    // 专家模式 (Expert) + 深度思考 (Deep Thinking) — see DeepSeekWebAdapter.selectMode.
    promptsForMode: false,
    defaultMode: "expert-thinking",
    adapter: DeepSeekWebAdapter,
  }),
  claude: Object.freeze({
    id: "claude",
    label: "Claude",
    baseUrl: "https://claude.ai/",
    profileBasename: "claude-profile",
    status: "active",
    promptsForMode: false,
    // Keep whatever model claude.ai selects in this browser profile. WTAgent
    // does not open the model menu or override the account/site default.
    defaultMode: null,
    adapter: ClaudeWebAdapter,
  }),
  grok: Object.freeze({
    id: "grok",
    label: "Grok",
    baseUrl: "https://grok.com/",
    profileBasename: "grok-profile",
    status: "planned",
    promptsForMode: false,
    defaultMode: null,
    adapter: null,
  }),
  kimi: Object.freeze({
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://www.kimi.com/",
    profileBasename: "kimi-profile",
    status: "active",
    // Kimi does not prompt; every new conversation silently switches to the K3
    // flagship model — see KimiWebAdapter.selectMode.
    promptsForMode: false,
    defaultMode: "k3",
    adapter: KimiWebAdapter,
  }),
  glm: Object.freeze({
    id: "glm",
    label: "GLM",
    baseUrl: "https://chat.z.ai/",
    profileBasename: "glm-profile",
    status: "active",
    // GLM does not prompt; every new conversation silently selects the newest
    // available model (GLM-5.3, else GLM-5.2) — see GLMWebAdapter.selectMode.
    promptsForMode: false,
    defaultMode: "latest",
    adapter: GLMWebAdapter,
  }),
  gemini: Object.freeze({
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://gemini.google.com/app",
    profileBasename: "gemini-profile",
    status: "active",
    promptsForMode: false,
    // Preserve the model currently selected by Gemini in this profile.
    defaultMode: null,
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

// `--mode` is ChatGPT's Pro/Current switch, but people often type
// `--mode kimi` meaning the Kimi provider. If the value is a known provider
// id, treat it as `--model` and clear `--mode` so ChatGPT mode parsing is not
// applied. Conflicting `--model` + `--mode <provider>` is rejected.
export function resolveCliProviderSelection({ model, mode } = {}) {
  const modeAsProvider = findProvider(mode);
  if (!modeAsProvider) {
    return { model, mode };
  }
  if (model != null && getProvider(model).id !== modeAsProvider.id) {
    throw new Error(
      `--mode ${mode} selects ${modeAsProvider.label}, but --model ${model} is already set. `
        + `Use --model ${modeAsProvider.id}.`,
    );
  }
  return { model: modeAsProvider.id, mode: undefined };
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
