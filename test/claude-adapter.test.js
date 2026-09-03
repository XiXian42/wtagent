import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeWebAdapter, isConnectionLostError } from "../src/browser/claude-web-adapter.js";

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

class ClaudeRow extends EmptyLocator {
  constructor({ role, text, generating = false }) {
    super();
    this.role = role;
    this.text = text;
    this.generating = generating;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    if (name === "data-testid" && this.role === "user") {
      return "user-message";
    }
    if (name === "data-is-streaming" && this.role === "assistant") {
      return this.generating ? "true" : "false";
    }
    return null;
  }

  locator(selector) {
    if (selector === ".font-claude-response" && this.role === "assistant") {
      const text = this.text;
      return {
        async count() { return 1; },
        last() { return { async innerText() { return text; } }; },
      };
    }
    return new EmptyLocator();
  }
}

class RowCollection extends EmptyLocator {
  constructor(rows) { super(); this.rows = rows; }
  async count() { return this.rows.length; }
  nth(index) { return this.rows[index] ?? new EmptyLocator(); }
  last() { return this.rows.at(-1) ?? new EmptyLocator(); }
}

function createClaudePage(rows) {
  const assistant = rows.filter((row) => row.role === "assistant");
  const user = rows.filter((row) => row.role === "user");
  return {
    async title() { return "Claude"; },
    locator(selector) {
      if (selector === '[data-testid="transcript-row"] [data-is-streaming]') {
        return new RowCollection(assistant);
      }
      if (selector === '[data-testid="user-message"]') {
        return new RowCollection(user);
      }
      if (selector.includes("user-message") && selector.includes("data-is-streaming")) {
        return new RowCollection(rows);
      }
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
    async waitForTimeout() {},
  };
}

test("re-exports the shared connection-lost detector", () => {
  assert.equal(
    isConnectionLostError(new Error("Target page, context or browser has been closed")),
    true,
  );
  assert.equal(isConnectionLostError(new Error("nope")), false);
});

test("exposes Claude's base URL and conversation URL pattern", () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Claude");
  assert.equal(adapter.baseUrl, "https://claude.ai/");
  assert.ok(adapter.conversationUrlPattern().test("/chat/abc-123"));
  assert.equal(adapter.conversationUrlPattern().test("/new"), false);
});

test("uses role-scoped counts as Claude message identities", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  const rows = [
    new ClaudeRow({ role: "user", text: "hello" }),
    new ClaudeRow({ role: "assistant", text: "hi" }),
    new ClaudeRow({ role: "user", text: "again" }),
  ];
  adapter.page = createClaudePage(rows);

  assert.deepEqual(await adapter.messageIdentity(rows[1]), { id: null, turn: 1 });
  assert.deepEqual(await adapter.messageIdentity(rows[2]), { id: null, turn: 2 });
});

test("reads the Claude response body without provider chrome", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  const envelope = "<agent_response><done>true</done><message>done</message></agent_response>";
  const row = new ClaudeRow({ role: "assistant", text: envelope });
  assert.equal(await adapter.assistantText(row), envelope);
});

test("uses data-is-streaming as a structural completion signal", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  const streaming = new ClaudeRow({ role: "assistant", text: "working", generating: true });
  const complete = new ClaudeRow({ role: "assistant", text: "done", generating: false });

  assert.equal(await adapter.isAssistantGenerating(streaming), true);
  assert.equal(await adapter.isAssistantGenerating(complete), false);
  assert.equal(adapter.hasReliableCompletionSignal(), true);
});

test("completes a Claude turn after its streaming attribute becomes false", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  const envelope = "<agent_response><done>true</done><message>claude done</message></agent_response>";
  adapter.page = createClaudePage([
    new ClaudeRow({ role: "user", text: "task" }),
    new ClaudeRow({ role: "assistant", text: envelope, generating: false }),
  ]);
  adapter.assistantCountBeforeSend = 0;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });
  assert.equal(result, envelope);
});

test("does not accept a stale Claude response from before the send", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  adapter.page = createClaudePage([
    new ClaudeRow({ role: "assistant", text: "old answer", generating: false }),
  ]);
  adapter.assistantCountBeforeSend = 1;
  adapter.lastAssistantTextBeforeSend = "old answer";

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 40,
      stableWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("detects Claude's signed-out URL and login shell", () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  assert.ok(adapter.authUrlPattern().test("/login"));
  assert.ok(adapter.authUrlPattern().test("/oauth/callback"));
  assert.ok(adapter.authTextPattern().test("Continue with Google"));
  assert.ok(adapter.authTextPattern().test("Enter your email"));
  assert.equal(adapter.authTextPattern().test("How can I help you today?"), false);
});

test("widens the dead-request grace for Claude's pre-response thinking phase", () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  assert.ok(adapter.deadRequestGraceMultiplier() > 1);
});

test("uploads attachments through Claude's file input", async () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  let uploaded = null;
  const fileInput = {
    first() { return this; },
    async setInputFiles(paths) { uploaded = paths; },
  };
  const attachmentChip = {
    first() { return this; },
    async waitFor() {},
  };
  adapter.page = {
    locator(selector) {
      if (selector === '[data-testid="file-upload"]') return fileInput;
      return attachmentChip;
    },
  };

  const result = await adapter.attachFiles([
    "/tmp/claude-a.txt",
    { path: "/tmp/claude-b.png" },
  ]);

  assert.deepEqual(uploaded, ["/tmp/claude-a.txt", "/tmp/claude-b.png"]);
  assert.deepEqual(result, {
    attached: ["/tmp/claude-a.txt", "/tmp/claude-b.png"],
    failed: [],
  });
});

test("Claude adapter never selects a model automatically", () => {
  const adapter = new ClaudeWebAdapter({ profileDir: "." });
  assert.equal(typeof adapter.selectMode, "undefined");
});
