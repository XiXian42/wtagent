import test from "node:test";
import assert from "node:assert/strict";
import { ChatGPTWebAdapter } from "../src/browser/chatgpt-web-adapter.js";

class EmptyLocator {
  async count() {
    return 0;
  }

  nth() {
    return this;
  }

  first() {
    return this;
  }

  last() {
    return this;
  }

  async isVisible() {
    return false;
  }

  async innerText() {
    return "";
  }

  async getAttribute() {
    return null;
  }

  locator() {
    return this;
  }
}

class VisibleLocator extends EmptyLocator {
  constructor(text = "") {
    super();
    this.text = text;
  }

  async count() {
    return 1;
  }

  async isVisible() {
    return true;
  }

  async innerText() {
    return this.text;
  }

  async click() {}
}

class AssistantMessage extends EmptyLocator {
  constructor(text) {
    super();
    this.text = text;
  }

  locator(selector) {
    if (selector === ".markdown") {
      return new VisibleLocator(this.text);
    }
    return new EmptyLocator();
  }

  async getAttribute(name) {
    return name === "data-message-id" ? "assistant-new" : null;
  }
}

class AssistantCollection extends EmptyLocator {
  constructor(message) {
    super();
    this.message = message;
  }

  async count() {
    return 1;
  }

  last() {
    return this.message;
  }
}

function createPage({
  title = "ChatGPT",
  assistantText = "",
  visibleSelectors = [],
} = {}) {
  const assistant = new AssistantMessage(assistantText);
  const visible = new Set(visibleSelectors);

  return {
    async title() {
      return title;
    },

    locator(selector) {
      if (selector === '[data-message-author-role="assistant"]') {
        return new AssistantCollection(assistant);
      }
      return visible.has(selector)
        ? new VisibleLocator()
        : new EmptyLocator();
    },

    getByRole() {
      return new EmptyLocator();
    },

    async waitForTimeout() {},
  };
}

test("normal chat and tool text cannot trigger blocked-page detection", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistantText: [
      "A tool result may discuss " + "Attention Required and Cloudflare.",
      "Documentation can say " + "verify you are human.",
      "Ordinary chat may contain " + "Just a moment.",
      "A browser reliability review can mention a security " + "check.",
      "<tool_result status=\"ok\">These are data, not page UI.</tool_result>",
    ].join("\n"),
  });

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 100,
    stableWindowMs: 0,
  });

  assert.match(result, /These are data, not page UI/);
});

test("visible challenge UI still triggers blocked-page detection", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    visibleSelectors: ['iframe[src*="challenges.cloudflare.com"]'],
  });

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 100,
      stableWindowMs: 0,
    }),
    /Browser access challenge detected/,
  );
});

function createConversationPage({
  initialUrl = "https://chatgpt.com/",
  keepExistingOnRoot = false,
  existingMessages = 0,
} = {}) {
  let currentUrl = initialUrl;
  let messageCount = existingMessages;
  const composer = new VisibleLocator();

  return {
    async goto(url) {
      if (url === "https://chatgpt.com/" && keepExistingOnRoot) {
        currentUrl = initialUrl;
        return;
      }
      currentUrl = url;
      messageCount = url.includes("/c/") ? existingMessages : 0;
    },
    url() {
      return currentUrl;
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return {
          async count() {
            return messageCount;
          },
        };
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };
}

test("accepts a verified empty conversation for a new session", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage();

  await adapter.startConversation();

  assert.equal(await adapter.getConversationUrl(), "https://chatgpt.com/");
});

test("rejects a new session when ChatGPT remains on an existing conversation", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: "https://chatgpt.com/c/existing",
    keepExistingOnRoot: true,
    existingMessages: 2,
  });
  adapter.debug = false;

  await assert.rejects(
    adapter.startConversation(),
    /verified empty conversation/,
  );
});

test("resume accepts the requested existing conversation", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({ existingMessages: 2 });

  await adapter.startConversation("https://chatgpt.com/c/existing");

  assert.equal(
    await adapter.getConversationUrl(),
    "https://chatgpt.com/c/existing",
  );
});
