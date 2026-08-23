import test from "node:test";
import assert from "node:assert/strict";
import { KimiWebAdapter } from "../src/browser/kimi-web-adapter.js";
import { isConnectionLostError } from "../src/browser/kimi-web-adapter.js";

// Minimal Playwright-locator doubles, mirroring test/deepseek-adapter.test.js.
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

// One Kimi message row: a stable data-archer-id UUID + role container class.
class KimiRow extends EmptyLocator {
  constructor({
    id,
    role,
    text,
    answerTexts = null,
    nativeTool = false,
    nativeToolRunning = false,
    nativeToolTitle = null,
    // Kimi shows the .segment-assistant-actions bar only once a reply has
    // fully finished; rows default to the finished state.
    generating = false,
  }) {
    super();
    this.id = id;
    this.role = role;
    this.text = text;
    this.answerTexts = answerTexts;
    this.nativeTool = nativeTool;
    this.nativeToolRunning = nativeToolRunning;
    this.nativeToolTitle = nativeToolTitle;
    this.generating = generating;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    return name === "data-archer-id" ? this.id : null;
  }

  locator(selector) {
    if (this.role === "assistant" && /markdown/.test(selector)) {
      const texts = this.answerTexts ?? (this.text ? [this.text] : []);
      return {
        async count() { return texts.length; },
        last() { return { async innerText() { return texts.at(-1) ?? ""; } }; },
        nth(index) { return { async innerText() { return texts[index] ?? ""; } }; },
      };
    }
    if (selector === ".segment-assistant-actions") {
      const generating = this.generating;
      return {
        async count() { return generating ? 0 : 1; },
      };
    }
    if (/toolcall/.test(selector)) {
      if (!this.nativeTool && !this.nativeToolRunning) {
        return new EmptyLocator();
      }
      const title = this.nativeToolTitle
        ?? (this.nativeToolRunning ? "阅读文件" : "文件阅读失败");
      return {
        async count() { return 1; },
        first() { return { async innerText() { return title; } }; },
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

function createKimiPage(rows) {
  const assistant = rows.filter((r) => r.role === "assistant");
  const user = rows.filter((r) => r.role === "user");
  return {
    async title() { return "Kimi"; },
    locator(selector) {
      if (selector === ".chat-content-item-assistant") return new RowCollection(assistant);
      if (selector === ".chat-content-item-user") return new RowCollection(user);
      if (selector === ".chat-content-item") return new RowCollection(rows);
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

test("exposes Kimi's base URL and conversation URL pattern", () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Kimi");
  assert.equal(adapter.baseUrl, "https://www.kimi.com/");
  assert.ok(adapter.conversationUrlPattern().test("/chat/1a00f5ca-uuid"));
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("reads a stable per-message id from data-archer-id", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const row = new KimiRow({ id: "archer-123", role: "assistant", text: "hi" });
  assert.deepEqual(await adapter.messageIdentity(row), { id: "archer-123", turn: null });
});

test("reads assistant answer text (used to detect the protocol envelope)", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const row = new KimiRow({
    id: "archer-9",
    role: "assistant",
    text: "<agent_response><done>true</done><message>done</message></agent_response>",
  });
  const text = await adapter.assistantText(row);
  assert.match(text, /<agent_response>/);
});

test("does not duplicate nested markdown-container and markdown nodes", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const envelope = "<agent_response><done>false</done><message>list</message>"
    + "<tool_call name=\"fs.list\"><args><path>.</path></args></tool_call></agent_response>";
  const row = new KimiRow({
    id: "archer-dup",
    role: "assistant",
    text: `xml\n复制\n${envelope}\nxml\n复制\n${envelope}`,
    answerTexts: [envelope, envelope],
  });
  const text = await adapter.assistantText(row);
  assert.equal(text.match(/<agent_response/g)?.length, 1);
});

test("prefers a later protocol envelope over a native-tool failure card", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const row = new KimiRow({
    id: "archer-fail-then-xml",
    role: "assistant",
    nativeTool: true,
    text: "思考已完成\n文件阅读失败\n<xml envelope>",
    answerTexts: [
      "文件阅读失败",
      "<agent_response><done>false</done><message>reading</message>"
        + "<tool_call name=\"fs.read\"><args><path>a.swift</path></args></tool_call>"
        + "</agent_response>",
    ],
  });
  const text = await adapter.assistantText(row);
  assert.match(text, /<agent_response>/);
  assert.match(text, /fs.read/);
});

test("waits longer after a native-tool failure until XML may still arrive", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const failed = new KimiRow({
    id: "archer-fail",
    role: "assistant",
    nativeTool: true,
    text: "文件阅读失败",
    answerTexts: ["文件阅读失败"],
  });
  assert.equal(await adapter.extraStableWindowMs(failed, "文件阅读失败"), 8_000);

  const ready = new KimiRow({
    id: "archer-ready",
    role: "assistant",
    nativeTool: true,
    text: "<agent_response><done>true</done><message>ok</message></agent_response>",
  });
  assert.equal(
    await adapter.extraStableWindowMs(
      ready,
      "<agent_response><done>true</done><message>ok</message></agent_response>",
    ),
    0,
  );
});

test("treats an in-flight native tool card as still generating", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  const running = new KimiRow({
    id: "archer-run",
    role: "assistant",
    nativeToolRunning: true,
    text: "阅读文件",
  });
  assert.equal(await adapter.isAssistantGenerating(running), true);

  const failed = new KimiRow({
    id: "archer-fail",
    role: "assistant",
    nativeTool: true,
    text: "文件阅读失败",
  });
  assert.equal(await adapter.isAssistantGenerating(failed), false);
});

test("treats a completed web-search card (result count) as finished", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  // A finished Kimi web search shows its result count ("9 个结果") instead of
  // 已完成/失败; it must not keep the turn looking "generating" forever.
  const searched = new KimiRow({
    id: "archer-searched",
    role: "assistant",
    nativeTool: true,
    nativeToolTitle: "搜索网页\nSwift os_unfair_lock_t sharded lock implementation\n9 个结果",
  });
  assert.equal(await adapter.isAssistantGenerating(searched), false);

  const searchedEn = new KimiRow({
    id: "archer-searched-en",
    role: "assistant",
    nativeTool: true,
    nativeToolTitle: "Search the web\nSwift sharded locks\n3 results",
  });
  assert.equal(await adapter.isAssistantGenerating(searchedEn), false);

  // A search without a result count yet is genuinely in flight.
  const searching = new KimiRow({
    id: "archer-searching",
    role: "assistant",
    nativeToolRunning: true,
    nativeToolTitle: "搜索网页\nSwift os_unfair_lock_t sharded lock implementation",
  });
  assert.equal(await adapter.isAssistantGenerating(searching), true);
});

test("treats a reply without the action bar as still generating", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  // Mid-stream: the message is rendering (thinking or text) but Kimi has not
  // shown the .segment-assistant-actions bar yet — the turn must keep waiting
  // even though the visible text paused, or a partial reply is accepted.
  const streaming = new KimiRow({
    id: "archer-streaming",
    role: "assistant",
    generating: true,
    text: "正在思考中\nNow I have the full TreeWalker.swift. Let me read the other files",
  });
  assert.equal(await adapter.isAssistantGenerating(streaming), true);

  // Once the bar appears the same text is a finished reply.
  const finished = new KimiRow({
    id: "archer-finished",
    role: "assistant",
    generating: false,
    text: "正在思考中\nNow I have the full TreeWalker.swift. Let me read the other files",
  });
  assert.equal(await adapter.isAssistantGenerating(finished), false);
});

