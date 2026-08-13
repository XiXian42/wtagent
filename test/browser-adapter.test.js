import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ChatGPTWebAdapter, isConnectionLostError } from "../src/browser/chatgpt-web-adapter.js";

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
      if (selector === '[data-message-author-role="assistant"]') {
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
} = {}) {
  let currentUrl = initialUrl;
  let messageCount = existingMessages;
  const gotoCalls = [];
  const composer = new VisibleLocator();
  const assistants = assistantIds.map((id, index) => new AssistantMessage(
    "",
    { id, turn: (index + 1) * 2 },
  ));

  return {
    async goto(url) {
      gotoCalls.push(url);
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
      if (selector === '[data-message-author-role="assistant"]') {
        return new MessageCollection(assistants);
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
    gotoCalls,
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
      if (selector === '[data-message-author-role="assistant"]') {
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
      if (selector === '[data-message-author-role="assistant"]') {
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
      if (selector === '[data-message-author-role="assistant"]') {
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
      if (selector === '[data-message-author-role="assistant"]') {
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
      if (selector === '[data-message-author-role="assistant"]') {
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


test("reconnect drops the dead transport and relaunches", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  let disconnects = 0;
  adapter.cdpChrome = {
    disconnect: async () => {
      disconnects += 1;
    },
  };
  let launches = 0;
  adapter.launch = async () => {
    launches += 1;
  };

  await adapter.reconnect();

  assert.equal(disconnects, 1);
  assert.equal(launches, 1);
  assert.equal(adapter.cdpChrome, null);
  assert.equal(adapter.context, null);
  assert.equal(adapter.page, null);
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
      if (selector === '[data-message-author-role="assistant"]') {
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
      if (selector === '[data-message-author-role="assistant"]') {
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


test("fails loudly when ChatGPT never renders the sent message", async () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
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
    async waitForTimeout() {},
    async waitForURL() {},
    keyboard: {
      async press() {},
      async insertText() {},
    },
  };

  await assert.rejects(
    adapter.sendMessage("hello"),
    (error) => {
      assert.equal(error.code, "SEND_NOT_DETECTED");
      return true;
    },
  );
});
