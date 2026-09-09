import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchAndConnectCdpChrome } from "../src/browser/cdp-browser.js";
import { ChatGPTWebAdapter, isConnectionLostError } from "../src/browser/chatgpt-web-adapter.js";

test("ChatGPT leaves model selection entirely to the website/user", () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  assert.equal(typeof adapter.selectMode, "undefined");
});

test("classifies ChatGPT conversation URLs by restoration safety", () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });

  assert.equal(
    adapter.classifyConversationUrl("https://chatgpt.com/c/WEB:temporary"),
    "provisional",
  );
  assert.equal(
    adapter.classifyConversationUrl("https://chatgpt.com/c/canonical-id"),
    "restorable",
  );
  assert.equal(
    adapter.classifyConversationUrl("https://chatgpt.com/"),
    "fresh",
  );
  assert.equal(
    adapter.classifyConversationUrl("https://chatgpt.com/settings"),
    "unknown",
  );
  assert.equal(
    adapter.classifyConversationUrl("https://example.com/c/canonical-id"),
    "invalid",
  );
  assert.equal(
    adapter.classifyConversationUrl("http://chatgpt.com/c/canonical-id"),
    "invalid",
  );
  assert.equal(
    adapter.classifyConversationUrl("https://chatgpt.com:444/c/canonical-id"),
    "invalid",
  );
});

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

  getByRole() {
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

  async isEnabled() {
    return true;
  }

  async innerText() {
    return this.text;
  }

  async click() {}

  async fill() {}

  async focus() {}

  async press() {}
}

class AssistantMessage extends EmptyLocator {
  constructor(
    text,
    { id = "assistant-new", turn = null } = {},
  ) {
    super();
    this.text = text;
    this.id = id;
    this.turn = turn;
  }

  async innerText() {
    return this.text;
  }

  locator(selector) {
    if (selector === ".markdown") {
      return new VisibleLocator(this.text);
    }
    return new EmptyLocator();
  }

  async getAttribute(name) {
    return name === "data-message-id" ? this.id : null;
  }

  async evaluate() {
    return this.turn == null ? null : `conversation-turn-${this.turn}`;
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

class MessageCollection extends EmptyLocator {
  constructor(messages) {
    super();
    this.messages = messages;
  }

  async count() {
    return this.messages.length;
  }

  nth(index) {
    return this.messages[index] ?? new EmptyLocator();
  }

  last() {
    return this.messages.at(-1) ?? new EmptyLocator();
  }
}

class RichAssistantMessage extends AssistantMessage {
  constructor(text, codeBlocks, options = {}) {
    super(text, options);
    this.codeBlocks = codeBlocks;
  }

  locator(selector) {
    if (selector === "pre code") {
      return new MessageCollection(
        this.codeBlocks.map((text) => new VisibleLocator(text)),
      );
    }
    return super.locator(selector);
  }
}

function createPage({
  title = "ChatGPT",
  assistantText = "",
  assistant = null,
  visibleSelectors = [],
} = {}) {
  const message = assistant ?? new AssistantMessage(assistantText);
  const visible = new Set(visibleSelectors);

  return {
    async title() {
      return title;
    },

    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new AssistantCollection(message);
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

// Emits a sequence of `.markdown` snapshots, advancing one frame per read, to
// simulate ChatGPT streaming the reply. The last frame sticks.
class StreamingAssistantMessage extends EmptyLocator {
  constructor(frames) {
    super();
    this.frames = frames;
    this.index = 0;
  }

  locator(selector) {
    if (selector === ".markdown") {
      const self = this;
      return {
        async count() {
          return 1;
        },
        last() {
          return this;
        },
        async innerText() {
          const frame = self.frames[Math.min(self.index, self.frames.length - 1)];
          self.index += 1;
          return frame;
        },
      };
    }
    return new EmptyLocator();
  }

  async getAttribute(name) {
    return name === "data-message-id" ? "assistant-new" : null;
  }
}

test("ChatGPT atomic snapshots retain nested code-block envelopes", async () => {
  const envelope = "<agent_response><done>true</done><message>ok</message></agent_response>";
  const element = {
    id: "assistant-nested-code",
    innerText: "Here is the requested XML:",
    textContent: "Here is the requested XML:",
    getAttribute(name) {
      if (name === "data-message-author-role") return "assistant";
      if (name === "data-message-id") return this.id;
      return null;
    },
    closest() {
      return {
        getAttribute() {
          return "conversation-turn-2";
        },
      };
    },
    querySelectorAll(selector) {
      if (selector === "pre code") {
        return [{ innerText: envelope, textContent: envelope }];
      }
      return [];
    },
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {
    querySelectorAll() {
      return [element];
    },
  };
  globalThis.window = { location: { href: "https://chatgpt.com/c/nested" } };
  try {
    const adapter = new ChatGPTWebAdapter({ profileDir: "." });
    adapter.page = {
      async evaluate(callback) {
        return callback();
      },
    };
    const snapshot = await adapter.orderedConversationSnapshot();
    assert.equal(snapshot.entries[0].renderedText, envelope);
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

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

test("a localized challenge page with no composer is detected via body text", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  // The Chinese Cloudflare interstitial: a localized title (no English tokens)
  // and a body carrying the challenge text. No composer on the page.
  adapter.page = {
    async title() {
      return "请稍候…";
    },
    url() {
      return "https://chatgpt.com/";
    },
    locator() {
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
    async evaluate() {
      return "本网站使用安全服务防护恶意自动程序。安全验证";
    },
  };

  await assert.rejects(
    adapter.throwIfBlockedPage(),
    /Browser access challenge detected/,
  );
});

test("challenge words in a normal chat page never trigger a false block", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  // A real chat page has its composer, so even a body that mentions challenge
  // words (e.g. the model quoting one in a reply) is NOT treated as a block.
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    url() {
      return "https://chatgpt.com/";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return new VisibleLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
    async evaluate() {
      return "安全验证 请稍候";
    },
  };

  // Must resolve without throwing.
  await adapter.throwIfBlockedPage();
});

test("a logged-out /auth URL is unauthenticated regardless of UI language", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    url() {
      return "https://chatgpt.com/auth/login";
    },
    locator() {
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };

  assert.equal(await adapter.getAuthState(), "unauthenticated");
});

test("does not accept a protocol reply until its closing tag has streamed in", async () => {
  const truncated = "```xml\n<agent_response>\n  <done>false</done>\n  <tool_call name=\"terminal.exec\">\n    <args><program>./qsort</program>";
  const complete = `${truncated}</args>\n  </tool_call>\n</agent_response>\n\`\`\``;
  // First reads return the still-streaming, unclosed envelope; later reads
  // return the finished one. With stableWindowMs=0 the old code would have
  // accepted the truncated frame immediately.
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: new StreamingAssistantMessage([
      truncated, truncated, truncated, complete, complete,
    ]),
  });

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
  });

  // The accepted text must contain the complete envelope, not the truncated one.
  assert.match(result, /<\/agent_response>/);
  assert.match(result, /<\/tool_call>/);
});

test("accepts a complete long envelope split by nested Markdown code blocks", async () => {
  const fragmentedCodeBlock = [
    "<agent_response>",
    "  <done>true</done>",
    "  <message><![CDATA[The analysis includes:",
    "```js",
    "const accepted = true;",
  ].join("\n");
  const completeMessage = [
    "XML",
    fragmentedCodeBlock,
    "```",
    "and continues after many rendered code blocks.",
    "]]></message>",
    "</agent_response>",
  ].join("\n");
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: new RichAssistantMessage(
      completeMessage,
      [fragmentedCodeBlock, "const accepted = true;"],
    ),
  });

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 1_000,
    stableWindowMs: 0,
  });

  assert.match(result, /<\/agent_response>/);
  assert.match(result, /continues after many rendered code blocks/);
});

function createConversationPage({
  initialUrl = "https://chatgpt.com/",
  keepExistingOnRoot = false,
  existingMessages = 0,
  assistantIds = [],
  userIds = [],
  assistantIdFrames = null,
  userIdFrames = null,
  redirectUrls = {},
  urlFrames = [],
  messageCountFrames = [],
} = {}) {
  let currentUrl = initialUrl;
  let messageCount = existingMessages;
  let frame = 0;
  const gotoCalls = [];
  const navigationListeners = new Set();
  const composer = new VisibleLocator();
  const idsAtFrame = (frames, fallback) => (
    frames?.[Math.min(frame, frames.length - 1)] ?? fallback
  );
  const assistants = () => idsAtFrame(assistantIdFrames, assistantIds)
    .map((id, index) => new AssistantMessage(
      "",
      { id, turn: (index + 1) * 2 },
    ));
  const users = () => idsAtFrame(userIdFrames, userIds)
    .map((id, index) => new AssistantMessage(
      "",
      { id, turn: (index * 2) + 1 },
    ));
  const visibleUrl = () => (
    urlFrames[Math.min(frame, urlFrames.length - 1)] ?? currentUrl
  );
  const mainFrame = { url: visibleUrl };
  const emitNavigation = () => {
    for (const listener of navigationListeners) {
      listener(mainFrame);
    }
  };

  return {
    async goto(url) {
      gotoCalls.push(url);
      const before = visibleUrl();
      if (url === "https://chatgpt.com/" && keepExistingOnRoot) {
        currentUrl = initialUrl;
      } else {
        currentUrl = redirectUrls[url] ?? url;
        messageCount = currentUrl.includes("/c/") ? existingMessages : 0;
      }
      if (visibleUrl() !== before) {
        emitNavigation();
      }
    },
    url: visibleUrl,
    mainFrame() {
      return mainFrame;
    },
    on(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.add(listener);
      }
    },
    off(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.delete(listener);
      }
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(assistants());
      }
      if (selector === '[data-message-author-role="user"]') {
        return new MessageCollection(users());
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return {
          async count() {
            return messageCountFrames[
              Math.min(frame, messageCountFrames.length - 1)
            ] ?? messageCount;
          },
        };
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      const before = visibleUrl();
      frame += 1;
      if (visibleUrl() !== before) {
        emitNavigation();
      }
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    gotoCalls,
  };
}