test("completes a turn using the archer id as the boundary", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  // The old reply's id was seen before the send; the new reply's id was not.
  adapter.page = createKimiPage([
    new KimiRow({ id: "archer-old", role: "assistant", text: "old reply" }),
    new KimiRow({ id: "archer-user", role: "user", text: "the question" }),
    new KimiRow({
      id: "archer-new",
      role: "assistant",
      text: "<agent_response><done>true</done><message>new</message></agent_response>",
    }),
  ]);
  adapter.assistantIdsBeforeSend = new Set(["archer-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = null;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });

  assert.match(result, /<message>new<\/message>/);
  assert.doesNotMatch(result, /old reply/);
  assert.equal(await adapter.getLastAssistantMessageId(), "archer-new");
});

test("does not accept a pre-existing reply as the current turn", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  // Only the old reply exists and its id was already seen before the send.
  adapter.page = createKimiPage([
    new KimiRow({
      id: "archer-old",
      role: "assistant",
      text: "<agent_response><done>true</done><message>old</message></agent_response>",
    }),
  ]);
  adapter.assistantIdsBeforeSend = new Set(["archer-old"]);
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = 1;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 30,
      stableWindowMs: 0,
      staleStopWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("detects Kimi's signed-out shell as unauthenticated text", () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  assert.ok(adapter.authTextPattern().test("手机号快捷登录"));
  assert.ok(adapter.authTextPattern().test("发送验证码"));
  // English locale too.
  assert.ok(adapter.authTextPattern().test("Log in to sync your chat history"));
  assert.equal(adapter.authTextPattern().test("给 Kimi 发送消息"), false);
});

test("widens the dead-request grace (no persistent stop button)", () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  assert.ok(adapter.deadRequestGraceMultiplier() > 1);
});

