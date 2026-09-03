
import test from "node:test";
import assert from "node:assert/strict";
import { GrokWebAdapter } from "../src/browser/grok-web-adapter.js";

class EmptyLocator {
  async count() { return 0; }
  first() { return this; }
  last() { return this; }
  nth() { return this; }
  async isVisible() { return false; }
  async innerText() { return ""; }
  async getAttribute() { return null; }
  locator() { return this; }
  getByRole() { return this; }
}

test("exposes Grok URL and conversation pattern", () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Grok");
  assert.equal(adapter.baseUrl, "https://grok.com/");
  assert.equal(adapter.conversationUrlPattern().test("/c/abc"), true);
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("uses Grok stop-response button as generation signal", async () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  const visible = new EmptyLocator();
  visible.count = async () => 1;
  visible.isVisible = async () => true;
  adapter.page = {
    locator(selector) {
      return selector.includes("停止模型响应") ? visible : new EmptyLocator();
    },
  };

  assert.equal(await adapter.isAssistantGenerating(), true);
  assert.equal(adapter.hasReliableCompletionSignal(), true);
});

test("Grok adapter never selects a model automatically", () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  assert.equal(typeof adapter.selectMode, "undefined");
});