function createPostSubmitNavigationPage({
  autoNavigateAfterSubmit = false,
  confirmUserImmediately = false,
  keepOriginalMarkerOnUnrelated = false,
  originalUrl = "https://chatgpt.com/c/original-send",
  unrelatedUrl = "https://chatgpt.com/c/unrelated-send",
  sentText = "hello",
} = {}) {
  const oldUser = new AssistantMessage("old request", {
    id: "user-old",
    turn: 1,
  });
  const oldAssistant = new AssistantMessage("old answer", {
    id: "assistant-old",
    turn: 2,
  });
  const sentUser = new AssistantMessage(sentText, {
    id: "user-sent",
    turn: 3,
  });
  const unrelatedUser = new AssistantMessage("hello", {
    id: "user-unrelated",
    turn: 9,
  });
  const unrelatedAssistant = new AssistantMessage(
    "<agent_response><done>false</done><tool_call name=\"fs.write\"><args/></tool_call></agent_response>",
    { id: "assistant-unrelated", turn: 10 },
  );
  const composer = new VisibleLocator();
  const sendButton = new VisibleLocator();
  let currentUrl = originalUrl;
  let submitted = false;
  let postSubmitWaits = 0;
  let navigateOnNextWait = false;
  const navigationListeners = new Set();
  let mainFrame = { url: () => currentUrl };
  sendButton.click = async () => {
    submitted = true;
  };

  const currentUsers = () => {
    if (currentUrl === unrelatedUrl) {
      return [unrelatedUser];
    }
    if (
      submitted
      && (confirmUserImmediately || postSubmitWaits > 0)
    ) {
      return [oldUser, sentUser];
    }
    return [oldUser];
  };
  const currentAssistants = () => currentUrl === unrelatedUrl
    ? [
      ...(keepOriginalMarkerOnUnrelated ? [oldAssistant] : []),
      unrelatedAssistant,
    ]
    : [oldAssistant];

  const page = {
    url() {
      return currentUrl;
    },
    async goto(url) {
      currentUrl = String(url);
    },
    async title() {
      return "ChatGPT";
    },
    mainFrame() {
      return mainFrame;
    },
    on(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.add(listener);
      }
    },
    off(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.delete(listener);
      }
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === '[data-testid="send-button"]') {
        return sendButton;
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(currentAssistants());
      }
      if (selector === '[data-message-author-role="user"]') {
        return new MessageCollection(currentUsers());
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return new MessageCollection([
          ...currentUsers(),
          ...currentAssistants(),
        ]);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      if (!submitted) {
        return;
      }
      const shouldNavigate = navigateOnNextWait
        || (autoNavigateAfterSubmit && postSubmitWaits === 0);
      postSubmitWaits += 1;
      if (!shouldNavigate || currentUrl === unrelatedUrl) {
        return;
      }
      navigateOnNextWait = false;
      currentUrl = unrelatedUrl;
      for (const listener of navigationListeners) {
        listener(mainFrame);
      }
    },
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };

  return {
    originalUrl,
    unrelatedUrl,
    page,
    navigateDuringNextWait() {
      navigateOnNextWait = true;
    },
    replaceMainFrame() {
      mainFrame = { url: () => currentUrl };
    },
  };
}

class VirtualSendClockChatGPTAdapter extends ChatGPTWebAdapter {
  sendConfirmationTimeoutMs() {
    return 1_000;
  }

  monotonicNow() {
    return this.virtualNow ?? 0;
  }

  async waitForPoll(ms) {
    this.virtualNow = this.monotonicNow() + ms;
    await this.page.waitForTimeout(ms);
  }
}

class ImmediateCorrelationChatGPTAdapter extends VirtualSendClockChatGPTAdapter {
  restorationCorrelationWindowMs() {
    return 0;
  }
}

class StructuralSendProofChatGPTAdapter extends VirtualSendClockChatGPTAdapter {
  sendConfirmationTimeoutMs() {
    return 10_000;
  }
}

function createFreshRebuildTransitionPage({ renderedText = "rebuild payload" } = {}) {
  const rootUrl = "https://chatgpt.com/";
  const provisionalUrl = "https://chatgpt.com/c/WEB:fresh-rebuild";
  const composer = new VisibleLocator();
  const sendButton = new VisibleLocator();
  const sentUser = new AssistantMessage(renderedText, {
    id: "user-rebuild",
    turn: 1,
  });
  const navigationListeners = new Set();
  let currentUrl = rootUrl;
  let submitted = false;
  let frame = 0;
  const mainFrame = { url: () => currentUrl };
  const emitNavigation = () => {
    for (const listener of navigationListeners) {
      listener(mainFrame);
    }
  };
  sendButton.click = async () => {
    submitted = true;
    frame = 0;
    currentUrl = provisionalUrl;
    emitNavigation();
  };
  const users = () => submitted && frame > 0 ? [sentUser] : [];

  return {
    rootUrl,
    provisionalUrl,
    page: {
      url() {
        return currentUrl;
      },
      async goto() {
        const changed = currentUrl !== rootUrl;
        currentUrl = rootUrl;
        if (changed) {
          emitNavigation();
        }
      },
      async title() {
        return "ChatGPT";
      },
      mainFrame() {
        return mainFrame;
      },
      on(event, listener) {
        if (event === "framenavigated") {
          navigationListeners.add(listener);
        }
      },
      off(event, listener) {
        if (event === "framenavigated") {
          navigationListeners.delete(listener);
        }
      },
      locator(selector) {
        if (selector === "#prompt-textarea") {
          return composer;
        }
        if (selector === '[data-testid="send-button"]') {
          return sendButton;
        }
        if (selector === '[data-message-author-role="user"]') {
          return new MessageCollection(users());
        }
        if (
          selector
          === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
        ) {
          return new MessageCollection(users());
        }
        return new EmptyLocator();
      },
      getByRole() {
        return new EmptyLocator();
      },
      async evaluate() {
        return {
          url: currentUrl,
          entries: users().map((message, domIndex) => ({
            domIndex,
            role: "user",
            id: message.id,
            turn: message.turn,
            renderedText: message.text,
          })),
        };
      },
      async waitForURL(predicate) {
        if (!predicate(new URL(currentUrl))) {
          throw new Error("conversation URL did not appear");
        }
      },
      async waitForTimeout() {
        if (submitted) {
          frame += 1;
        }
      },
      keyboard: {
        async press() {},
        async insertText() {},
      },
    },
  };
}

function createStructuralFreshSendPage({
  renderedText,
  assistantAtMs = 500,
  transformSnapshot = (entries) => entries,
} = {}) {
  const rootUrl = "https://chatgpt.com/";
  const provisionalUrl = "https://chatgpt.com/c/WEB:structural-send";
  const composer = new VisibleLocator();
  const sendButton = new VisibleLocator();
  const navigationListeners = new Set();
  let currentUrl = rootUrl;
  let mainFrame = { url: () => currentUrl };
  let submitted = false;
  let elapsedMs = 0;
  let snapshotRead = 0;
  let submitCount = 0;
  let waitForUrlCalls = 0;
  let waitHook = null;
  let assistantIdentity = {
    id: "assistant-structural",
    turn: 2,
  };

  const baseEntries = () => {
    if (!submitted) {
      return [];
    }
    const collapseText = snapshotRead % 2 === 0 ? "展开" : "展开\n收起";
    const entries = [{
      domIndex: 0,
      role: "user",
      id: "user-structural",
      turn: 1,
      renderedText: `${renderedText}\n${collapseText}`,
    }];
    if (elapsedMs >= assistantAtMs) {
      entries.push({
        domIndex: 1,
        role: "assistant",
        id: assistantIdentity.id,
        turn: assistantIdentity.turn,
        renderedText: "<agent_response><done>true</done></agent_response>",
      });
    }
    return entries;
  };
  const messagesForRole = (role) => baseEntries()
    .filter((entry) => entry.role === role)
    .map((entry) => new AssistantMessage(entry.renderedText, {
      id: entry.id,
      turn: entry.turn,
    }));
  const emitNavigation = () => {
    for (const listener of navigationListeners) {
      listener(mainFrame);
    }
  };
  sendButton.click = async () => {
    submitCount += 1;
    submitted = true;
    elapsedMs = 0;
    currentUrl = provisionalUrl;
    emitNavigation();
  };

  const page = {
    url() {
      return currentUrl;
    },
    async title() {
      return "ChatGPT";
    },
    mainFrame() {
      return mainFrame;
    },
    on(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.add(listener);
      }
    },
    off(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.delete(listener);
      }
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === '[data-testid="send-button"]') {
        return sendButton;
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(messagesForRole("assistant"));
      }
      if (selector === '[data-message-author-role="user"]') {
        return new MessageCollection(messagesForRole("user"));
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return new MessageCollection([
          ...messagesForRole("user"),
          ...messagesForRole("assistant"),
        ]);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async evaluate() {
      const entries = baseEntries().map((entry) => ({ ...entry }));
      const transformed = transformSnapshot(entries, {
        elapsedMs,
        snapshotRead,
      });
      snapshotRead += 1;
      return {
        url: currentUrl,
        entries: transformed,
      };
    },
    async waitForTimeout(ms = 0) {
      if (submitted) {
        elapsedMs += ms;
        waitHook?.({ elapsedMs, page });
      }
    },
    async waitForURL() {
      waitForUrlCalls += 1;
      throw new Error("send proof must not use a serial URL wait");
    },
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };

  return {
    rootUrl,
    provisionalUrl,
    page,
    setWaitHook(hook) {
      waitHook = hook;
    },
    setAssistantIdentity(id, turn = 2) {
      assistantIdentity = { id, turn };
    },
    replaceMainFrame() {
      mainFrame = { url: () => currentUrl };
    },
    setUrlWithoutNavigation(value) {
      currentUrl = value;
    },
    navigate(value) {
      currentUrl = value;
      emitNavigation();
    },
    get elapsedMs() {
      return elapsedMs;
    },
    get snapshotRead() {
      return snapshotRead;
    },
    get submitCount() {
      return submitCount;
    },
    get waitForUrlCalls() {
      return waitForUrlCalls;
    },
  };
}

function createHydratingCandidatePage() {
  const rootUrl = "https://chatgpt.com/";
  const candidateUrl = "https://chatgpt.com/c/existing-still-hydrating";
  const composer = new VisibleLocator();
  const sendButton = new VisibleLocator();
  const navigationListeners = new Set();
  const historicalUser = new AssistantMessage("old request", {
    id: "user-historical",
    turn: 1,
  });
  const historicalAssistant = new AssistantMessage("old answer", {
    id: "assistant-historical",
    turn: 2,
  });
  let currentUrl = rootUrl;
  let candidateFrame = 0;
  let submitCount = 0;
  const mainFrame = { url: () => currentUrl };
  sendButton.click = async () => {
    submitCount += 1;
  };
  const hydrated = () => currentUrl === candidateUrl && candidateFrame > 0;

  const page = {
    url() {
      return currentUrl;
    },
    async goto(url) {
      currentUrl = String(url);
    },
    async title() {
      return "ChatGPT";
    },
    mainFrame() {
      return mainFrame;
    },
    on(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.add(listener);
      }
    },
    off(event, listener) {
      if (event === "framenavigated") {
        navigationListeners.delete(listener);
      }
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === '[data-testid="send-button"]') {
        return sendButton;
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(hydrated() ? [historicalAssistant] : []);
      }
      if (selector === '[data-message-author-role="user"]') {
        return new MessageCollection(hydrated() ? [historicalUser] : []);
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return new MessageCollection(
          hydrated() ? [historicalUser, historicalAssistant] : [],
        );
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      if (currentUrl === candidateUrl) {
        candidateFrame += 1;
      }
    },
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };

  return {
    page,
    get submitCount() {
      return submitCount;
    },
    navigateCandidate() {
      currentUrl = candidateUrl;
      candidateFrame = 0;
      for (const listener of navigationListeners) {
        listener(mainFrame);
      }
    },
  };
}

test("refuses a same-origin route that is not a chat or explicit new-chat page", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage();

  await assert.rejects(
    adapter.startConversation("https://chatgpt.com/settings"),
    (error) => error.code === "UNKNOWN_CONVERSATION_URL",
  );
  assert.deepEqual(adapter.page.gotoCalls, []);
});

test("launch preserves an exact live provisional ChatGPT tab", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:live-tab";
  const page = createConversationPage({
    initialUrl: provisionalUrl,
    existingMessages: 1,
  });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  let launchOptions;
  adapter.launchCdpChrome = async (options) => {
    launchOptions = options;
    return {
      context: {},
      page,
      preferredTabMatched: true,
    };
  };

  await adapter.launch(provisionalUrl);
  const restoration = await adapter.startConversation(provisionalUrl);

  assert.equal(launchOptions.preferredUrl, provisionalUrl);
  assert.deepEqual(page.gotoCalls, []);
  assert.deepEqual(restoration, {
    status: "restored-existing",
    conversationUrl: provisionalUrl,
  });
});

