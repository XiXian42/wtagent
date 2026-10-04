
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

test("keeps Grok's hydrating textarea and role textbox in one composer locator", () => {
  const selectors = [];
  const locator = new EmptyLocator();
  const adapter = new GrokWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
  };

  adapter.composerLocators();

  assert.equal(selectors[0], 'main textarea, main [role="textbox"]');
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

test("uses Grok response wrapper UUID as a stable message identity", async () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  const message = new EmptyLocator();
  message.getAttribute = async (name) => (
    name === "data-testid" ? "user-message" : null
  );
  message.evaluate = async (callback) => callback({
    closest(selector) {
      return selector.includes("data-scroll-anchor-root")
        ? { id: "response-56690368-2bc6-4712-8701-837b38abe30c" }
        : null;
    },
  });
  const users = new EmptyLocator();
  users.count = async () => 3;
  adapter.userMessages = () => users;

  assert.deepEqual(await adapter.messageIdentity(message), {
    id: "response-56690368-2bc6-4712-8701-837b38abe30c",
    turn: 3,
  });
});

test("reads Grok's complete rendered user message", async () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  const markdown = new EmptyLocator();
  markdown.count = async () => 1;
  markdown.evaluateAll = async (callback) => callback([{
    innerText: "Draw a lighthouse.\n\nAspect ratio: 9:16.",
    contains: () => false,
    getClientRects: () => [{}],
  }]);
  const message = new EmptyLocator();
  message.locator = () => markdown;

  assert.equal(
    await adapter.userMessageText(message),
    "Draw a lighthouse.\n\nAspect ratio: 9:16.",
  );
});

test("Grok adapter never selects a model automatically", () => {
  const adapter = new GrokWebAdapter({ profileDir: "." });
  assert.equal(typeof adapter.selectMode, "undefined");
});
