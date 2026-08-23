import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createWebAdapter,
  DEFAULT_PROVIDER,
  getProvider,
  getProviderProfileDir,
  isProviderProfileBasename,
  listActiveProviderIds,
  PROVIDERS,
  resolveCliProviderSelection,
  resolveProvider,
} from "../src/browser/provider-registry.js";
import { ChatGPTWebAdapter } from "../src/browser/chatgpt-web-adapter.js";
import { ClaudeWebAdapter } from "../src/browser/claude-web-adapter.js";
import { GeminiWebAdapter } from "../src/browser/gemini-web-adapter.js";

test("chatgpt is the default active provider", () => {
  assert.equal(DEFAULT_PROVIDER, "chatgpt");
  assert.equal(PROVIDERS.chatgpt.status, "active");
  assert.equal(PROVIDERS.chatgpt.adapter, ChatGPTWebAdapter);
  assert.ok(listActiveProviderIds().includes("chatgpt"));
});

test("resolveProvider returns chatgpt by default and by id", () => {
  assert.equal(resolveProvider().id, "chatgpt");
  assert.equal(resolveProvider("chatgpt").id, "chatgpt");
  // Case-insensitive.
  assert.equal(resolveProvider("ChatGPT").id, "chatgpt");
});

test("--mode kimi is treated as --model kimi", () => {
  assert.deepEqual(
    resolveCliProviderSelection({ mode: "kimi" }),
    { model: "kimi", mode: undefined },
  );
  assert.deepEqual(
    resolveCliProviderSelection({ model: "Kimi", mode: "kimi" }),
    { model: "kimi", mode: undefined },
  );
  assert.deepEqual(
    resolveCliProviderSelection({ mode: "Pro" }),
    { model: undefined, mode: "Pro" },
  );
  assert.throws(
    () => resolveCliProviderSelection({ model: "chatgpt", mode: "kimi" }),
    /--mode kimi selects Kimi/,
  );
});

test("resolveProvider rejects an unknown model with the known list", () => {
  assert.throws(
    () => resolveProvider("bogus"),
    /Unknown model "bogus".*chatgpt, deepseek/s,
  );
});

test("claude, deepseek, gemini, kimi, and glm are active with working adapters", () => {
  for (const id of ["claude", "deepseek", "gemini", "kimi", "glm"]) {
    assert.equal(PROVIDERS[id].status, "active");
    assert.ok(PROVIDERS[id].adapter, id + " should have an adapter");
    assert.equal(resolveProvider(id).id, id);
  }
  assert.deepEqual(
    listActiveProviderIds().sort(),
    ["chatgpt", "claude", "deepseek", "gemini", "glm", "kimi"],
  );
  assert.equal(PROVIDERS.claude.defaultMode, null);
  assert.equal(PROVIDERS.gemini.defaultMode, null);
});

test("resolveProvider rejects a planned provider that has no adapter yet", () => {
  // Grok remains registered-but-planned in this pass.
  assert.equal(PROVIDERS.grok.status, "planned");
  assert.throws(
    () => resolveProvider("grok"),
    /not supported yet.*Active providers/s,
  );
});

test("getProvider allows a planned provider (for profile/logout) but rejects unknown", () => {
  assert.equal(getProvider("grok").id, "grok");
  assert.throws(() => getProvider("nope"), /Unknown model/);
});

test("chatgpt keeps the historical chrome-profile basename", () => {
  assert.equal(PROVIDERS.chatgpt.profileBasename, "chrome-profile");
  assert.equal(
    getProviderProfileDir("/home/app", "chatgpt"),
    path.join("/home/app", "chrome-profile"),
  );
});

test("each provider resolves to a distinct profile directory", () => {
  const basenames = Object.values(PROVIDERS).map((p) => p.profileBasename);
  assert.equal(new Set(basenames).size, basenames.length, "profile basenames must be unique");
  assert.equal(
    getProviderProfileDir("/home/app", "deepseek"),
    path.join("/home/app", "deepseek-profile"),
  );
});

test("isProviderProfileBasename recognizes registered profiles only", () => {
  assert.equal(isProviderProfileBasename("chrome-profile"), true);
  assert.equal(isProviderProfileBasename("deepseek-profile"), true);
  assert.equal(isProviderProfileBasename("random-dir"), false);
});

test("createWebAdapter builds the provider's adapter with its base URL", () => {
  const adapter = createWebAdapter({ provider: "chatgpt", profileDir: "/tmp/p" });
  assert.ok(adapter instanceof ChatGPTWebAdapter);
  assert.equal(adapter.providerName, "ChatGPT");
  assert.equal(adapter.baseUrl, "https://chatgpt.com/");
  assert.equal(adapter.profileDir, path.resolve("/tmp/p"));

  const deepseek = createWebAdapter({ provider: "deepseek", profileDir: "/tmp/ds" });
  assert.equal(deepseek.providerName, "DeepSeek");
  assert.equal(deepseek.baseUrl, "https://chat.deepseek.com/");

  const claude = createWebAdapter({ provider: "claude", profileDir: "/tmp/claude" });
  assert.ok(claude instanceof ClaudeWebAdapter);
  assert.equal(claude.providerName, "Claude");
  assert.equal(claude.baseUrl, "https://claude.ai/");

  const gemini = createWebAdapter({ provider: "gemini", profileDir: "/tmp/gemini" });
  assert.ok(gemini instanceof GeminiWebAdapter);
  assert.equal(gemini.providerName, "Gemini");
  assert.equal(
    gemini.baseUrl,
    "https://gemini.google.com/app",
  );
});

test("createWebAdapter refuses a provider without a working adapter", () => {
  assert.throws(
    () => createWebAdapter({ provider: "grok", profileDir: "/tmp/p" }),
    /not supported yet/,
  );
});