test("an unmatched provisional URL opens a verified fresh page without navigating to it", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:expired";
  const page = createConversationPage({ initialUrl: "about:blank" });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTabMatched: false,
  });

  await adapter.launch(provisionalUrl);
  const restoration = await adapter.startConversation(provisionalUrl);

  assert.deepEqual(page.gotoCalls, ["https://chatgpt.com/"]);
  assert.equal(page.gotoCalls.includes(provisionalUrl), false);
  assert.deepEqual(restoration, {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  });
});

const freshSendTestId = "11111111-1111-4111-8111-111111111111";
const oldSendTestId = "22222222-2222-4222-8222-222222222222";
const freshSendTestMarker = (id) =>
  `Opaque WTAgent transport correlation ID (do not repeat): ${id}.`;
const freshSendTestPayload = (id) =>
  "Read `src/slugify.js` and inspect the tests.\n" +
  `<system_reminder>Use XML. ${freshSendTestMarker(id)}</system_reminder>`;
const freshSendTestRendered = (value) => value.replaceAll("`", "") + "\n展开";

async function prepareFreshRenderedSend(renderedText) {
  const fixture = createFreshRebuildTransitionPage({ renderedText });
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  const restoration = await adapter.startConversation(fixture.rootUrl);
  assert.equal(restoration.status, "verified-fresh");
  return { adapter, fixture };
}

for (const markdown of [false, true]) {
  test(`fresh send correlation confirms ${markdown ? "Markdown-rendered" : "literal"} payload`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const rendered = markdown ? freshSendTestRendered(expected) : expected;
    const { adapter, fixture } = await prepareFreshRenderedSend(rendered);
    const sent = await adapter.sendMessage(expected);
    assert.equal(adapter.getLastSendStatus(), "confirmed");
    assert.equal(sent.userMessageId, "user-rebuild");
    assert.equal((await adapter.getConversationIdentity()).conversationUrl,
      fixture.provisionalUrl);
  });
}

for (const [name, transform] of [
  ["wrong identifier", (text) => text.replaceAll(freshSendTestId, oldSendTestId)],
  ["missing identifier", (text) => text.replace(freshSendTestMarker(freshSendTestId), "")],
  ["extended identifier", (text) => text.replace(freshSendTestId, freshSendTestId + "0")],
  ["missing reminder boundary", (text) => text.replace("</system_reminder>", "")],
  ["non-final reminder marker", (text) => text
    + "\n<system_reminder>Different final reminder.</system_reminder>"],
  ["duplicate current marker", (text) => text + "\n" + text],
]) {
  test(`fresh send correlation rejects ${name}`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const rendered = transform(freshSendTestRendered(expected));
    const { adapter } = await prepareFreshRenderedSend(rendered);
    await assert.rejects(adapter.sendMessage(expected),
      (error) => error.code === "SEND_COMMIT_UNKNOWN");
    assert.equal(adapter.getLastSendStatus(), "commit-unknown");
  });
}

test("fresh send correlation does not normalize unmarked messages loosely", async () => {
  const { adapter } = await prepareFreshRenderedSend("Read src/slugify.js");
  await assert.rejects(adapter.sendMessage("Read `src/slugify.js`"),
    (error) => error.code === "SEND_COMMIT_UNKNOWN");
});

test("fresh send correlation ignores an older marker quoted in the request", async () => {
  const expected = "Earlier reference: " + freshSendTestMarker(oldSendTestId) +
    "\n" + freshSendTestPayload(freshSendTestId);
  const rendered = freshSendTestRendered(expected)
    .replace(freshSendTestMarker(freshSendTestId), "");
  const { adapter } = await prepareFreshRenderedSend(rendered);
  await assert.rejects(adapter.sendMessage(expected),
    (error) => error.code === "SEND_COMMIT_UNKNOWN");
  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
});

test("fresh structural proof ignores long-message controls and assistant arrival", async () => {
  const expected = `${"Inspect the repository carefully.\n".repeat(280)}`
    + `<system_reminder>Use XML. ${freshSendTestMarker(freshSendTestId)}</system_reminder>`;
  assert.ok(Buffer.byteLength(expected, "utf8") > 8_000);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected.replaceAll("`", ""),
    assistantAtMs: 500,
  });
  const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.cdpChrome = { targetId: "target-structural" };
  await adapter.startConversation();

  const sent = await adapter.sendMessage(expected, {
    outboundId: freshSendTestId,
  });

  assert.equal(sent.userMessageId, "user-structural");
  assert.equal(adapter.getLastSendStatus(), "confirmed");
  assert.equal(fixture.submitCount, 1);
  assert.equal(fixture.waitForUrlCalls, 0);
  assert.ok(fixture.elapsedMs >= adapter.restorationCorrelationWindowMs());
  assert.ok(fixture.elapsedMs < adapter.sendConfirmationTimeoutMs());
  assert.ok(fixture.snapshotRead > 10);
});

for (const timing of ["before DOM read", "after DOM read", "final DOM read"]) {
  test(`fresh send retries a canonical transition ${timing}`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const fixture = createStructuralFreshSendPage({ renderedText: expected });
    const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.cdpChrome = { targetId: "target-structural" };
    await adapter.startConversation();
    const snapshot = adapter.orderedConversationSnapshot.bind(adapter);
    const canonicalUrl = "https://chatgpt.com/c/canonical-during-dom-read";
    let navigatedAt = null;
    let previousReadAt = null;
    adapter.orderedConversationSnapshot = async () => {
      const shouldNavigate = navigatedAt == null
        && fixture.elapsedMs >= 300
        && (timing !== "final DOM read" || previousReadAt === fixture.elapsedMs);
      previousReadAt = fixture.elapsedMs;
      const navigate = () => {
        navigatedAt = fixture.elapsedMs;
        fixture.navigate(canonicalUrl);
      };
      if (shouldNavigate && timing !== "after DOM read") navigate();
      const result = await snapshot();
      if (shouldNavigate && timing === "after DOM read") navigate();
      return result;
    };

    const sent = await adapter.sendMessage(expected, { outboundId: freshSendTestId });

    assert.notEqual(navigatedAt, null);
    assert.ok(fixture.elapsedMs - navigatedAt >= adapter.restorationCorrelationWindowMs());
    assert.equal(sent.conversationUrl, canonicalUrl);
    assert.equal(sent.userMessageId, "user-structural");
    assert.equal(adapter.getLastSendStatus(), "confirmed");
    assert.equal(fixture.submitCount, 1);
  });
}

for (const mutation of ["different user", "missing nonce", "different target", "unrelated navigation"]) {
  test(`fresh send rejects ${mutation} during its DOM read`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    let mutated = false;
    const fixture = createStructuralFreshSendPage({
      renderedText: expected,
      transformSnapshot(entries) {
        if (mutated && entries[0]) {
          if (mutation === "different user") entries[0].id = "user-substitute";
          if (mutation === "missing nonce") {
            entries[0].renderedText = entries[0].renderedText.replace(freshSendTestId, oldSendTestId);
          }
        }
        return entries;
      },
    });
    const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.cdpChrome = { targetId: "target-structural" };
    await adapter.startConversation();
    const snapshot = adapter.orderedConversationSnapshot.bind(adapter);
    adapter.orderedConversationSnapshot = async () => {
      if (!mutated && fixture.elapsedMs >= 300) {
        mutated = true;
        fixture.navigate("https://chatgpt.com/c/canonical-during-dom-read");
        if (mutation === "different target") adapter.cdpChrome.targetId = "target-substitute";
        if (mutation === "unrelated navigation") {
          fixture.navigate("https://chatgpt.com/c/unrelated");
        }
      }
      return await snapshot();
    };

    await assert.rejects(adapter.sendMessage(expected, { outboundId: freshSendTestId }),
      (error) => error.code === "SEND_COMMIT_UNKNOWN");
    assert.equal(mutated, true);
    assert.equal(adapter.getLastSendStatus(), "commit-unknown");
    assert.equal(fixture.submitCount, 1);
  });
}

async function prepareConfirmedProvisionalTurn() {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 8_000,
  });
  const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.cdpChrome = { targetId: "target-structural" };
  // Both send polling and reply polling advance the same monotonic clock.
  adapter.monotonicNow = () => fixture.elapsedMs;
  await adapter.startConversation();
  await adapter.sendMessage(expected, { outboundId: freshSendTestId });
  assert.equal(adapter.getLastSendStatus(), "confirmed");
  assert.equal((await adapter.getConversationIdentity()).conversationUrl,
    fixture.provisionalUrl);
  return { adapter, fixture };
}

for (const timing of ["before waiting", "during generation"]) {
  test(`a confirmed provisional turn correlates its canonical URL ${timing}`, async () => {
    const { adapter, fixture } = await prepareConfirmedProvisionalTurn();
    const canonicalUrl = "https://chatgpt.com/c/confirmed-canonical";
    let navigatedAt = null;
    const navigate = () => {
      if (navigatedAt != null) return;
      navigatedAt = fixture.elapsedMs;
      fixture.navigate(canonicalUrl);
    };
    if (timing === "before waiting") {
      navigate();
    } else {
      fixture.setWaitHook(navigate);
    }
    const deltas = [];

    const result = await adapter.waitForTurnComplete({
      timeoutMs: 2_000,
      stableWindowMs: 0,
      onDelta(delta) {
        assert.notEqual(navigatedAt, null);
        assert.ok(fixture.elapsedMs - navigatedAt
          >= adapter.restorationCorrelationWindowMs());
        deltas.push(delta);
      },
    });

    assert.match(result, /<done>true<\/done>/);
    assert.equal(deltas.join(""), result);
    assert.equal((await adapter.getConversationIdentity()).conversationUrl,
      canonicalUrl);
    assert.equal(await adapter.getLastAssistantMessageId(), "assistant-structural");
    assert.equal(fixture.submitCount, 1);
  });
}

for (const marker of ["missing", "transient"]) {
  test(`a confirmed turn rejects a canonical candidate with a ${marker} user marker`, async () => {
    const { adapter, fixture } = await prepareConfirmedProvisionalTurn();
    const navigatedAt = fixture.elapsedMs;
    const locator = fixture.page.locator.bind(fixture.page);
    fixture.page.locator = (selector) => {
      if (selector === '[data-message-author-role="user"]'
        && (marker === "missing" || fixture.elapsedMs - navigatedAt >= 250)) {
        return new EmptyLocator();
      }
      return locator(selector);
    };
    fixture.navigate("https://chatgpt.com/c/unverified-canonical");
    const deltas = [];

    await assert.rejects(adapter.waitForTurnComplete({
      timeoutMs: 2_000,
      stableWindowMs: 0,
      onDelta: (delta) => deltas.push(delta),
    }), (error) => error.code === "CONVERSATION_CHANGED_DURING_TURN"
      && /could not correlate/.test(error.message));
    assert.deepEqual(deltas, []);
    assert.equal((await adapter.getConversationIdentity()).conversationUrl,
      fixture.provisionalUrl);
    assert.equal(await adapter.getLastAssistantMessageId(), null);
  });
}

for (const mutation of ["page", "frame", "target", "silent URL", "second navigation"]) {
  test(`a confirmed turn rejects ${mutation} substitution during canonicalization`, async () => {
    const { adapter, fixture } = await prepareConfirmedProvisionalTurn();
    const canonicalUrl = "https://chatgpt.com/c/canonical-substitute";
    if (mutation === "silent URL") {
      fixture.setUrlWithoutNavigation(canonicalUrl);
    } else {
      fixture.navigate(canonicalUrl);
      if (mutation === "page") adapter.page = { ...fixture.page };
      if (mutation === "frame") fixture.replaceMainFrame();
      if (mutation === "target") adapter.cdpChrome.targetId = "another-target";
      if (mutation === "second navigation") {
        fixture.navigate("https://chatgpt.com/c/another-conversation");
      }
    }
    const deltas = [];

    await assert.rejects(adapter.waitForTurnComplete({
      timeoutMs: 2_000,
      stableWindowMs: 0,
      onDelta: (delta) => deltas.push(delta),
    }), (error) => error.code === "CONVERSATION_CHANGED_DURING_TURN");
    assert.deepEqual(deltas, []);
    assert.equal(await adapter.getLastAssistantMessageId(), null);
  });
}

