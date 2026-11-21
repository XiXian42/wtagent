import test from "node:test";
import assert from "node:assert/strict";
import { PerplexityWebAdapter, isConnectionLostError } from "../src/browser/perplexity-web-adapter.js";

class EmptyLocator {
  async count() { return 0; }
  nth() { return this; }
  first() { return this; }
  last() { return this; }
  filter() { return this; }
  async isVisible() { return false; }
  async isEnabled() { return true; }
  async innerText() { return ""; }
  async getAttribute() { return null; }
  locator() { return this; }
  getByRole() { return new EmptyLocator(); }
}

class VisibleLocator extends EmptyLocator {
  async count() { return 1; }
  async isVisible() { return true; }
}

class PerplexityMessage extends EmptyLocator {
  constructor({ role, text, id, testId }) {
    super();
    this.role = role;
    this.text = text;
    this.idAttr = id;
    this.testIdAttr = testId;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    if (name === "id") return this.idAttr ?? null;
    if (name === "data-testid") return this.testIdAttr ?? (this.role === "user" ? "user-query" : "answer");
    return null;
  }

  locator(selector) {
    if (selector.includes("prose") || selector.includes("message-content")) {
      const text = this.text;
      return {
        async count() { return 1; },
        last() {
          return {
            async innerText() { return text; },
          };
        },
      };
    }
    return new EmptyLocator();
  }
}

class MessageCollection extends EmptyLocator {
  constructor(messages) {
    super();
    this.messages = messages;
  }
  async count() { return this.messages.length; }
  nth(index) { return this.messages[index] ?? new EmptyLocator(); }
  first() { return this.messages[0] ?? new EmptyLocator(); }
  last() { return this.messages.at(-1) ?? new EmptyLocator(); }
}

function createPerplexityPage({ url = "https://www.perplexity.ai/", messages = [], stopVisible = false } = {}) {
  const user = messages.filter((m) => m.role === "user");
  const assistant = messages.filter((m) => m.role === "assistant");
  return {
    url() { return url; },
    async title() { return "Perplexity"; },
    locator(selector) {
      if (selector.includes('button[aria-label*="Stop" i]')) {
        return stopVisible ? new VisibleLocator() : new EmptyLocator();
      }
      if (selector.includes('[data-testid="user-query"]') && !selector.includes('[data-testid="answer"]')) {
        return new MessageCollection(user);
      }
      if (selector.includes('[data-testid="answer"]') && !selector.includes('[data-testid="user-query"]')) {
        return new MessageCollection(assistant);
      }
      if (selector.includes('[data-testid="user-query"]') && selector.includes('[data-testid="answer"]')) {
        return new MessageCollection(messages);
      }
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
    async waitForTimeout() {},
  };
}

test("re-exports connection loss detector", () => {
  assert.equal(isConnectionLostError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isConnectionLostError(new Error("other error")), false);
});

test("exposes Perplexity base URL and conversation URL classification", () => {
  const adapter = new PerplexityWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Perplexity");
  assert.equal(adapter.baseUrl, "https://www.perplexity.ai/");

  // Patterns
  assert.ok(adapter.conversationUrlPattern().test("/search/how-does-it-work-123"));
  assert.ok(adapter.conversationUrlPattern().test("/p/abc-456"));

  // Classification
  assert.equal(adapter.classifyConversationUrl("https://www.perplexity.ai/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://www.perplexity.ai/search"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://www.perplexity.ai/search/my-query-123"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://perplexity.ai/p/abc-456"), "restorable");

  // Invalid cases
  assert.equal(adapter.classifyConversationUrl("http://www.perplexity.ai/"), "invalid");
  assert.equal(adapter.classifyConversationUrl("https://other.com/search/123"), "invalid");
  assert.equal(adapter.classifyConversationUrl("invalid-url"), "invalid");
});

test("tracks Perplexity message identities and normalizes whitespace", async () => {
  const adapter = new PerplexityWebAdapter({ profileDir: "." });
  const messages = [
    new PerplexityMessage({ role: "user", text: "What\u00a0is\u00a0WTAgent?", id: "q-1" }),
    new PerplexityMessage({ role: "assistant", text: "WTAgent\u00a0is\u00a0awesome.", id: "a-1" }),
  ];
  adapter.page = createPerplexityPage({ messages });

  assert.equal(await adapter.userMessageText(messages[0]), "What is WTAgent?");
  assert.equal(await adapter.assistantText(messages[1]), "WTAgent is awesome.");

  const userId = await adapter.messageIdentity(messages[0]);
  assert.equal(userId.id, "q-1");
  assert.equal(userId.turn, 1);

  const assistantId = await adapter.messageIdentity(messages[1]);
  assert.equal(assistantId.id, "a-1");
  assert.equal(assistantId.turn, 1);
});

test("detects assistant generating state via stop button", async () => {
  const adapter = new PerplexityWebAdapter({ profileDir: "." });
  adapter.page = createPerplexityPage({ stopVisible: false });
  assert.equal(await adapter.isAssistantGenerating(), false);

  adapter.page = createPerplexityPage({ stopVisible: true });
  assert.equal(await adapter.isAssistantGenerating(), true);
});

test("declares reliable completion and dead request grace multiplier", () => {
  const adapter = new PerplexityWebAdapter({ profileDir: "." });
  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(adapter.deadRequestGraceMultiplier(), 3);
});