// --- K3 model selection -------------------------------------------------

class ModelSwitcher {
  constructor(label) { this.label = label; this.clicks = 0; }
  async count() { return 1; }
  first() { return this; }
  async waitFor() {}
  async innerText() { return this.label; }
  async click() { this.clicks += 1; }
}

class ModelItem {
  constructor(page, title) { this.page = page; this.title = title; this.clicks = 0; }
  filter() { return this; } // filtering by /^K3/ resolves to this stub in tests
  first() { return this; }
  async count() { return 1; }
  async waitFor() {}
  async click() {
    this.clicks += 1;
    // Selecting K3 updates the switcher label.
    this.page.switcher.label = "K3 进阶";
  }
}

function createModelPage({ currentLabel = "快速 进阶" } = {}) {
  const switcher = new ModelSwitcher(currentLabel);
  const k3 = new ModelItem(null, "K3");
  const page = {
    switcher, k3,
    async waitForTimeout() {},
    keyboard: { async press() {} },
    locator(selector) {
      if (selector === ".current-model") return switcher;
      if (selector === ".models-container .model-item") return k3;
      return { async count() { return 0; }, first() { return this; }, filter() { return this; } };
    },
  };
  switcher.page = page;
  k3.page = page;
  return page;
}

test("selectMode('k3') switches to K3 from a fresh (快速) conversation", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ currentLabel: "快速 进阶" });

  const result = await adapter.selectMode("k3");

  assert.equal(result.status, "select");
  assert.equal(result.selectedLabel, "K3");
  assert.equal(adapter.page.k3.clicks, 1);
});

test("selectMode('k3') is a no-op when already on K3", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ currentLabel: "K3 进阶" });

  const result = await adapter.selectMode("k3");

  assert.equal(result.status, "already");
  assert.equal(adapter.page.k3.clicks, 0);
});

test("selectMode does not confuse K3 集群 for K3", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ currentLabel: "K3 集群 进阶" });
  // Currently on K3 集群 — not K3, so it must attempt a switch, not report "already".
  const result = await adapter.selectMode("k3");
  assert.notEqual(result.status, "already");
});

test("selectMode ignores non-k3 modes (keeps current)", async () => {
  const adapter = new KimiWebAdapter({ profileDir: "." });
  adapter.page = createModelPage();
  const result = await adapter.selectMode(null);
  assert.equal(result.status, "skipped");
  assert.equal(adapter.page.switcher.clicks, 0);
});