test("a hanging submit cannot outlive the send confirmation deadline", async () => {
  class HangingSubmitAdapter extends ImmediateCorrelationChatGPTAdapter {
    sendConfirmationTimeoutMs() {
      return 25;
    }
  }
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createFreshRebuildTransitionPage({ renderedText: expected });
  const adapter = new HangingSubmitAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.submitComposer = async () => await new Promise(() => {});
  await adapter.startConversation();
  const startedAt = Date.now();

  await assert.rejects(
    adapter.sendMessage(expected, { outboundId: freshSendTestId }),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
});

test("a DOM sample crossing the monotonic deadline cannot confirm a send", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  let adapter;
  let crossedDeadline = false;
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
    transformSnapshot(entries) {
      if (entries.length > 0 && !crossedDeadline) {
        crossedDeadline = true;
        adapter.virtualNow = adapter.sendConfirmationTimeoutMs();
      }
      return entries;
    },
  });
  adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.cdpChrome = { targetId: "target-structural" };
  await adapter.startConversation();

  await assert.rejects(
    adapter.sendMessage(expected, { outboundId: freshSendTestId }),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );
  assert.equal(crossedDeadline, true);
  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
});

test("a partially mounted assistant does not reset fresh user stability", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 500,
    transformSnapshot(entries, { elapsedMs }) {
      if (elapsedMs >= 500 && elapsedMs < 900 && entries[1]) {
        entries[1].id = null;
      }
      return entries;
    },
  });
  const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.cdpChrome = { targetId: "target-structural" };
  await adapter.startConversation();

  await adapter.sendMessage(expected, { outboundId: freshSendTestId });

  assert.ok(fixture.elapsedMs >= adapter.restorationCorrelationWindowMs());
  assert.ok(
    fixture.elapsedMs < adapter.restorationCorrelationWindowMs() + 500,
    "assistant insertion must not restart the correlated user timer",
  );
});

for (const [name, transformSnapshot] of [
  ["user id changes", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries[0]) entries[0].id = "user-changed";
    return entries;
  }],
  ["user turn changes", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries[0]) entries[0].turn = 3;
    return entries;
  }],
  ["correlation marker disappears", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries[0]) {
      entries[0].renderedText = entries[0].renderedText
        .replaceAll(freshSendTestId, oldSendTestId);
    }
    return entries;
  }],
  ["historical prefix appears", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries.length > 0) {
      entries.unshift({
        domIndex: 0,
        role: "user",
        id: "user-historical",
        turn: 0,
        renderedText: "historical request",
      });
      entries.forEach((entry, domIndex) => {
        entry.domIndex = domIndex;
      });
    }
    return entries;
  }],
  ["later user appears", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries.length > 0) {
      entries.push({
        domIndex: entries.length,
        role: "user",
        id: "user-later",
        turn: 3,
        renderedText: "later request",
      });
    }
    return entries;
  }],
  ["ordered ids become ambiguous", (entries, { elapsedMs }) => {
    if (elapsedMs >= 300 && entries.length > 0) {
      entries.push({
        domIndex: entries.length,
        role: "assistant",
        id: entries[0].id,
        turn: 2,
        renderedText: "duplicate identity",
      });
    }
    return entries;
  }],
]) {
  test(`fresh structural proof fails closed when ${name}`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const fixture = createStructuralFreshSendPage({
      renderedText: expected,
      assistantAtMs: Number.POSITIVE_INFINITY,
      transformSnapshot,
    });
    const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.cdpChrome = { targetId: "target-structural" };
    await adapter.startConversation();

    await assert.rejects(
      adapter.sendMessage(expected, { outboundId: freshSendTestId }),
      (error) => error.code === "SEND_COMMIT_UNKNOWN",
    );
    assert.equal(fixture.submitCount, 1);
    assert.equal(adapter.getLastSendStatus(), "commit-unknown");
  });
}

for (const mutation of ["url", "frame", "target"]) {
  test(`fresh structural proof rejects ${mutation} substitution`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const fixture = createStructuralFreshSendPage({
      renderedText: expected,
      assistantAtMs: Number.POSITIVE_INFINITY,
    });
    const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.cdpChrome = { targetId: "target-structural" };
    let mutated = false;
    fixture.setWaitHook(({ elapsedMs }) => {
      if (mutated || elapsedMs < 300) return;
      mutated = true;
      if (mutation === "url") {
        fixture.setUrlWithoutNavigation("https://chatgpt.com/c/silent-substitute");
      } else if (mutation === "frame") {
        fixture.replaceMainFrame();
      } else {
        adapter.cdpChrome.targetId = "target-substitute";
      }
    });
    await adapter.startConversation();

    await assert.rejects(
      adapter.sendMessage(expected, { outboundId: freshSendTestId }),
      (error) => error.code === "SEND_COMMIT_UNKNOWN",
    );
    assert.equal(mutated, true);
    assert.equal(fixture.submitCount, 1);
  });
}

test("launchRecoveryTarget configures only the exact existing page", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  const gotoCalls = [];
  const page = {
    url() {
      return "https://chatgpt.com/c/recovery-target";
    },
    async goto(url) {
      gotoCalls.push(url);
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
  };
  let launchOptions;
  adapter.launchCdpChrome = async (options) => {
    launchOptions = options;
    return {
      context: {},
      page,
      targetId: "target-recovery",
      preferredTargetMatched: true,
      exactTargetOnly: true,
    };
  };

  const attached = await adapter.launchRecoveryTarget("target-recovery");

  assert.deepEqual(attached, {
    conversationUrl: "https://chatgpt.com/c/recovery-target",
    targetId: "target-recovery",
  });
  assert.equal(launchOptions.exactTargetOnly, true);
  assert.equal(launchOptions.preferredTargetId, "target-recovery");
  assert.deepEqual(gotoCalls, []);
});

test("same-process recovery detaches a normal connection before strict reattachment", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  const page = {
    url: () => "https://chatgpt.com/c/same-process",
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
  };
  let normalDetached = 0;
  let normalClosed = 0;
  let strictClosed = 0;
  adapter.context = {};
  adapter.page = page;
  adapter.cdpChrome = {
    targetId: "target-same-process",
    exactTargetOnly: false,
    async detach() {
      normalDetached += 1;
    },
    async close() {
      normalClosed += 1;
    },
  };
  let launchOptions;
  adapter.launchCdpChrome = async (options) => {
    launchOptions = options;
    return {
      context: {},
      page,
      targetId: "target-same-process",
      preferredTargetMatched: true,
      exactTargetOnly: true,
      async close() {
        strictClosed += 1;
      },
    };
  };

  await adapter.launchRecoveryTarget("target-same-process");

  assert.equal(normalDetached, 1);
  assert.equal(normalClosed, 0);
  assert.equal(launchOptions.exactTargetOnly, true);
  assert.equal(adapter.hasExactRecoveryTarget("target-same-process"), true);
  await adapter.close();
  assert.equal(strictClosed, 1);
  assert.equal(normalClosed, 0);
});

test("a normal same-target connection cannot reconcile without strict reattachment", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: false,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "RECOVERY_TARGET_UNAVAILABLE",
  );
});

test("reconciles a completed bootstrap on the exact live target without sending", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
      status: "commit-unknown",
    },
    conversationTargetId: "target-recovery",
  });

  assert.equal(recovered.status, "complete");
  assert.equal(recovered.conversationUrl, fixture.provisionalUrl);
  assert.equal(recovered.userMessageId, "user-structural");
  assert.equal(recovered.userTurn, 1);
  assert.equal(recovered.assistantMessageId, "assistant-structural");
  assert.equal(recovered.assistantTurn, 2);
  assert.match(recovered.rawResponse, /<agent_response>/);
  assert.match(recovered.responseHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(recovered.assistantBaseline.ids, []);
  assert.equal(fixture.submitCount, 1);
  assert.equal(adapter.getLastSendStatus(), "not-submitted");
});

test("completed reconciliation revalidates its final atomic assistant boundary", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
    transformSnapshot(entries, { snapshotRead }) {
      if (snapshotRead > 0 && entries[1]) {
        entries[1].id = "assistant-replacement";
        entries.push({
          domIndex: entries.length,
          role: "user",
          id: "user-interleaved",
          turn: 3,
          renderedText: "manual follow-up",
        });
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.notEqual(
    await adapter.getLastAssistantMessageId(),
    "assistant-replacement",
  );
});

test("reconciles a committed outbound that is still waiting for its assistant", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });

  assert.equal(recovered.status, "waiting");
  assert.equal("rawResponse" in recovered, false);
  assert.equal(recovered.userMessageId, "user-structural");
  assert.equal(fixture.submitCount, 1);
});

test("existing-conversation reconciliation requires its saved prefix marker", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
    transformSnapshot(entries) {
      if (entries.length > 0) {
        entries.unshift({
          domIndex: 0,
          role: "assistant",
          id: "assistant-before-outbound",
          turn: 0,
          renderedText: "previous answer",
        });
        entries.forEach((entry, domIndex) => {
          entry.domIndex = domIndex;
        });
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "follow_up",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
    lastAssistantMessageId: "assistant-before-outbound",
  });
  assert.equal(recovered.status, "complete");
  assert.deepEqual(
    recovered.preOutboundMarkerIds,
    ["assistant-before-outbound"],
  );

  const missingMarkerAdapter = new ImmediateCorrelationChatGPTAdapter({
    profileDir: ".",
  });
  missingMarkerAdapter.page = fixture.page;
  missingMarkerAdapter.context = {};
  missingMarkerAdapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  await assert.rejects(
    missingMarkerAdapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "follow_up",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
      lastAssistantMessageId: "assistant-missing",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
});

for (const ambiguity of ["history", "later-user", "wrong-target"]) {
  test(`pending outbound reconciliation rejects ${ambiguity}`, async () => {
    const expected = freshSendTestPayload(freshSendTestId);
    const fixture = createStructuralFreshSendPage({
      renderedText: expected,
      assistantAtMs: Number.POSITIVE_INFINITY,
      transformSnapshot(entries) {
        if (ambiguity === "history" && entries.length > 0) {
          entries.unshift({
            domIndex: 0,
            role: "assistant",
            id: "assistant-history",
            turn: 0,
            renderedText: "history",
          });
        } else if (ambiguity === "later-user" && entries.length > 0) {
          entries.push({
            domIndex: entries.length,
            role: "user",
            id: "user-later",
            turn: 3,
            renderedText: "later",
          });
        }
        entries.forEach((entry, domIndex) => {
          entry.domIndex = domIndex;
        });
        return entries;
      },
    });
    await fixture.page.locator('[data-testid="send-button"]').click();
    const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.context = {};
    adapter.cdpChrome = {
      targetId: "target-recovery",
      exactTargetOnly: true,
    };

    await assert.rejects(
      adapter.reconcilePendingOutbound({
        pendingOutbound: {
          kind: "bootstrap",
          outboundId: freshSendTestId,
        },
        conversationTargetId: ambiguity === "wrong-target"
          ? "target-other"
          : "target-recovery",
      }),
      (error) => [
        "OUTBOUND_COMMIT_UNCERTAIN",
        "RECOVERY_TARGET_UNAVAILABLE",
      ].includes(error.code),
    );
    assert.equal(fixture.submitCount, 1);
  });
}

