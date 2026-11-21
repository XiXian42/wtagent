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

  adapter.conversationMessages();
  assert.equal(selectors[0], ".qwen-chat-message");

  selectors.length = 0;
  adapter.assistantMessages();
  assert.ok(selectors[0].includes("assistant"));

  selectors.length = 0;
  adapter.userMessages();
  assert.ok(selectors[0].includes("user"));
});

test("assistantText extracts markdown response excluding thinking", async () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  const message = new EmptyLocator();
  const contentLocator = new EmptyLocator();
  contentLocator.count = async () => 1;
  contentLocator.last = () => ({
    async innerText() { return "<agent_response>\u00a0<done>true</done>\u00a0<tool_call\u00a0name=\"fs.write\"></tool_call></agent_response>"; },
  });
  message.locator = (selector) => {
    if (selector.includes("response-message-content")) {
      return contentLocator;
    }
    return new EmptyLocator();
  };

  const text = await adapter.assistantText(message);
  assert.ok(text.includes("<done>true</done>"));
  assert.ok(text.includes('<tool_call name="fs.write">'));
  assert.equal(text.includes("\u00a0"), false);
});

test("classifies fresh, provisional, and restorable URLs", () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  assert.equal(adapter.classifyConversationUrl("https://chat.qwen.ai/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://chat.qwen.ai/c/new-chat"), "provisional");
  assert.equal(adapter.classifyConversationUrl("https://chat.qwen.ai/c/new"), "provisional");
  assert.equal(adapter.classifyConversationUrl("https://chat.qwen.ai/c/997e-2ff119afa8ee"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://other.ai/c/123"), "invalid");
});

test("extracts message identities for user and assistant messages", async () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });

  const userMsg = new EmptyLocator();
  userMsg.evaluate = async (fn) => fn({
    classList: { contains: (cls) => cls === "qwen-chat-message-user" },
    getAttribute: () => null,
    querySelector: (sel) => sel.includes("chat-user-message-container")
      ? { getAttribute: (attr) => attr === "data-msg-id" ? "usr-1234" : null }
      : null,
  });
  const users = new EmptyLocator();
  users.count = async () => 2;
  adapter.userMessages = () => users;

  const userIdentity = await adapter.messageIdentity(userMsg);
  assert.deepEqual(userIdentity, { id: "usr-1234", turn: 2 });

  const assistantMsg = new EmptyLocator();
  assistantMsg.evaluate = async (fn) => fn({
    classList: { contains: (cls) => cls === "qwen-chat-message-assistant" },
    getAttribute: () => null,
    querySelector: (sel) => sel.includes("chat-response-message")
      ? { id: "chat-response-message-asst-5678" }
      : null,
  });
  const assistants = new EmptyLocator();
  assistants.count = async () => 1;
  adapter.assistantMessages = () => assistants;

  const assistantIdentity = await adapter.messageIdentity(assistantMsg);
  assert.deepEqual(assistantIdentity, { id: "asst-5678", turn: 1 });
});

test("detects new assistant identity and reliable completion signal", () => {
  const adapter = new QwenWebAdapter({ profileDir: "." });
  adapter.assistantIdsBeforeSend = new Set(["old-asst"]);
  adapter.assistantCountBeforeSend = 1;

  assert.equal(adapter.isNewAssistantIdentity({ id: "new-asst", turn: 1 }), true);
  assert.equal(adapter.isNewAssistantIdentity({ id: "old-asst", turn: 2 }), true);
  assert.equal(adapter.isNewAssistantIdentity({ id: "old-asst", turn: 1 }), false);
  assert.equal(adapter.hasReliableCompletionSignal(), true);
});
