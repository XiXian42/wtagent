import test from "node:test";
import assert from "node:assert/strict";
import { QwenWebAdapter } from "../src/browser/qwen-web-adapter.js";

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

test("exposes Qwen URL and conversation pattern", () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Qwen");
  assert.equal(adapter.baseUrl, "https://chat.qwen.ai/");
  assert.equal(adapter.conversationUrlPattern().test("/c/abc-123"), true);
  assert.equal(adapter.conversationUrlPattern().test("/c/"), true);
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("provides robust composer locators for Qwen", () => {
  const selectors = [];
  const locator = new EmptyLocator();
  const adapter = new QwenWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
    getByRole() {
      return locator;
    },
  };

  const composeres = adapter.composerLocators();
  assert.ok(composeres.length >= 4);
  assert.ok(selectors.some((s) => s.includes("Qwen") || s.includes("千问")));
  assert.ok(selectors.some((s) => s.includes("contenteditable")));
});

test("provides send and stop button locators", () => {
  const selectors = [];
  const locator = new EmptyLocator();
  const adapter = new QwenWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
    getByRole() {
      return locator;
    },
  };

  adapter.sendButtonLocators();
  assert.ok(selectors.some((s) => s.includes("send") || s.includes("发送") || s.includes("submit")));

  selectors.length = 0;
  adapter.stopButtonLocators();
  assert.ok(selectors.some((s) => s.includes("stop") || s.includes("停止")));
});

test("detects authentication URL and text patterns", () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  assert.equal(adapter.authUrlPattern().test("/login"), true);
  assert.equal(adapter.authUrlPattern().test("/signin"), true);
  assert.equal(adapter.authUrlPattern().test("/c/123"), false);

  assert.equal(adapter.authTextPattern().test("Sign in to Qwen"), true);
  assert.equal(adapter.authTextPattern().test("登录通义千问"), true);
  assert.equal(adapter.authTextPattern().test("Hello world"), false);
});

test("detects usage limit marker", async () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  const retryBtn = new EmptyLocator();
  retryBtn.count = async () => 1;
  retryBtn.isVisible = async () => true;

  const message = new EmptyLocator();
  message.innerText = async () => "You have reached your usage limit. Please try again later.";
  message.getByRole = (role, opts) => {
    if (opts?.name?.test("try again")) {
      return retryBtn;
    }
    return new EmptyLocator();
  };
  message.locator = () => new EmptyLocator();

  const marker = await adapter.findUsageLimitMarker(message);
  assert.ok(marker);
  assert.ok(marker.includes("usage limit"));
});

test("locates user and assistant messages", () => {
  const selectors = [];
  const locator = new EmptyLocator();
  const adapter = new QwenWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
  };

  adapter.assistantMessages();
  assert.ok(selectors[0].includes("assistant"));

  selectors.length = 0;
  adapter.userMessages();
  assert.ok(selectors[0].includes("user"));
});