test("pending outbound reconciliation rejects navigation during stability", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new StructuralSendProofChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  let navigated = false;
  fixture.setWaitHook(({ elapsedMs }) => {
    if (!navigated && elapsedMs >= 300) {
      navigated = true;
      fixture.navigate("https://chatgpt.com/c/navigated-during-recovery");
    }
  });

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.equal(navigated, true);
  assert.equal(fixture.submitCount, 1);
});

test("recovery keeps a retryable generation-failure card pending", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  adapter.findGenerationErrorMarker = async () => "Internal Server Error";

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });

  assert.equal(recovered.status, "waiting");
  assert.equal(recovered.assistantCandidateMessageId, "assistant-structural");
  assert.equal("rawResponse" in recovered, false);
});

test("a recovered waiting assistant cannot be replaced before turn processing", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  let generating = true;
  adapter.isAssistantGenerating = async () => generating;

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });
  assert.equal(recovered.status, "waiting");
  assert.equal(
    recovered.assistantCandidateMessageId,
    "assistant-structural",
  );

  generating = false;
  fixture.setAssistantIdentity("assistant-replacement", 2);
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 100,
      stableWindowMs: 0,
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.notEqual(
    await adapter.getLastAssistantMessageId(),
    "assistant-replacement",
  );
});

test("a recovered waiting turn follows a verified canonical URL promotion", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  let generating = true;
  adapter.isAssistantGenerating = async () => generating;

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });
  assert.equal(recovered.status, "waiting");

  generating = false;
  fixture.navigate("https://chatgpt.com/c/canonical-after-recovery");
  const response = await adapter.waitForTurnComplete({
    timeoutMs: 1_000,
    stableWindowMs: 0,
  });
  assert.match(response, /<agent_response>/);
  assert.equal(
    (await adapter.getConversationIdentity()).conversationUrl,
    "https://chatgpt.com/c/canonical-after-recovery",
  );
});

test("recovered waiting ignores the historical assistant before its user boundary", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
    transformSnapshot(entries) {
      if (entries.length > 0) {
        entries.unshift({
          domIndex: 0,
          role: "assistant",
          id: "assistant-history",
          turn: 0,
          renderedText: "previous reply",
        });
        entries.forEach((entry, domIndex) => {
          entry.domIndex = domIndex;
        });
      }
      return entries;
    },
  });
  const originalLocator = fixture.page.locator.bind(fixture.page);
  fixture.page.locator = (selector) => {
    if (
      selector.includes('[data-message-author-role="assistant"]')
      && !selector.includes('[data-message-author-role="user"]')
    ) {
      return new MessageCollection([
        new AssistantMessage("previous reply", {
          id: "assistant-history",
          turn: 0,
        }),
      ]);
    }
    return originalLocator(selector);
  };
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "follow_up",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
    lastAssistantMessageId: "assistant-history",
  });
  assert.equal(recovered.status, "waiting");

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 100,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "DEAD_ASSISTANT_REQUEST",
  );
});

test("a later user turn invalidates a recovered assistant before it is accepted", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  let laterUserVisible = false;
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
    transformSnapshot(entries) {
      if (laterUserVisible && entries.length > 0) {
        entries.push({
          domIndex: entries.length,
          role: "user",
          id: "user-interleaved",
          turn: 3,
          renderedText: "manual follow-up",
        });
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };
  let generating = true;
  adapter.isAssistantGenerating = async () => generating;

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });
  assert.equal(recovered.status, "waiting");
  assert.equal(recovered.assistantCandidateMessageId, "assistant-structural");

  generating = false;
  laterUserVisible = true;
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 100,
      stableWindowMs: 0,
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.notEqual(
    await adapter.getLastAssistantMessageId(),
    "assistant-structural",
  );
});

test("fresh recovery requires ChatGPT's first user-turn invariant", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
    transformSnapshot(entries) {
      if (entries[0]) {
        entries[0].turn = 3;
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
});

test("fresh recovery rejects a discontinuous assistant successor turn", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: 0,
    transformSnapshot(entries) {
      if (entries[1]) {
        entries[1].turn = 4;
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
});

test("recovery never drops a persisted waiting assistant identity", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      priorHandoff: {
        sourceOutboundId: freshSendTestId,
        outboundKind: "bootstrap",
        status: "waiting",
        userMessageId: "user-structural",
        userTurn: 1,
        assistantCandidateMessageId: "assistant-persisted",
        assistantCandidateTurn: 2,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
});

test("recovery stability excludes time spent on an invalid DOM sample", async () => {
  class RecoveryStabilityAdapter extends VirtualSendClockChatGPTAdapter {
    sendConfirmationTimeoutMs() {
      return 500;
    }

    restorationCorrelationWindowMs() {
      return 150;
    }
  }
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
    transformSnapshot(entries, { snapshotRead }) {
      return snapshotRead === 1 ? null : entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  const adapter = new RecoveryStabilityAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  const recovered = await adapter.reconcilePendingOutbound({
    pendingOutbound: {
      kind: "bootstrap",
      outboundId: freshSendTestId,
    },
    conversationTargetId: "target-recovery",
  });

  assert.equal(recovered.status, "waiting");
  assert.ok(adapter.virtualNow >= 350);
});

test("a recovery DOM read that crosses its deadline cannot be accepted", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  let adapter;
  let crossedDeadline = false;
  const fixture = createStructuralFreshSendPage({
    renderedText: expected,
    assistantAtMs: Number.POSITIVE_INFINITY,
    transformSnapshot(entries) {
      if (entries.length > 0 && !crossedDeadline) {
        crossedDeadline = true;
        adapter.virtualNow = adapter.sendConfirmationTimeoutMs();
      }
      return entries;
    },
  });
  await fixture.page.locator('[data-testid="send-button"]').click();
  adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.context = {};
  adapter.cdpChrome = {
    targetId: "target-recovery",
    exactTargetOnly: true,
  };

  await assert.rejects(
    adapter.reconcilePendingOutbound({
      pendingOutbound: {
        kind: "bootstrap",
        outboundId: freshSendTestId,
      },
      conversationTargetId: "target-recovery",
    }),
    (error) => error.code === "OUTBOUND_COMMIT_UNCERTAIN",
  );
  assert.equal(crossedDeadline, true);
});

test("a verified-fresh rebuild clears old markers before its URL transition", async () => {
  const savedUrl = "https://chatgpt.com/c/expired-rebuild";
  const fixture = createFreshRebuildTransitionPage();
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;

  const restoration = await adapter.startConversation(savedUrl, {
    expectedUserMessageId: "user-from-expired-conversation",
  });
  assert.deepEqual(restoration, {
    status: "verified-fresh",
    conversationUrl: fixture.rootUrl,
  });

  const sent = await adapter.sendMessage("rebuild payload");

  assert.equal(adapter.getLastSendStatus(), "confirmed");
  assert.equal(sent.userMessageId, "user-rebuild");
  const identity = await adapter.getConversationIdentity();
  assert.equal(identity.conversationUrl, fixture.provisionalUrl);
});

test("an unresolved provisional URL fails closed while another conversation tab exists", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:lost";
  const page = createConversationPage({ initialUrl: "about:blank" });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTabMatched: false,
    existingPageUrls: ["https://chatgpt.com/c/possible-canonical"],
  });

  await assert.rejects(
    adapter.launch(provisionalUrl),
    (error) => error.code === "CONVERSATION_TAB_AMBIGUOUS",
  );
  assert.deepEqual(page.gotoCalls, []);
});

test("a saved fresh target is not erased after it becomes a marked canonical chat", async () => {
  const canonicalUrl = "https://chatgpt.com/c/late-canonical";
  const page = createConversationPage({
    initialUrl: canonicalUrl,
    existingMessages: 2,
    assistantIds: ["assistant-late"],
  });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTargetMatched: true,
    targetId: "target-late",
  });

  await adapter.launch("https://chatgpt.com/", {
    preferredTargetId: "target-late",
  });
  const restoration = await adapter.startConversation("https://chatgpt.com/", {
    expectedAssistantMessageId: "assistant-late",
  });

  assert.deepEqual(page.gotoCalls, []);
  assert.deepEqual(restoration, {
    status: "restored-existing",
    conversationUrl: canonicalUrl,
    targetId: "target-late",
  });
});

test("a target-matched provisional tab requires its saved marker after an unobserved canonicalization", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:canonicalizing";
  const canonicalUrl = "https://chatgpt.com/c/canonical-id";
  const page = createConversationPage({
    initialUrl: canonicalUrl,
    existingMessages: 1,
    assistantIds: ["assistant-existing"],
  });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTargetMatched: true,
    targetId: "target-existing",
  });

  await adapter.launch(provisionalUrl, {
    preferredTargetId: "target-existing",
  });
  const restoration = await adapter.startConversation(provisionalUrl, {
    expectedAssistantMessageId: "assistant-existing",
  });

  assert.deepEqual(page.gotoCalls, []);
  assert.deepEqual(restoration, {
    status: "restored-existing",
    conversationUrl: canonicalUrl,
    targetId: "target-existing",
  });
});

test("a saved user message id correlates a target-matched canonicalized tab", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:user-marker";
  const canonicalUrl = "https://chatgpt.com/c/canonical-user-marker";
  const page = createConversationPage({
    initialUrl: canonicalUrl,
    existingMessages: 2,
    userIds: ["user-existing"],
  });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTargetMatched: true,
    targetId: "target-user-marker",
  });

  await adapter.launch(provisionalUrl, {
    preferredTargetId: "target-user-marker",
  });
  const restoration = await adapter.startConversation(provisionalUrl, {
    expectedUserMessageId: "user-existing",
  });

  assert.equal(restoration.status, "restored-existing");
  assert.equal(restoration.conversationUrl, canonicalUrl);
});

test("a target-matched provisional tab rejects an unrelated canonical chat without its marker", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:original";
  const page = createConversationPage({
    initialUrl: "https://chatgpt.com/c/unrelated",
    existingMessages: 2,
  });
  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    chromePath: process.execPath,
  });
  adapter.launchCdpChrome = async () => ({
    context: {},
    page,
    preferredTargetMatched: true,
    targetId: "target-original",
  });

  await adapter.launch(provisionalUrl, {
    preferredTargetId: "target-original",
  });
  await assert.rejects(
    adapter.startConversation(provisionalUrl),
    (error) => error.code === "CONVERSATION_HISTORY_MISMATCH",
  );
  assert.deepEqual(page.gotoCalls, []);
});

test("a live provisional route may transition to a canonical URL while hydrating", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:hydrating";
  const canonicalUrl = "https://chatgpt.com/c/canonical-after-hydration";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: provisionalUrl,
    existingMessages: 1,
    assistantIds: ["assistant-existing"],
    urlFrames: [provisionalUrl, canonicalUrl],
  });

  const restoration = await adapter.startConversation(provisionalUrl, {
    expectedAssistantMessageId: "assistant-existing",
  });

  assert.deepEqual(restoration, {
    status: "restored-existing",
    conversationUrl: canonicalUrl,
  });
});

test("a provisional tab navigation event cannot bless an unrelated canonical chat", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:original";
  const unrelatedUrl = "https://chatgpt.com/c/unrelated-after-navigation";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: provisionalUrl,
    existingMessages: 2,
    urlFrames: [provisionalUrl, unrelatedUrl],
  });

  await assert.rejects(
    adapter.startConversation(provisionalUrl),
    (error) => error.code === "CONVERSATION_HISTORY_MISMATCH",
  );
  const identity = await adapter.getConversationIdentity();
  assert.notEqual(identity.conversationUrl, unrelatedUrl);
});

test("a transient stale marker cannot bless an unrelated canonical chat", async () => {
  const provisionalUrl = "https://chatgpt.com/c/WEB:stale-dom";
  const unrelatedUrl = "https://chatgpt.com/c/unrelated-after-stale-dom";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: provisionalUrl,
    existingMessages: 2,
    urlFrames: [provisionalUrl, unrelatedUrl, unrelatedUrl],
    messageCountFrames: [2, 2, 2],
    assistantIdFrames: [
      ["assistant-original"],
      ["assistant-original"],
      ["assistant-unrelated"],
    ],
  });

  await assert.rejects(
    adapter.startConversation(provisionalUrl, {
      expectedAssistantMessageId: "assistant-original",
    }),
    (error) => error.code === "CONVERSATION_HISTORY_MISMATCH",
  );
  const identity = await adapter.getConversationIdentity();
  assert.notEqual(identity.conversationUrl, unrelatedUrl);
});

test("accepts a verified empty conversation for a new session", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage();

  await adapter.startConversation();

  assert.equal(await adapter.getConversationUrl(), "https://chatgpt.com/");
});

test("does not verify fresh when delayed history appears after the old settle window", async () => {
  const root = "https://chatgpt.com/";
  const canonical = "https://chatgpt.com/c/delayed-history";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: root,
    existingMessages: 2,
    urlFrames: [root, root, root, root, root, canonical],
    messageCountFrames: [0, 0, 0, 0, 0, 2],
  });

  await assert.rejects(
    adapter.startConversation(),
    (error) => error.code === "CONVERSATION_NOT_FRESH",
  );
});

test("pre-submit candidate must stay empty while existing history hydrates", async () => {
  const fixture = createHydratingCandidatePage();
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  adapter.attachFiles = async (files) => {
    fixture.navigateCandidate();
    return { attached: files, failed: [] };
  };
  await adapter.startConversation();

  await assert.rejects(
    adapter.sendMessage("bootstrap", {
      files: [{ path: "/tmp/input.txt", name: "input.txt" }],
    }),
    (error) => error.code === "CONVERSATION_CHANGED_BEFORE_SEND",
  );

  assert.equal(fixture.submitCount, 0);
  assert.equal(adapter.getLastSendStatus(), "not-submitted");
});

test("fresh bootstrap refuses a conversation opened before submit", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({ existingMessages: 2 });
  await adapter.startConversation();
  await adapter.page.goto("https://chatgpt.com/c/unrelated-before-submit");

  await assert.rejects(
    adapter.sendMessage("bootstrap"),
    (error) => error.code === "CONVERSATION_CHANGED_BEFORE_SEND",
  );
  assert.equal(adapter.getLastSendStatus(), "not-submitted");
});

test("resume treats a saved new-chat URL as a verified fresh conversation", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage();

  await adapter.startConversation("https://chatgpt.com/");

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

  const restoration = await adapter.startConversation(
    "https://chatgpt.com/c/existing",
  );

  assert.deepEqual(restoration, {
    status: "restored-existing",
    conversationUrl: "https://chatgpt.com/c/existing",
  });
  assert.equal(
    await adapter.getConversationUrl(),
    "https://chatgpt.com/c/existing",
  );
});

test("normalizes URL objects before navigating to a canonical conversation", async () => {
  const conversationUrl = new URL("https://chatgpt.com/c/from-url-object");
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({ existingMessages: 2 });

  const restoration = await adapter.startConversation(conversationUrl);

  assert.equal(
    adapter.page.gotoCalls[0],
    "https://chatgpt.com/c/from-url-object",
  );
  assert.equal(restoration.status, "restored-existing");
});

test("an expired canonical URL redirecting to an empty root is verified fresh", async () => {
  const conversationUrl = "https://chatgpt.com/c/deleted";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    redirectUrls: { [conversationUrl]: "https://chatgpt.com/" },
  });

  const restoration = await adapter.startConversation(conversationUrl, {
    expectedAssistantMessageId: "assistant-gone",
  });

  assert.deepEqual(restoration, {
    status: "verified-fresh",
    conversationUrl: "https://chatgpt.com/",
  });
});

test("waits through a delayed redirect before declaring history restored", async () => {
  const conversationUrl = "https://chatgpt.com/c/expired-late";
  const root = "https://chatgpt.com/";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: conversationUrl,
    existingMessages: 2,
    assistantIds: ["assistant-old"],
    urlFrames: [
      conversationUrl,
      conversationUrl,
      conversationUrl,
      conversationUrl,
      conversationUrl,
      root,
    ],
    messageCountFrames: [2, 2, 2, 2, 2, 0],
  });

  const restoration = await adapter.startConversation(conversationUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  assert.deepEqual(restoration, {
    status: "verified-fresh",
    conversationUrl: root,
  });
});

test("resume keeps an already-open conversation in place", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: conversationUrl,
    existingMessages: 2,
    assistantIds: ["assistant-old"],
  });

  await adapter.startConversation(conversationUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  assert.deepEqual(adapter.page.gotoCalls, []);
  assert.equal(await adapter.getConversationUrl(), conversationUrl);
});

test("a restored conversation refuses sends after navigation to another chat", async () => {
  const conversationUrl = "https://chatgpt.com/c/original";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: conversationUrl,
    existingMessages: 2,
  });
  await adapter.startConversation(conversationUrl);
  await adapter.page.goto("https://chatgpt.com/c/unrelated");

  await assert.rejects(
    adapter.sendMessage("tool result"),
    (error) => error.code === "CONVERSATION_CHANGED_BEFORE_SEND",
  );
  const identity = await adapter.getConversationIdentity();
  assert.equal(identity.conversationUrl, conversationUrl);
});

test("never accepts a hydrated old assistant as the current reply", async () => {
  const oldReply = new AssistantMessage(
    "<agent_response><done>true</done><message>old</message></agent_response>",
    { id: "assistant-old", turn: 2 },
  );
  const newReply = new AssistantMessage(
    "<agent_response><done>true</done><message>new</message></agent_response>",
    { id: "assistant-new", turn: 4 },
  );
  let frame = 0;
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(
          frame < 2 ? [oldReply] : [oldReply, newReply],
        );
      }
      if (selector === '[data-testid="stop-button"]') {
        return new VisibleLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      frame += 1;
    },
  };
  // Simulate the production race: the resumed page had no history at the
  // baseline, then the old answer hydrated while the newly sent user message
  // was already conversation turn 3.
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = 3;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });

  assert.match(result, /<message>new<\/message>/);
  assert.doesNotMatch(result, /<message>old<\/message>/);
  assert.equal(await adapter.getLastAssistantMessageId(), "assistant-new");
});

test("same-route sends require their exact outbound marker", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createPostSubmitNavigationPage({
    confirmUserImmediately: true,
    sentText: expected,
  });
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  const sent = await adapter.sendMessage(expected, {
    outboundId: freshSendTestId,
  });
  assert.equal(sent.userMessageId, "user-sent");
  assert.equal(adapter.getLastSendStatus(), "confirmed");
});

test("same-route foreign user bubbles cannot confirm an outbound", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createPostSubmitNavigationPage({
    confirmUserImmediately: true,
    sentText: "a different user message",
  });
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  await assert.rejects(
    adapter.sendMessage(expected, { outboundId: freshSendTestId }),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );
  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
});

test("a mismatched structured outbound marker is rejected before submit", async () => {
  const expected = freshSendTestPayload(freshSendTestId);
  const fixture = createPostSubmitNavigationPage({
    confirmUserImmediately: true,
    sentText: expected,
  });
  const adapter = new ImmediateCorrelationChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  await assert.rejects(
    adapter.sendMessage(expected, { outboundId: oldSendTestId }),
    (error) => error.code === "INVALID_OUTBOUND_CORRELATION_ID",
  );
  assert.equal(adapter.getLastSendStatus(), "not-submitted");
});

test("a post-submit navigation cannot supply the confirming user bubble", async () => {
  const fixture = createPostSubmitNavigationPage({
    autoNavigateAfterSubmit: true,
  });
  const adapter = new VirtualSendClockChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  await assert.rejects(
    adapter.sendMessage("hello"),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );

  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
  const identity = await adapter.getConversationIdentity();
  assert.notEqual(identity.conversationUrl, fixture.unrelatedUrl);
});

test("a canonical candidate cannot bootstrap trust from its own matching user bubble", async () => {
  const fixture = createPostSubmitNavigationPage({
    autoNavigateAfterSubmit: true,
    originalUrl: "https://chatgpt.com/c/WEB:original-send",
    unrelatedUrl: "https://chatgpt.com/c/unrelated-matching-send",
  });
  const adapter = new VirtualSendClockChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  await assert.rejects(
    adapter.sendMessage("hello"),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );

  assert.equal(adapter.getLastSendStatus(), "commit-unknown");
  const identity = await adapter.getConversationIdentity();
  assert.notEqual(identity.conversationUrl, fixture.unrelatedUrl);
});

test("rapid verifier calls cannot shorten the canonical stability window", async () => {
  const fixture = createPostSubmitNavigationPage({
    autoNavigateAfterSubmit: true,
    keepOriginalMarkerOnUnrelated: true,
    originalUrl: "https://chatgpt.com/c/WEB:stale-marker-send",
    unrelatedUrl: "https://chatgpt.com/c/unrelated-stale-marker-send",
  });
  const adapter = new VirtualSendClockChatGPTAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });

  await assert.rejects(
    adapter.sendMessage("hello"),
    (error) => error.code === "SEND_COMMIT_UNKNOWN",
  );

  const identity = await adapter.getConversationIdentity();
  assert.notEqual(identity.conversationUrl, fixture.unrelatedUrl);
});

test("a navigation during generation cannot supply an unrelated assistant reply", async () => {
  const fixture = createPostSubmitNavigationPage({
    confirmUserImmediately: true,
  });
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = fixture.page;
  await adapter.startConversation(fixture.originalUrl, {
    expectedAssistantMessageId: "assistant-old",
  });
  await adapter.sendMessage("hello");
  fixture.navigateDuringNextWait();

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 1_000,
      stableWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "CONVERSATION_CHANGED_DURING_TURN",
  );

  assert.equal(adapter.getLastSendStatus(), "confirmed");
  assert.notEqual(
    await adapter.getLastAssistantMessageId(),
    "assistant-unrelated",
  );
});

for (const mutation of ["frame", "target"]) {
  test(`a confirmed turn rejects ${mutation} substitution before reading a reply`, async () => {
    const fixture = createPostSubmitNavigationPage({
      confirmUserImmediately: true,
    });
    const adapter = new ChatGPTWebAdapter({ profileDir: "." });
    adapter.page = fixture.page;
    adapter.cdpChrome = { targetId: "target-original" };
    await adapter.startConversation(fixture.originalUrl, {
      expectedAssistantMessageId: "assistant-old",
    });
    await adapter.sendMessage("hello");

    if (mutation === "frame") {
      fixture.replaceMainFrame();
    } else {
      adapter.cdpChrome.targetId = "target-substitute";
    }

    await assert.rejects(
      adapter.waitForTurnComplete({
        timeoutMs: 1_000,
        stableWindowMs: 0,
      }),
      (error) => error.code === "CONVERSATION_CHANGED_DURING_TURN",
    );
  });
}

test("restoring a new conversation clears aliases from the previous one", async () => {
  const firstUrl = "https://chatgpt.com/c/first-scope";
  const secondUrl = "https://chatgpt.com/c/second-scope";
  const page = createConversationPage({
    initialUrl: firstUrl,
    existingMessages: 2,
    assistantIds: ["assistant-shared"],
  });
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = page;
  await adapter.startConversation(firstUrl);
  await page.goto(secondUrl);
  await adapter.startConversation(secondUrl);
  await page.goto(firstUrl);

  const identity = await adapter.getConversationIdentity();
  assert.equal(identity.conversationUrl, secondUrl);
});

test("binds a resumed send to its new user and assistant DOM turns", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const oldUser = new AssistantMessage("", { id: "user-old", turn: 1 });
  const oldReply = new AssistantMessage(
    "<agent_response><done>true</done><message>old</message></agent_response>",
    { id: "assistant-old", turn: 2 },
  );
  const newUser = new AssistantMessage("", { id: "user-new", turn: 3 });
  const newReply = new AssistantMessage(
    "<agent_response><done>true</done><message>new</message></agent_response>",
    { id: "assistant-new", turn: 4 },
  );
  let frame = 0;
  let sent = false;
  let sentText = null;
  const gotoCalls = [];
  const composer = new VisibleLocator();
  composer.fill = async (text) => {
    sentText = text;
  };
  const sendButton = new VisibleLocator();
  sendButton.click = async () => {
    sent = true;
  };

  const currentUsers = () => {
    if (!sent || frame < 3) {
      return frame < 2 ? [] : [oldUser];
    }
    return [oldUser, newUser];
  };
  const currentAssistants = () => {
    if (frame < 2) {
      return [];
    }
    return sent && frame >= 6
      ? [oldReply, newReply]
      : [oldReply];
  };

  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    url() {
      return conversationUrl;
    },
    async goto(url) {
      gotoCalls.push(url);
    },
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return composer;
      }
      if (selector === '[data-testid="send-button"]') {
        return sendButton;
      }
      if (selector === '[data-testid="stop-button"]') {
        return sent ? new VisibleLocator() : new EmptyLocator();
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection(currentAssistants());
      }
      if (selector === '[data-message-author-role="user"]') {
        return new MessageCollection(currentUsers());
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return new MessageCollection([
          ...currentUsers(),
          ...currentAssistants(),
        ]);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      frame += 1;
    },
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };

  await adapter.startConversation(conversationUrl, {
    expectedAssistantMessageId: "assistant-old",
  });
  await adapter.sendMessage("诏安");
  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });

  assert.deepEqual(gotoCalls, []);
  assert.equal(sentText, "诏安");
  assert.match(result, /<message>new<\/message>/);
  assert.doesNotMatch(result, /<message>old<\/message>/);
  assert.equal(await adapter.getLastAssistantMessageId(), "assistant-new");
});

test("refuses to send with attachment chips left from an earlier draft", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.pendingAttachmentLocators = () => [new VisibleLocator("old-file.pdf")];
  adapter.page = {
    url() {
      return "https://chatgpt.com/";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return new VisibleLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };
  await adapter.startConversation();

  await assert.rejects(
    adapter.sendMessage("continue"),
    (error) => error.code === "STALE_COMPOSER_ATTACHMENTS",
  );
  assert.equal(adapter.getLastSendStatus(), "not-submitted");
});

test("rejects an oversized outbound message before touching the composer", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {};

  await assert.rejects(
    adapter.sendMessage("中".repeat(100), { maxBytes: 24 }),
    (error) => error.code === "OUTBOUND_MESSAGE_TOO_LARGE",
  );
});

test("fails closed when the DOM exposes no post-send message identity", async () => {
  const unidentified = new AssistantMessage(
    "<agent_response><done>true</done><message>old</message></agent_response>",
    { id: null, turn: null },
  );
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: unidentified,
    visibleSelectors: ['[data-testid="stop-button"]'],
  });
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = null;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 5,
      stableWindowMs: 0,
      staleStopWindowMs: 0,
    }),
    /turn did not complete/,
  );
});

test("detects a new stopped assistant turn whose body stays empty", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: new AssistantMessage("", {
      id: "assistant-empty",
      turn: 4,
    }),
  });
  adapter.sentUserTurn = 3;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 100,
      stableWindowMs: 0,
      emptyResponseWindowMs: 0,
    }),
    (error) => {
      assert.equal(error.code, "EMPTY_ASSISTANT_RESPONSE");
      assert.equal(error.details.assistantMessageId, "assistant-empty");
      return true;
    },
  );
  assert.equal(await adapter.getLastAssistantMessageId(), "assistant-empty");
});

test("does not classify an empty assistant node as finished while Stop is visible", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: new AssistantMessage("", {
      id: "assistant-generating",
      turn: 4,
    }),
    visibleSelectors: ['[data-testid="stop-button"]'],
  });
  adapter.sentUserTurn = 3;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 5,
      stableWindowMs: 0,
      emptyResponseWindowMs: 0,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("fails fast when ChatGPT never starts generating after the message was sent", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator() {
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 5_000,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => {
      assert.equal(error.code, "DEAD_ASSISTANT_REQUEST");
      return true;
    },
  );
});

test("a visible stop button proves generation started and disables dead-request detection", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set(["assistant-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new AssistantCollection(
          new AssistantMessage("", { id: "assistant-old", turn: 1 }),
        );
      }
      if (selector === '[data-testid="stop-button"]') {
        return new VisibleLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };

  // Generation is alive (stop button visible), so the wait must not be cut
  // short by dead-request detection — it ends in a plain TURN_TIMEOUT.
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 50,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});


test("ESC during processing cancels the turn, clicks stop, and restores the terminal", async () => {
  const stdinStream = new PassThrough();
  stdinStream.isTTY = true;
  stdinStream.isRaw = false;
  stdinStream.setRawMode = (enabled) => {
    stdinStream.isRaw = Boolean(enabled);
  };

  let stopClicks = 0;
  const stopButton = new VisibleLocator();
  stopButton.click = async () => {
    stopClicks += 1;
  };

  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    cancelOnEsc: true,
    stdinStream,
  });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set(["assistant-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new AssistantCollection(
          new AssistantMessage("", { id: "assistant-old", turn: 1 }),
        );
      }
      if (selector === '[data-testid="stop-button"]') {
        return stopButton;
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    // Yield to macrotasks so the test's own timer (the ESC keypress) can fire
    // while the wait loop spins.
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };

  const waiting = adapter.waitForTurnComplete({
    timeoutMs: 5_000,
    stableWindowMs: 0,
    deadRequestGraceMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdinStream.emit("keypress", "\u001b", {
    name: "escape",
    ctrl: false,
    meta: false,
    shift: false,
  });

  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, "TURN_CANCELLED");
    return true;
  });
  assert.equal(stopClicks, 1);
  assert.equal(stdinStream.isRaw, false);
  // The detach must pause stdin: readline's internal 'data' listener would
  // otherwise keep the TTY read active and pin the event loop open.
  assert.equal(stdinStream.isPaused(), true);
  // The cancel is consumed, so a later turn starts clean.
  assert.equal(adapter.escCancelRequested, false);
});

test("a cancel requested before the wait cancels the turn immediately", async () => {
  const stdinStream = new PassThrough();
  stdinStream.isTTY = true;
  stdinStream.isRaw = false;
  stdinStream.setRawMode = (enabled) => {
    stdinStream.isRaw = Boolean(enabled);
  };

  const adapter = new ChatGPTWebAdapter({
    profileDir: ".",
    cancelOnEsc: true,
    stdinStream,
  });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set(["assistant-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator() {
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };
  // Ctrl+C pressed while a tool was running: the CLI's SIGINT handler set the
  // flag before waitForTurnComplete attached. It must not be reset away.
  adapter.escCancelRequested = true;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 5_000,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "TURN_CANCELLED",
  );
  assert.equal(adapter.escCancelRequested, false);
  assert.equal(stdinStream.isPaused(), true);
  assert.equal(stdinStream.isRaw, false);
});

test("manual login wait aborts on a pending cancel request", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    locator() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };
  adapter.escCancelRequested = true;

  await assert.rejects(
    adapter.waitForManualLogin({ timeoutMs: 60_000 }),
    (error) => error.code === "TURN_CANCELLED",
  );
});

test("ESC cancellation is disabled unless cancelOnEsc is set", async () => {
  const stdinStream = new PassThrough();
  stdinStream.isTTY = true;
  let rawModeChanges = 0;
  stdinStream.setRawMode = () => {
    rawModeChanges += 1;
  };

  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set(["assistant-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new AssistantCollection(
          new AssistantMessage("", { id: "assistant-old", turn: 1 }),
        );
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };

  // Without cancelOnEsc the adapter never touches stdin; the wait ends in a
  // plain TURN_TIMEOUT (the mock page stays generation-less and stop-free).
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 50,
      stableWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
  assert.equal(rawModeChanges, 0);
});


test("detach drops the transport without quitting Chrome", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  let detaches = 0;
  adapter.cdpChrome = {
    detach: async () => {
      detaches += 1;
    },
    close: async () => {
      throw new Error("close should not be used when keeping the browser");
    },
  };
  adapter.context = {};
  adapter.page = {};

  await adapter.detach();

  assert.equal(detaches, 1);
  assert.equal(adapter.cdpChrome, null);
  assert.equal(adapter.context, null);
  assert.equal(adapter.page, null);
});

test("reconnect detaches the old lock and transport before relaunching", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  let detaches = 0;
  adapter.cdpChrome = {
    detach: async () => {
      detaches += 1;
    },
  };
  let launches = 0;
  adapter.launch = async () => {
    assert.equal(detaches, 1);
    launches += 1;
  };

  await adapter.reconnect();

  assert.equal(detaches, 1);
  assert.equal(launches, 1);
  assert.equal(adapter.cdpChrome, null);
  assert.equal(adapter.context, null);
  assert.equal(adapter.page, null);
});

test("reconnect acquires a fresh real profile lock and releases it on failure", async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-reconnect-"));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const url = "https://chatgpt.com/c/reconnect";
  const page = {
    url: () => url,
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {}, off() {},
  };
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "reconnect-target" } }),
      detach: async () => {},
    }),
  };
  let failConnect = false;
  const adapter = new ChatGPTWebAdapter({ profileDir, chromePath: process.execPath });
  adapter.launchCdpChrome = (options) => launchAndConnectCdpChrome(options, {
    discoverReusable: async () => ({ pid: process.pid, endpoint: "http://127.0.0.1:9999", profileDir }),
    ensurePageTarget: async () => false,
    connectOverCDP: async () => {
      if (failConnect) throw new Error("connection unavailable");
      return { contexts: () => [context], close: async () => {} };
    },
    spawnChrome: () => { throw new Error("must not launch Chrome"); },
    killTree: () => { throw new Error("must not kill Chrome"); },
  });
  t.after(() => adapter.detach());
  const lockFile = path.join(profileDir, ".wtagent-session.lock");
  const readLock = async () => JSON.parse(await fs.readFile(lockFile, "utf8"));
  await adapter.launch(url);
  const oldConnection = adapter.cdpChrome;
  const first = await readLock();
  await adapter.reconnect(url);
  const second = await readLock();
  assert.equal(second.pid, process.pid);
  assert.notEqual(first.token, second.token);
  assert.equal(adapter.page, page);
  // A late cleanup of the old connection must not release the new lock.
  await oldConnection.detach();
  assert.equal((await readLock()).token, second.token);
  failConnect = true;
  await assert.rejects(adapter.reconnect(url), /connection unavailable/);
  await assert.rejects(fs.stat(lockFile), { code: "ENOENT" });
});

test("raw-mode Ctrl+C dispatches the interrupt handler and restores stdin without killing", async (t) => {
  const stdinStream = new PassThrough();
  stdinStream.isTTY = true;
  stdinStream.isRaw = false;
  stdinStream.setRawMode = (raw) => { stdinStream.isRaw = raw; };
  const adapter = new ChatGPTWebAdapter({ profileDir: ".", cancelOnEsc: true, stdinStream });
  adapter.page = {
    title: async () => "ChatGPT",
    locator: () => new EmptyLocator(),
    getByRole: () => new EmptyLocator(),
    waitForTimeout: async () => {},
  };
  let interrupted = false;
  const handler = () => { interrupted = true; adapter.escCancelRequested = true; };
  process.on("SIGINT", handler);
  t.after(() => process.removeListener("SIGINT", handler));
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not terminate"); });
  const waiting = adapter.waitForTurnComplete({ timeoutMs: 1000, stableWindowMs: 0 });
  stdinStream.emit("keypress", "\u0003", { name: "c", ctrl: true });
  await assert.rejects(waiting, { code: "TURN_CANCELLED" });
  assert.equal(interrupted, true);
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(stdinStream.isRaw, false);
  assert.equal(stdinStream.isPaused(), true);
});

test("classifies dead-transport Playwright errors as reconnects", () => {
  assert.equal(
    isConnectionLostError(
      new Error("Target page, context or browser has been closed"),
    ),
    true,
  );
  assert.equal(isConnectionLostError(new Error("Connection closed")), true);
  assert.equal(isConnectionLostError(new Error("Connection is closed")), true);
  assert.equal(
    isConnectionLostError(new Error("Timeout waiting for the composer")),
    false,
  );
  assert.equal(
    isConnectionLostError(new Error("Login was not detected")),
    false,
  );
});


test("a generation signal that went quiet still counts as a dead request", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.sentUserTurn = 10;
  adapter.assistantIdsBeforeSend = new Set(["assistant-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  const start = Date.now();
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new AssistantCollection(
          new AssistantMessage("", { id: "assistant-old", turn: 1 }),
        );
      }
      if (selector === '[data-testid="stop-button"]') {
        // Stop button visible for the first 50ms, then gone forever: a
        // generation attempt that started and died mid-flight.
        return Date.now() - start < 50
          ? new VisibleLocator()
          : new EmptyLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 3_000,
      stableWindowMs: 0,
      deadRequestGraceMs: 200,
    }),
    (error) => error.code === "DEAD_ASSISTANT_REQUEST",
  );
});


class LimitErrorCardMessage extends AssistantMessage {
  constructor(text) {
    super(text);
  }

  locator(selector) {
    if (selector === 'button[data-testid="regenerate-thread-error-button"]') {
      return new VisibleLocator();
    }
    return super.locator(selector);
  }
}

test("rejects a usage-limit error card instead of returning its text", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistant: new LimitErrorCardMessage("你已达到限额。请稍后重试。"),
  });

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 1_000,
      stableWindowMs: 0,
    }),
    (error) => {
      assert.equal(error.code, "USAGE_LIMIT_REACHED");
      return true;
    },
  );
});

test("a protocol reply mentioning a limit is accepted without error-card DOM", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createPage({
    assistantText:
      "<agent_response><done>true</done><message>We reached your usage limit earlier; here is the result anyway.</message></agent_response>",
  });

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 1_000,
    stableWindowMs: 0,
  });

  assert.match(result, /We reached your usage limit earlier/);
});


test("resume tolerates a deleted resume marker when the conversation is verified", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: conversationUrl,
    existingMessages: 4,
    assistantIds: ["assistant-1"],
  });

  // The expected marker was deleted by ChatGPT (e.g. a transient limit card).
  // The URL plus a stable, non-empty history still verify the conversation.
  await adapter.startConversation(conversationUrl, {
    expectedAssistantMessageId: "assistant-gone",
  });

  assert.equal(await adapter.getConversationUrl(), conversationUrl);
});

test("resume still rejects an empty conversation even with a missing marker", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: conversationUrl,
    existingMessages: 0,
    assistantIds: ["assistant-1"],
  });

  await assert.rejects(
    adapter.startConversation(conversationUrl, {
      expectedAssistantMessageId: "assistant-gone",
    }),
    /could not be verified/,
  );
});

test("resume rejects a matching assistant marker on the wrong conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    async goto() {},
    url() {
      return "https://chatgpt.com/c/other";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return new VisibleLocator();
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection([
          new AssistantMessage("", { id: "assistant-expected", turn: 2 }),
        ]);
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return new MessageCollection([new AssistantMessage("")]);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };

  await assert.rejects(
    adapter.startConversation(conversationUrl, {
      expectedAssistantMessageId: "assistant-expected",
    }),
    /could not be verified/,
  );
});

test("resume rejects stable history on the wrong conversation without a marker", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = createConversationPage({
    initialUrl: "https://chatgpt.com/c/other",
    existingMessages: 2,
  });
  adapter.page.goto = async () => {};

  await assert.rejects(
    adapter.startConversation(conversationUrl),
    /could not be verified/,
  );
});

test("resume rejects when the page left the expected conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing";
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = {
    async goto() {},
    url() {
      return "https://chatgpt.com/c/other";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return new VisibleLocator();
      }
      if (selector.includes('[data-message-author-role="assistant"]') && !selector.includes('[data-message-author-role="user"]')) {
        return new MessageCollection([
          new AssistantMessage("", { id: "assistant-1", turn: 2 }),
        ]);
      }
      if (
        selector
        === '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ) {
        return {
          async count() {
            return 4;
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

  await assert.rejects(
    adapter.startConversation(conversationUrl, {
      expectedAssistantMessageId: "assistant-gone",
    }),
    /could not be verified/,
  );
});


test("fails closed when ChatGPT cannot confirm the submitted message", async () => {
  const adapter = new VirtualSendClockChatGPTAdapter({ profileDir: "." });
  adapter.page = {
    url() {
      return "https://chatgpt.com/";
    },
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (selector === "#prompt-textarea") {
        return new VisibleLocator();
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async evaluate() {
      return {
        url: "https://chatgpt.com/",
        entries: [],
      };
    },
    async waitForTimeout() {},
    async waitForURL() {},
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };
  await adapter.startConversation();

  await assert.rejects(
    adapter.sendMessage("hello"),
    (error) => {
      assert.equal(error.code, "SEND_COMMIT_UNKNOWN");
      return true;
    },
  );
});

// A provider whose structural completion signal is trustworthy (Kimi/GLM/
// DeepSeek-style action bar): truncated-envelope recovery is enabled.
class ReliableSignalAdapter extends ChatGPTWebAdapter {
  hasReliableCompletionSignal() {
    return true;
  }
}

test("accepts a truncated protocol reply once generation has finished", async () => {
  const adapter = new ReliableSignalAdapter({ profileDir: "." });
  // The reply started a protocol envelope but the generation ended without the
  // closing tag (truncated, not streaming). With a reliable completion signal
  // the wait must hand the text back after the truncated-envelope window so
  // the runtime can nudge the model instead of waiting out the full timeout.
  adapter.page = createPage({
    assistantText:
      "<agent_response>\n  <done>false</done>\n  <tool_call name=\"fs.edit\">\n"
      + "    <args>\n      <content>partial swift code",
  });
  adapter.assistantIdsBeforeSend = new Set();

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 5_000,
    stableWindowMs: 0,
    truncatedEnvelopeWindowMs: 50,
    deadRequestGraceMs: 0,
  });

  assert.match(result, /<agent_response>/);
  assert.doesNotMatch(result, /<\/agent_response>/);
});

test("ChatGPT's stop-button signal gives it the short truncated-envelope grace", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  // The redesigned UI still exposes the stop button only while generating
  // (verified live, persistent through multi-minute pauses), so ChatGPT uses
  // the short grace. Within a short overall wait only the timeout ends the
  // turn (the 10s grace is not reached).
  adapter.page = createPage({
    assistantText: "<agent_response>\n  <done>false</done>\n  <tool_call",
  });
  adapter.assistantIdsBeforeSend = new Set();

  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(adapter.truncatedEnvelopeGraceMs(), 10_000);
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 60,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );

  // An explicit truncatedEnvelopeWindowMs still overrides the grace for tests
  // and future callers.
  adapter.page = createPage({
    assistantText: "<agent_response>\n  <done>false</done>\n  <tool_call",
  });
  const result = await adapter.waitForTurnComplete({
    timeoutMs: 5_000,
    stableWindowMs: 0,
    truncatedEnvelopeWindowMs: 50,
    deadRequestGraceMs: 0,
  });
  assert.match(result, /<agent_response>/);
});

test("a truncated envelope with the stop button still visible keeps waiting", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  // Generation is still running (stop button visible): the incomplete envelope
  // must NOT be accepted early, only the overall timeout may end the wait.
  adapter.page = createPage({
    assistantText: "<agent_response>\n  <done>false</done>\n  <tool_call",
    visibleSelectors: ['[data-testid="stop-button"]'],
  });
  adapter.assistantIdsBeforeSend = new Set();

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 60,
      stableWindowMs: 0,
      truncatedEnvelopeWindowMs: 0,
      staleStopWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("assistantMessages excludes ChatGPT request placeholders and error stubs", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  const real = new AssistantMessage(
    "<agent_response><done>true</done><message>ok</message></agent_response>",
    { id: "real-1" },
  );
  const placeholder = new AssistantMessage("错误 d: 60758", {
    id: "request-placeholder-request-x-31",
  });
  adapter.page = {
    async title() {
      return "ChatGPT";
    },
    locator(selector) {
      if (
        selector.includes('[data-message-author-role="assistant"]')
        && !selector.includes("user")
      ) {
        // Real ChatGPT semantics: the :not() excludes placeholder stubs.
        const rows = selector.includes("request-placeholder")
          ? [real]
          : [real, placeholder];
        return new MessageCollection(rows);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
    async waitForTimeout() {},
  };
  adapter.assistantIdsBeforeSend = new Set();
  adapter.sentUserTurn = 1;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 1_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });

  // The error stub was skipped; the real reply is what completes the turn.
  assert.match(result, /<message>ok<\/message>/);
  assert.doesNotMatch(result, /错误/);
});

test("ChatGPT accepts same-ID continuation only after causal generation", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.assistantIdsBeforeSend = new Set(["archer-old"]);
  adapter.lastAssistantTextBeforeSend = "partial reply";
  adapter.sentUserTurn = 3;
  adapter.allowInPlaceAssistantContinuation = true;

  // Collapse/action text can mutate on an idle old reply. Without a generation
  // signal that presentation change is not causal evidence for the new send.
  assert.equal(
    adapter.isNewAssistantIdentity({
      id: "archer-old",
      turn: null,
      text: "partial reply\n展开",
    }),
    false,
  );

  // ChatGPT can rewrite the previous message in place after a protocol nudge.
  // Once the structural generating signal was observed, that changed same-ID
  // body is eligible and the normal stopped/stable checks still gate completion.
  adapter.inPlaceAssistantGenerationObserved = true;
  assert.equal(
    adapter.isNewAssistantIdentity({
      id: "archer-old",
      turn: null,
      text: "partial reply with the completion",
    }),
    true,
  );
  assert.equal(
    adapter.isNewAssistantIdentity({ id: "archer-old", turn: null, text: "partial reply" }),
    false,
  );
  assert.equal(
    adapter.isNewAssistantIdentity({ id: "archer-new", turn: null, text: "hi" }),
    true,
  );
});

test("ChatGPT generation-failure cards never become a final plain answer", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  // ChatGPT renders server-side generation failures as an error card
  // ("Internal Server Error" + 重试 button), not a real answer.
  const message = new AssistantMessage("Internal Server Error\n\n重试");
  message.getByRole = () => new VisibleLocator("重试");
  adapter.page = createPage({ assistant: message });
  adapter.assistantIdsBeforeSend = new Set();

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 2_000,
      stableWindowMs: 0,
      deadRequestGraceMs: 0,
    }),
    (error) => error.code === "GENERATION_FAILED",
  );
});
